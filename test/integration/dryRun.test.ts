import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * dry_run shells out to `renovate`; CI does not install it. We point
 * RENOVATE_BIN at tiny fake binaries so the --config-file plumbing for the
 * per-invocation hostRules input is exercised end-to-end through the real
 * stdio + MCP handshake.
 */

let repo: string;
let session: McpSession;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "rmcp-dry-"));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(repo, { recursive: true, force: true });
});

async function makeFakeRenovate(dir: string, name = "fake-renovate.mjs"): Promise<string> {
  const file = path.join(dir, name);
  // The fake dumps its argv and the contents of any --config-file it receives
  // to FAKE_RENOVATE_ARGV_DUMP, then writes an empty report so the tool takes
  // the "hasReport" code path (not the logTail fallback).
  await writeFile(
    file,
    `#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const dumpPath = process.env.FAKE_RENOVATE_ARGV_DUMP;
const configFileArg = args.find(a => a.startsWith('--config-file='));
let configContent = null;
if (configFileArg) {
  const p = configFileArg.slice('--config-file='.length);
  if (existsSync(p)) configContent = readFileSync(p, 'utf8');
}
if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify({ args, configContent }));
}
const reportArg = args.find(a => a.startsWith('--report-path='));
if (reportArg) {
  writeFileSync(reportArg.slice('--report-path='.length), JSON.stringify({ repositories: [] }));
}
process.exit(0);
`,
  );
  await chmod(file, 0o755);
  return file;
}

describe("dry_run hostRules", () => {
  it("writes hostRules to a temp --config-file and cleans it up", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeFakeRenovate(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      FAKE_RENOVATE_ARGV_DUMP: argvDump,
    });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: {
        repoPath: repo,
        hostRules: [{ matchHost: "registry.acme.corp", token: "very-secret-123" }],
      },
    });

    expect(res.result?.isError).toBeFalsy();

    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      configContent: string | null;
    };

    const configArg = dumped.args.find((a) => a.startsWith("--config-file="));
    expect(configArg).toBeDefined();

    expect(JSON.parse(dumped.configContent!)).toEqual({
      hostRules: [{ matchHost: "registry.acme.corp", token: "very-secret-123" }],
    });

    // The temp config file must be gone after the tool returned.
    const tmpConfigPath = configArg!.slice("--config-file=".length);
    await expect(access(tmpConfigPath)).rejects.toBeDefined();
  });

  it("omits --config-file when no hostRules are passed", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeFakeRenovate(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      FAKE_RENOVATE_ARGV_DUMP: argvDump,
    });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo },
    });

    expect(res.result?.isError).toBeFalsy();

    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as { args: string[] };
    expect(dumped.args.some((a) => a.startsWith("--config-file="))).toBe(false);
  });

  it("emits MCP progress notifications when the caller supplies a progressToken", async () => {
    // Fake renovate that writes a Renovate-shaped JSON log line to stdout
    // before exiting so we exercise the log-enrichment path too.
    const fakeBin = path.join(repo, "progress-renovate.mjs");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.stdout.write(JSON.stringify({ level: 30, msg: 'Fetching manifests' }) + '\\n');
const args = process.argv.slice(2);
const reportArg = args.find(a => a.startsWith('--report-path='));
if (reportArg) {
  writeFileSync(reportArg.slice('--report-path='.length), JSON.stringify({ repositories: [] }));
}
process.exit(0);
`,
    );
    await chmod(fakeBin, 0o755);

    session = await startServer({ RENOVATE_BIN: fakeBin });

    const progressToken = "prog-token-xyz";
    // Bypass the helper so we can inject the MCP `_meta.progressToken` hook.
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo },
      _meta: { progressToken },
    });

    expect(res.result?.isError).toBeFalsy();

    const progress = session.notifications.filter(
      (n) => n.method === "notifications/progress",
    );
    expect(progress.length).toBeGreaterThanOrEqual(2);

    for (const n of progress) {
      const params = n.params as { progressToken: string; progress: number; message?: string };
      expect(params.progressToken).toBe(progressToken);
      expect(typeof params.progress).toBe("number");
    }
    // progress must be strictly increasing
    const values = progress.map((n) => (n.params as { progress: number }).progress);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]!);
    }

    const messages = progress.map((n) => (n.params as { message?: string }).message ?? "");
    expect(messages[0]).toMatch(/Starting Renovate dry-run/);
    expect(messages[messages.length - 1]).toMatch(/Dry-run complete/);
  });

  it("sends no progress notifications when no progressToken is provided", async () => {
    const fakeBin = await makeFakeRenovate(repo);
    session = await startServer({ RENOVATE_BIN: fakeBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo },
    });

    expect(res.result?.isError).toBeFalsy();
    const progress = session.notifications.filter(
      (n) => n.method === "notifications/progress",
    );
    expect(progress).toHaveLength(0);
  });

  it("scrubs hostRules secrets from logTail when no report is produced", async () => {
    // Fake renovate that writes the token to stderr AND skips the report so
    // dry_run falls through to the logTail branch — this is the path where a
    // leak would happen.
    const fakeBin = path.join(repo, "leaky-renovate.mjs");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
process.stderr.write("auth error — token=very-secret-123 rejected by registry.acme.corp\\n");
process.exit(1);
`,
    );
    await chmod(fakeBin, 0o755);

    session = await startServer({ RENOVATE_BIN: fakeBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: {
        repoPath: repo,
        hostRules: [{ matchHost: "registry.acme.corp", token: "very-secret-123" }],
      },
    });

    const text = res.result!.content[0]!.text;
    expect(text).not.toContain("very-secret-123");
    expect(text).toContain("[REDACTED]");
  });
});
