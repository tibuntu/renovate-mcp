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
  repo = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
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

  it.skipIf(process.platform === "win32")(
    "pre-creates the report file with mode 0600 so it isn't world-readable while Renovate runs",
    async () => {
      // Fake renovate that stats the pre-created report file *before*
      // writing to it and dumps the observed mode. The whole point of
      // option A from issue #134 is that the file already exists with
      // mode 0o600 by the time Renovate touches it; this captures
      // exactly that observation.
      const modeDump = path.join(repo, "report-mode.json");
      const fakeBin = path.join(repo, "report-mode-renovate.mjs");
      await writeFile(
        fakeBin,
        `#!/usr/bin/env node
import { writeFileSync, statSync } from 'node:fs';
const args = process.argv.slice(2);
const reportArg = args.find(a => a.startsWith('--report-path='));
const reportPath = reportArg ? reportArg.slice('--report-path='.length) : null;
const dumpPath = process.env.FAKE_RENOVATE_REPORT_MODE_DUMP;
if (reportPath && dumpPath) {
  const st = statSync(reportPath);
  writeFileSync(dumpPath, JSON.stringify({ mode: st.mode & 0o777, size: st.size }));
}
if (reportPath) {
  // Overwrite in place — fs.writeFile uses O_WRONLY|O_CREAT|O_TRUNC,
  // which preserves the existing mode bits.
  writeFileSync(reportPath, JSON.stringify({ repositories: [] }));
}
process.exit(0);
`,
      );
      await chmod(fakeBin, 0o755);

      session = await startServer({
        RENOVATE_BIN: fakeBin,
        FAKE_RENOVATE_REPORT_MODE_DUMP: modeDump,
      });

      const res = await session.request<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>("tools/call", {
        name: "dry_run",
        arguments: { repoPath: repo },
      });

      expect(res.result?.isError).toBeFalsy();

      const observed = JSON.parse(await readFile(modeDump, "utf8")) as {
        mode: number;
        size: number;
      };
      // Group + world bits must be clear — file is owner-only.
      expect(observed.mode & 0o077).toBe(0);
      expect(observed.mode & 0o777).toBe(0o600);
      // Sanity-check that the file was empty when Renovate observed it,
      // matching the pre-create-then-overwrite contract.
      expect(observed.size).toBe(0);
    },
  );

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

  it("passes --platform, --endpoint, RENOVATE_TOKEN, and the repo as a positional arg when platform is gitlab", async () => {
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
    // Renovate has no `--repository` flag — the repo is a positional arg.
    expect(dumped.args.some((a) => a.startsWith("--repository="))).toBe(false);
    expect(dumped.args).toContain("devops/gitops");
    expect(dumped.renovateToken).toBe("glpat-very-secret-xyz");
  });

  it("falls back to RENOVATE_PLATFORM from server env when the caller doesn't pass platform", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      RENOVATE_PLATFORM: "gitlab",
      // GITLAB_TOKEN exercises the same env-fallback path the user would hit
      // for a self-hosted GitLab MCP setup that only sets a single token var.
      GITLAB_TOKEN: "glpat-from-env",
      FAKE_RENOVATE_ARGV_DUMP: argvDump,
    });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: {
        repoPath: repo,
        // No `platform` arg — should pick up "gitlab" from the server env.
        repository: "devops/gitops",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      renovateToken: string | null;
    };
    expect(dumped.args).toContain("--platform=gitlab");
    expect(dumped.args).toContain("devops/gitops");
    // GITLAB_TOKEN auto-translates to RENOVATE_TOKEN even when platform was
    // resolved from RENOVATE_PLATFORM env (not just from the input).
    expect(dumped.renovateToken).toBe("glpat-from-env");
  });

  it("ignores unsupported RENOVATE_PLATFORM values from env (falls back to local)", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      RENOVATE_PLATFORM: "bitbucket",
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
    expect(dumped.args).toContain("--platform=local");
  });

  it("explicit platform input wins over RENOVATE_PLATFORM in env", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      RENOVATE_PLATFORM: "gitlab",
      FAKE_RENOVATE_ARGV_DUMP: argvDump,
    });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo, platform: "local" },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as { args: string[] };
    expect(dumped.args).toContain("--platform=local");
  });

  it("forwards --endpoint and RENOVATE_TOKEN even when platform is local (for gitlab>/github> preset resolution)", async () => {
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
        endpoint: "https://gitlab.example.com/api/v4/",
        token: "glpat-secret",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      renovateToken: string | null;
    };
    expect(dumped.args).toContain("--platform=local");
    expect(dumped.args).toContain("--endpoint=https://gitlab.example.com/api/v4/");
    expect(dumped.renovateToken).toBe("glpat-secret");
    // No repository should be passed in local mode even if other inputs are present.
    expect(dumped.args.some((a) => /^[^-]/.test(a) && a.includes("/"))).toBe(false);
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

  it("preflight: errors before spawning when config extends local> presets under platform=local", async () => {
    await writeFile(
      path.join(repo, "renovate.json"),
      JSON.stringify({
        extends: ["local>devops/bots/renovate:renovate.brainbits.json#main"],
      }),
    );
    // Fake that would succeed if invoked, so a passing preflight can't be
    // mistaken for the tool actually calling Renovate.
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({ RENOVATE_BIN: fakeBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo },
    });

    expect(res.result?.isError).toBe(true);
    const text = res.result!.content[0]!.text;
    expect(text).toMatch(/local>/);
    expect(text).toMatch(/platform.*gitlab.*github|gitlab.*github/i);
    expect(text).toMatch(/devops\/bots\/renovate/);
  });

  it("preflight: does NOT error for dryRunMode=extract even when config extends local> under platform=local", async () => {
    // Manifest-only extraction is the user's escape hatch — let it through
    // and let Renovate produce its own error if it can't resolve the preset.
    await writeFile(
      path.join(repo, "renovate.json"),
      JSON.stringify({ extends: ["local>devops/bots/renovate:renovate.brainbits.json#main"] }),
    );
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
      arguments: { repoPath: repo, dryRunMode: "extract" },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as { args: string[] };
    expect(dumped.args).toContain("--dry-run=extract");
  });

  it("preflight: does NOT error when platform is non-local even if config extends local>", async () => {
    await writeFile(
      path.join(repo, "renovate.json"),
      JSON.stringify({ extends: ["local>devops/bots/renovate:renovate.brainbits.json#main"] }),
    );
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
        token: "tok",
        repository: "devops/gitops",
      },
    });

    expect(res.result?.isError).toBeFalsy();
  });

  it("reports ok=false and isError=true when the report contains a validationError even with exitCode=0", async () => {
    // Fake Renovate that writes a report containing a config-validation
    // problem and exits 0 — exactly the failure mode the original feedback
    // flagged (exit 0, empty branches, but the run did nothing useful).
    const fakeBin = path.join(repo, "validation-error-renovate.mjs");
    await writeFile(
      fakeBin,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const reportArg = args.find(a => a.startsWith('--report-path='));
const report = {
  repositories: {
    'local': {
      problems: [
        {
          level: 30,
          message: 'config-validation',
          validationError: 'Preset caused unexpected error (local>devops/bots/renovate)',
        },
      ],
      branches: [],
      packageFiles: {},
    },
  },
};
if (reportArg) {
  writeFileSync(reportArg.slice('--report-path='.length), JSON.stringify(report));
}
process.exit(0);
`,
    );
    await chmod(fakeBin, 0o755);
    session = await startServer({ RENOVATE_BIN: fakeBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo },
    });

    expect(res.result?.isError).toBe(true);
    const body = JSON.parse(res.result!.content[0]!.text) as {
      ok: boolean;
      exitCode: number;
      reportErrors?: unknown[];
    };
    expect(body.ok).toBe(false);
    expect(body.exitCode).toBe(0);
    expect(body.reportErrors).toBeDefined();
    expect(Array.isArray(body.reportErrors)).toBe(true);
    expect(body.reportErrors!.length).toBeGreaterThan(0);
  });

  it("reports ok=true when the report is clean and exit is 0", async () => {
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({ RENOVATE_BIN: fakeBin });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: { repoPath: repo },
    });

    expect(res.result?.isError).toBeFalsy();
    const body = JSON.parse(res.result!.content[0]!.text) as {
      ok: boolean;
      reportErrors?: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.reportErrors).toBeUndefined();
  });

  it("auto-translates GITLAB_TOKEN to RENOVATE_TOKEN when platform=gitlab and no token input", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      GITLAB_TOKEN: "glpat-from-env-abc",
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
        repository: "infrastructure/k8s/our-platform",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      renovateToken: string | null;
    };
    expect(dumped.renovateToken).toBe("glpat-from-env-abc");
    // Nested-group repository path is forwarded as-is.
    expect(dumped.args).toContain("infrastructure/k8s/our-platform");
  });

  it("auto-translates GITHUB_TOKEN to RENOVATE_TOKEN when platform=github and no token input", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      GITHUB_TOKEN: "ghp-from-env-xyz",
      FAKE_RENOVATE_ARGV_DUMP: argvDump,
    });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run",
      arguments: {
        repoPath: repo,
        platform: "github",
        repository: "acme/widgets",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      args: string[];
      renovateToken: string | null;
    };
    expect(dumped.renovateToken).toBe("ghp-from-env-xyz");
  });

  it("prefers RENOVATE_TOKEN env over GITLAB_TOKEN when both are set", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      RENOVATE_TOKEN: "renovate-wins",
      GITLAB_TOKEN: "gitlab-loses",
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
        repository: "devops/gitops",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      renovateToken: string | null;
    };
    expect(dumped.renovateToken).toBe("renovate-wins");
  });

  it("explicit token input wins over GITLAB_TOKEN env", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      GITLAB_TOKEN: "env-token-ignored",
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
        repository: "devops/gitops",
        token: "input-token-wins",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as {
      renovateToken: string | null;
    };
    expect(dumped.renovateToken).toBe("input-token-wins");
  });

  it("does NOT auto-translate GITLAB_TOKEN when platform=local (only matching remote platform triggers fallback)", async () => {
    const argvDump = path.join(repo, "argv.json");
    const fakeBin = await makeArgvEnvDump(repo);
    session = await startServer({
      RENOVATE_BIN: fakeBin,
      GITLAB_TOKEN: "should-not-be-promoted",
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
    // No childEnv override in local mode — RENOVATE_TOKEN stays unset for the child.
    expect(dumped.renovateToken).toBeNull();
  });

  it("preflight: errors before spawning when remote platform is selected and no token can be resolved", async () => {
    // Fake that would succeed if invoked, so a passing preflight can't be
    // mistaken for the tool actually calling Renovate.
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
        repository: "devops/gitops",
        // No token input, no RENOVATE_TOKEN, no GITLAB_TOKEN in env.
      },
    });

    expect(res.result?.isError).toBe(true);
    const text = res.result!.content[0]!.text;
    expect(text).toMatch(/No auth token found/);
    expect(text).toMatch(/RENOVATE_TOKEN/);
    expect(text).toMatch(/GITLAB_TOKEN/);
    expect(text).toMatch(/check_setup/);
    // The fake gets invoked once at startup with `--version` (by check_setup);
    // dry_run must not have run it again with the dry-run flags.
    const dumped = JSON.parse(await readFile(argvDump, "utf8")) as { args: string[] };
    expect(dumped.args.some((a) => a.startsWith("--platform="))).toBe(false);
    expect(dumped.args.some((a) => a.startsWith("--dry-run="))).toBe(false);
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
