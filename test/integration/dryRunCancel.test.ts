import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { fetchStubEnv, repoFileRoute } from "../helpers/fetchStub.js";

/**
 * Cancelling a dry_run call (`notifications/cancelled`) must kill the Renovate
 * process group and leave no temp file behind. The server gets its own TMPDIR
 * so every artifact it creates shows up in `tmp`.
 */

let root: string;
let repo: string;
let tmp: string;
let pidFile: string;
let session: McpSession | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rmcp-dryrun-cancel-")));
  repo = path.join(root, "repo");
  tmp = path.join(root, "tmp");
  pidFile = path.join(root, "pid");
  await mkdir(repo);
  await mkdir(tmp);
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(root, { recursive: true, force: true });
});

async function sleepyRenovate(): Promise<string> {
  const bin = path.join(root, "sleepy-renovate.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
// The startup \`--version\` probe is not a dry run.
if (!process.argv.some((a) => a.startsWith('--report-path='))) process.exit(0);
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Start a dry_run, wait for the fake to be running, then cancel the call. */
async function cancelRunningDryRun(args: Record<string, unknown>): Promise<number> {
  const id = session!.nextRequestId;
  const pending = session!.request("tools/call", { name: "dry_run", arguments: { repoPath: repo, ...args } });
  pending.catch(() => undefined); // a cancelled call may never be answered
  expect(await waitFor(() => readFile(pidFile).then(() => true, () => false), 15_000)).toBe(true);
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(alive(pid)).toBe(true);
  session!.notify("notifications/cancelled", { requestId: id, reason: "test" });
  return pid;
}

describe("dry_run cancellation", () => {
  it("kills the Renovate process and removes temp files when the call is cancelled", async () => {
    session = await startServer({ RENOVATE_BIN: await sleepyRenovate(), TMPDIR: tmp });

    const pid = await cancelRunningDryRun({
      hostRules: [{ matchHost: "registry.acme.corp", token: "secret-123" }],
    });

    expect(await waitFor(() => !alive(pid), 2_000)).toBe(true);
    expect(await waitFor(async () => (await readdir(tmp)).length === 0, 2_000)).toBe(true);
  });

  it("also cleans up the repo copy of a flattened run", async () => {
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: repo });
    await writeFile(path.join(repo, "renovate.json"), JSON.stringify({ extends: ["local>acme/presets"] }));
    git("init", "-q");
    git("remote", "add", "origin", "git@gitlab.example.com:acme/app.git");
    git("add", "-A");
    const api = "https://gitlab.example.com/api/v4";
    session = await startServer({
      RENOVATE_BIN: await sleepyRenovate(),
      TMPDIR: tmp,
      ...fetchStubEnv(
        {
          [`${api}/projects/${encodeURIComponent("acme/presets")}/repository/files/default.json?ref=HEAD`]:
            repoFileRoute({ labels: ["preset"] }),
        },
        path.join(root, "requests.log"),
      ),
    });

    const pid = await cancelRunningDryRun({ dryRunMode: "lookup", endpoint: `${api}/` });

    expect(await waitFor(() => !alive(pid), 2_000)).toBe(true);
    expect(await waitFor(async () => (await readdir(tmp)).length === 0, 2_000)).toBe(true);
  });
});
