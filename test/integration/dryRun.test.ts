import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * dry_run shells out to `renovate`; CI does not install it. We point
 * RENOVATE_BIN at tiny fake binaries so the RENOVATE_CONFIG_FILE plumbing for
 * the per-invocation hostRules input is exercised end-to-end through the real
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
  // The fake dumps its argv, the RENOVATE_CONFIG_FILE env value, and the
  // contents of that file (if any) to FAKE_RENOVATE_ARGV_DUMP, then writes an
  // empty report so the tool takes the "hasReport" code path (not the logTail
  // fallback).
  await writeFile(
    file,
    `#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const dumpPath = process.env.FAKE_RENOVATE_ARGV_DUMP;
const configFileEnv = process.env.RENOVATE_CONFIG_FILE;
let configContent = null;
if (configFileEnv && existsSync(configFileEnv)) {
  configContent = readFileSync(configFileEnv, 'utf8');
}
if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify({ args, configFileEnv, configContent }));
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
  it("writes hostRules to a temp config file, passes it via RENOVATE_CONFIG_FILE, and cleans it up", async () => {
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
      configFileEnv: string | undefined;
      configContent: string | null;
    };

    // --config-file is NOT a real Renovate CLI flag; must go via env var.
    expect(dumped.args.some((a) => a.startsWith("--config-file="))).toBe(false);
    expect(dumped.configFileEnv).toBeDefined();

    expect(JSON.parse(dumped.configContent!)).toEqual({
      hostRules: [{ matchHost: "registry.acme.corp", token: "very-secret-123" }],
    });

    // The temp config file must be gone after the tool returned.
    await expect(access(dumped.configFileEnv!)).rejects.toBeDefined();
  });

  it("omits RENOVATE_CONFIG_FILE when no hostRules are passed", async () => {
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

    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      configFileEnv: string | undefined;
    };
    expect(dumped.args.some((a) => a.startsWith("--config-file="))).toBe(false);
    expect(dumped.configFileEnv).toBeFalsy();
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

describe("dry_run platform/endpoint/token inputs", () => {
  async function makeArgvEnvDump(dir: string): Promise<string> {
    const file = path.join(dir, "dump-renovate.mjs");
    // Also capture RENOVATE_TOKEN + RENOVATE_CONFIG_FILE so tests can assert
    // that platform/token/repository plumbing arrives at the child correctly.
    await writeFile(
      file,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const dumpPath = process.env.FAKE_RENOVATE_ARGV_DUMP;
if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify({
    args,
    renovateToken: process.env.RENOVATE_TOKEN ?? null,
    renovateConfigFile: process.env.RENOVATE_CONFIG_FILE ?? null,
  }));
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

  it("defaults to --platform=local and passes no remote-mode flags", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
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
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      renovateToken: string | null;
    };
    expect(dumped.args).toContain("--platform=local");
    expect(dumped.args.some((a) => a.startsWith("--endpoint="))).toBe(false);
    expect(dumped.args.some((a) => a.startsWith("--repository="))).toBe(false);
    expect(dumped.renovateToken).toBeNull();
  });

  it("passes --platform, --endpoint, --repository and RENOVATE_TOKEN through when platform is gitlab", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
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
        platform: "gitlab",
        endpoint: "https://gitlab.example.com/api/v4/",
        token: "glpat-very-secret-xyz",
        repository: "devops/gitops",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      renovateToken: string | null;
    };
    expect(dumped.args).toContain("--platform=gitlab");
    expect(dumped.args).toContain("--endpoint=https://gitlab.example.com/api/v4/");
    expect(dumped.args).toContain("--repository=devops/gitops");
    expect(dumped.renovateToken).toBe("glpat-very-secret-xyz");
  });

  it("errors when platform is gitlab but repository is missing", async () => {
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({ RENOVATE_BIN: fakeBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: {
        repoPath: repo,
        platform: "gitlab",
        endpoint: "https://gitlab.example.com/api/v4/",
        token: "glpat-xyz",
      },
    });

    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0]!.text).toMatch(/`repository` is required/);
  });

  it("scrubs platform token from stderr logTail", async () => {
    const leakyBin = path.join(repo, "leaky-token.mjs");
    await writeFile(
      leakyBin,
      `#!/usr/bin/env node
process.stderr.write("401 Unauthorized — token=glpat-leaky-987 rejected by gitlab.example.com\\n");
process.exit(1);
`,
    );
    await chmod(leakyBin, 0o755);
    session = await startServer({ RENOVATE_BIN: leakyBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: {
        repoPath: repo,
        platform: "gitlab",
        endpoint: "https://gitlab.example.com/api/v4/",
        token: "glpat-leaky-987",
        repository: "devops/gitops",
      },
    });

    const text = res.result!.content[0]!.text;
    expect(text).not.toContain("glpat-leaky-987");
    expect(text).toContain("[REDACTED]");
  });
});
