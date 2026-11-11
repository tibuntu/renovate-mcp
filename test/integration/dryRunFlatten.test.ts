import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { fetchStubEnv, readFetchLog, repoFileRoute, type StubRoute } from "../helpers/fetchStub.js";

/**
 * dry_run's local-preset flattening (ADR-0009) end to end: the real server
 * child, its real Renovate resolver worker, a fake `renovate` binary, and the
 * HTTPS stub (docs/development.md, "Network stub") standing in for the preset
 * host. Each server gets its own TMPDIR, so every temp artifact a call leaves
 * behind shows up there.
 */

const GITLAB_API = "https://gitlab.example.com/api/v4";
const presetUrl = (project: string, api = GITLAB_API) =>
  `${api}/projects/${encodeURIComponent(project)}/repository/files/default.json?ref=HEAD`;
const githubPresetUrl = (repo: string) => `https://api.github.com/repos/${repo}/contents/default.json`;

let root: string;
let repo: string;
let tmp: string;
let session: McpSession | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rmcp-dryrun-flatten-")));
  repo = path.join(root, "repo");
  tmp = path.join(root, "tmp");
  await mkdir(repo);
  await mkdir(tmp);
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(root, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
}

async function gitRepo(files: Record<string, string>, origin?: string, untracked: Record<string, string> = {}) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), content);
  }
  git("init", "-q");
  if (origin) git("remote", "add", "origin", origin);
  git("add", "-A");
  for (const [rel, content] of Object.entries(untracked)) await writeFile(path.join(repo, rel), content);
}

/**
 * Fake renovate: dumps its cwd, GIT_CEILING_DIRECTORIES and the renovate.json
 * it sees, writes a report naming its cwd, and with FAKE_FAIL prints its cwd
 * to stderr and exits 1.
 */
async function fakeRenovate(): Promise<{ bin: string; dump: string }> {
  const bin = path.join(root, "fake-renovate.mjs");
  const dump = path.join(root, "dump.json");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const reportArg = args.find((a) => a.startsWith('--report-path='));
// The server's startup check runs \`renovate --version\`: not a dry run.
if (!reportArg) process.exit(0);
const cwd = process.cwd();
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
  cwd,
  ceiling: process.env.GIT_CEILING_DIRECTORIES ?? null,
  config: existsSync('renovate.json') ? JSON.parse(readFileSync('renovate.json', 'utf8')) : null,
  hostRules: process.env.RENOVATE_CONFIG_FILE ? JSON.parse(readFileSync(process.env.RENOVATE_CONFIG_FILE, 'utf8')).hostRules : null,
}));
const problems = process.env.FAKE_PROBLEM ? [{ level: 50, validationError: process.env.FAKE_PROBLEM }] : [];
writeFileSync(reportArg.slice('--report-path='.length), JSON.stringify({
  problems,
  repositories: { local: { packageFiles: { npm: [{ packageFile: cwd + '/package.json' }] } } },
}));
if (process.env.FAKE_FAIL) {
  process.stderr.write('failed in ' + cwd + '\\n');
  process.exit(1);
}
process.exit(0);
`,
  );
  await chmod(bin, 0o755);
  return { bin, dump };
}

async function start(env: Record<string, string>, routes: Record<string, StubRoute> = {}) {
  const fake = await fakeRenovate();
  const log = path.join(root, "requests.log");
  session = await startServer({
    RENOVATE_BIN: fake.bin,
    TMPDIR: tmp,
    ...fetchStubEnv(routes, log),
    ...env,
  });
  return { ...fake, log };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function dryRun(args: Record<string, unknown>): Promise<ToolResult> {
  const res = await session!.request<ToolResult>("tools/call", { name: "dry_run", arguments: { repoPath: repo, ...args } });
  return res.result!;
}

const readDump = async (dump: string) =>
  JSON.parse(await readFile(dump, "utf8")) as {
    cwd: string;
    ceiling: string | null;
    config: Record<string, unknown> | null;
    hostRules: Array<Record<string, unknown>> | null;
  };
const spawned = async (dump: string) => readFile(dump).then(() => true, () => false);

const PRESETS = {
  [presetUrl("acme/presets")]: repoFileRoute({ extends: ["local>acme/base"], rangeStrategy: "replace", labels: ["preset"] }),
  [presetUrl("acme/base")]: repoFileRoute({ prHourlyLimit: 3 }),
};
const CONFIG = JSON.stringify({ extends: [":semanticCommits", "local>acme/presets", ":pinVersions"], labels: ["own"] });

describe("dry_run local-preset flattening", () => {
  it("flattens into a temp copy, runs Renovate there, reports repoPath, and removes the copy", async () => {
    await gitRepo({ "renovate.json": CONFIG, "package.json": "{}\n" }, "git@gitlab.example.com:acme/app.git");
    const { dump, log } = await start(
      {
        GITLAB_TOKEN: "glpat-gitlab-com-only",
        RENOVATE_MCP_HOST_TOKENS: JSON.stringify([{ matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME_GL" }]),
        ACME_GL: "glpat-flatten-token",
      },
      PRESETS,
    );

    const result = await dryRun({ dryRunMode: "lookup", endpoint: `${GITLAB_API}/` });

    expect(result.isError).toBeFalsy();
    const summary = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    const seen = await readDump(dump);
    expect(seen.cwd).not.toBe(repo);
    expect(path.basename(seen.cwd)).toMatch(/^renovate-mcp-dryrun-/);
    expect(seen.ceiling).toBe(path.dirname(seen.cwd));
    expect(seen.config).toEqual({
      extends: [":semanticCommits"],
      labels: ["own"],
      rangeStrategy: "pin",
      prHourlyLimit: 3,
      description: expect.any(Array),
    });
    expect(summary.keptExtends).toEqual([":semanticCommits"]);
    expect(summary.flattenedPresets).toEqual(expect.arrayContaining(["local>acme/presets", "local>acme/base", ":pinVersions"]));
    // The report names repoPath, never the copy.
    expect(result.content[0]!.text).not.toContain(seen.cwd);
    expect(summary.report).toMatchObject({
      repositories: { local: { packageFiles: { npm: [{ packageFile: `${repo}/package.json` }] } } },
    });
    expect(summary.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining("`endpoint` was ignored")]));
    // The host-token entry reached the preset host; GITLAB_TOKEN stays on gitlab.com.
    const requests = await readFetchLog(log);
    expect(requests.map((r) => r.url)).toEqual([presetUrl("acme/presets"), presetUrl("acme/base")]);
    expect(requests.every((r) => r.authorization === "Bearer glpat-flatten-token")).toBe(true);
    // The original is untouched and nothing is left in TMPDIR.
    expect(await readFile(path.join(repo, "renovate.json"), "utf8")).toBe(CONFIG);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("replaces the copy's path with repoPath in logTail on a failed run, and still removes the copy", async () => {
    await gitRepo({ "renovate.json": CONFIG }, "git@gitlab.example.com:acme/app.git");
    const { dump } = await start({ FAKE_FAIL: "1" }, PRESETS);

    const result = await dryRun({ endpoint: GITLAB_API });

    expect(result.isError).toBe(true);
    const summary = JSON.parse(result.content[0]!.text) as { logTail: string };
    const { cwd } = await readDump(dump);
    expect(summary.logTail).toBe(`failed in ${repo}`);
    expect(result.content[0]!.text).not.toContain(cwd);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("derives the route from a github.com origin and authenticates with GITHUB_COM_TOKEN like Renovate", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["acme/presets"] }) }, "https://github.com/acme/app.git");
    const { dump, log } = await start({ GITHUB_COM_TOKEN: "ghp-com-token" }, {
      [githubPresetUrl("acme/presets")]: repoFileRoute({ automerge: true }),
    });

    const result = await dryRun({});

    expect(result.isError).toBeFalsy();
    expect((await readDump(dump)).config).toEqual({ automerge: true });
    expect(await readFetchLog(log)).toEqual([
      { url: githubPresetUrl("acme/presets"), method: "GET", authorization: "token ghp-com-token" },
    ]);
  });

  it("hands per-call hostRules to the resolver, replacing the env rule for the same host", async () => {
    await gitRepo({ "renovate.json": CONFIG }, "git@gitlab.example.com:acme/app.git");
    const { log } = await start({ GITLAB_TOKEN: "glpat-env" }, PRESETS);

    const result = await dryRun({
      endpoint: GITLAB_API,
      hostRules: [{ hostType: "gitlab", matchHost: "gitlab.example.com", token: "glpat-per-call" }],
    });

    expect(result.isError).toBeFalsy();
    const requests = await readFetchLog(log);
    expect(requests.length).toBe(2);
    expect(requests.every((r) => r.authorization === "Bearer glpat-per-call")).toBe(true);
  });

  it("flattens with presetPlatform, authenticated by RENOVATE_TOKEN of the matching env home, even without a local preset in the repo config", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["local>acme/base"] }) });
    const { dump, log } = await start(
      { RENOVATE_TOKEN: "rnv-home", RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: GITLAB_API },
      PRESETS,
    );

    // platform: local overrides RENOVATE_PLATFORM for the run; presetPlatform
    // equals it, so RENOVATE_ENDPOINT routes the presets.
    const result = await dryRun({ platform: "local", presetPlatform: "gitlab" });

    expect(result.isError).toBeFalsy();
    expect((await readDump(dump)).config).toEqual({ prHourlyLimit: 3 });
    expect((await readFetchLog(log)).map((r) => r.authorization)).toEqual(["Bearer rnv-home"]);
  });

  it("never binds RENOVATE_TOKEN or GITLAB_TOKEN to a presetPlatform + endpoint route that only the call names", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["local>acme/base"] }) });
    const { dump, log } = await start({ RENOVATE_TOKEN: "rnv-unbound", GITLAB_TOKEN: "glpat-gitlab-com" }, PRESETS);

    const result = await dryRun({ presetPlatform: "gitlab", endpoint: GITLAB_API });

    expect(result.isError).toBeFalsy();
    expect(await readFetchLog(log)).toEqual([{ url: presetUrl("acme/base"), method: "GET", authorization: null }]);
    expect((await readDump(dump)).hostRules).toEqual([{ hostType: "gitlab", matchHost: "gitlab.com", token: "glpat-gitlab-com" }]);
  });

  it("flattens a string extends, which Renovate migrates to a list", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: "local>acme/base" }) }, "git@gitlab.example.com:acme/app.git");
    const { dump } = await start({}, PRESETS);

    const result = await dryRun({ endpoint: GITLAB_API });

    expect(result.isError).toBeFalsy();
    expect((await readDump(dump)).config).toEqual({ prHourlyLimit: 3 });
  });

  it("routes an origin-derived gitlab.com route to gitlab.com, not to a RENOVATE_ENDPOINT on another host", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["local>acme/base"] }) }, "git@gitlab.com:acme/app.git");
    const { dump, log } = await start(
      { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: GITLAB_API, RENOVATE_TOKEN: "rnv-corp" },
      { [presetUrl("acme/base", "https://gitlab.com/api/v4")]: repoFileRoute({ prHourlyLimit: 7 }) },
    );

    const result = await dryRun({ platform: "local" });

    expect(result.isError).toBeFalsy();
    expect((await readDump(dump)).config).toEqual({ prHourlyLimit: 7 });
    expect(await readFetchLog(log)).toEqual([
      { url: presetUrl("acme/base", "https://gitlab.com/api/v4"), method: "GET", authorization: null },
    ]);
  });

  it("never moves the env home's RENOVATE_TOKEN to a route derived from the repo's origin", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["local>acme/presets"] }) }, "https://github.com/acme/app.git");
    const { dump, log } = await start(
      { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: GITLAB_API, RENOVATE_TOKEN: "rnv-corp-gitlab" },
      { [githubPresetUrl("acme/presets")]: repoFileRoute({ automerge: true }) },
    );

    const result = await dryRun({ platform: "local" });

    expect(result.isError).toBeFalsy();
    expect(await readFetchLog(log)).toEqual([{ url: githubPresetUrl("acme/presets"), method: "GET", authorization: null }]);
    // The token stays on its env home; nothing is written for github.com.
    expect((await readDump(dump)).hostRules).toEqual([
      { hostType: "gitlab", matchHost: "gitlab.example.com", token: "rnv-corp-gitlab" },
    ]);
  });

  it("flattens in extract mode too: Renovate resolves presets during repo init in every dry-run mode", async () => {
    await gitRepo({ "renovate.json": CONFIG }, "git@gitlab.example.com:acme/app.git");
    const { dump } = await start({}, PRESETS);

    const result = await dryRun({ dryRunMode: "extract", endpoint: GITLAB_API });

    expect(result.isError).toBeFalsy();
    const seen = await readDump(dump);
    expect(seen.cwd).not.toBe(repo);
    expect(seen.config).toMatchObject({ extends: [":semanticCommits"], prHourlyLimit: 3 });
    expect(await readdir(tmp)).toEqual([]);
  });

  it("lets a per-call hostRule without a hostType win over the env token of its host", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["acme/presets"] }) }, "https://github.com/acme/app.git");
    const { dump, log } = await start({ GITHUB_TOKEN: "ghp-env-no-access" }, {
      [githubPresetUrl("acme/presets")]: repoFileRoute({ automerge: true }),
    });

    const result = await dryRun({ hostRules: [{ matchHost: "github.com", token: "ghp-per-call" }] });

    expect(result.isError).toBeFalsy();
    expect((await readFetchLog(log)).map((r) => r.authorization)).toEqual(["token ghp-per-call"]);
    // The env rule (hostType + matchHost) would outrank the per-call one in Renovate's find().
    expect((await readDump(dump)).hostRules).toEqual([{ matchHost: "github.com", token: "ghp-per-call" }]);
  });

  it("leaves configs without local presets and remote runs in repoPath", async () => {
    await gitRepo({ "renovate.json": CONFIG }, "git@gitlab.example.com:acme/app.git");
    const { dump, log } = await start({ GITLAB_TOKEN: "glpat-x" }, PRESETS);

    const remote = await dryRun({ platform: "gitlab", repository: "acme/app", endpoint: GITLAB_API, token: "glpat-input" });
    expect(remote.isError).toBeFalsy();
    expect((await readDump(dump)).cwd).toBe(repo);

    await writeFile(path.join(repo, "renovate.json"), JSON.stringify({ extends: [":semanticCommits", "github>acme/x"] }));
    const plain = await dryRun({ endpoint: GITLAB_API });
    expect(plain.isError).toBeFalsy();
    expect((await readDump(dump)).cwd).toBe(repo);
    expect(JSON.parse(plain.content[0]!.text)).not.toHaveProperty("flattenedPresets");
    expect(JSON.parse(plain.content[0]!.text).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("`endpoint` was ignored")]),
    );
    expect(await readFetchLog(log)).toEqual([]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses an untracked config with local presets, which Renovate would skip without a word", async () => {
    await gitRepo({ "package.json": "{}\n" }, "git@gitlab.example.com:acme/app.git", { "renovate.json": CONFIG });
    const { dump, log } = await start({}, PRESETS);

    const result = await dryRun({ endpoint: GITLAB_API });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/`renovate\.json` extends local presets but is not tracked by git.*git add renovate\.json/);
    expect(await spawned(dump)).toBe(false);
    expect(await readFetchLog(log)).toEqual([]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("warns when an untracked config shadows the tracked one Renovate reads", async () => {
    await gitRepo({ ".renovaterc": "{}\n" }, "git@gitlab.example.com:acme/app.git", { "renovate.json": CONFIG });
    const { dump } = await start({}, PRESETS);

    const result = await dryRun({ endpoint: GITLAB_API });

    expect(result.isError).toBeFalsy();
    expect((await readDump(dump)).cwd).toBe(repo);
    expect(JSON.parse(result.content[0]!.text).warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/`renovate\.json` is not tracked by git.*reads `\.renovaterc` instead/)]),
    );
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses an unroutable origin before copying the repository", async () => {
    await gitRepo({ "renovate.json": CONFIG, "big.bin": "x" }, "https://git.example.com/acme/app.git");
    // An unreadable tracked file would fail the copy: the route refusal comes first.
    await chmod(path.join(repo, "big.bin"), 0o000);
    await start({}, PRESETS);

    const result = await dryRun({});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/could not be classified/);
  });

  it("hints at presetPlatform when a run fails on a local preset nested in another preset", async () => {
    await gitRepo({ "renovate.json": JSON.stringify({ extends: ["github>acme/x"] }) });
    await start({
      FAKE_PROBLEM:
        "Preset caused unexpected error (local>acme/inner). Note: this is a *nested* preset so please contact the preset author if you are unable to fix it yourself.",
    });

    const result = await dryRun({});

    expect(JSON.parse(result.content[0]!.text).warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/local>acme\/inner.*presetPlatform/)]),
    );
  });

  describe("refusals, before anything is spawned and with every temp file removed", () => {
    it.each([
      ["a self-hosted origin without an endpoint", {}, {}, /self-hosted gitlab.*`endpoint`/],
      ["a preset the host does not have", { endpoint: GITLAB_API }, {}, /Cannot find preset's package \(local>acme\/presets\)/],
      [
        "an env endpoint the validator blocks",
        { platform: "local", presetPlatform: "gitlab" },
        { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "https://10.1.2.3/api/v4" },
        /Invalid endpoint/,
      ],
      [
        "a worker failure, with no preview fallback",
        { endpoint: GITLAB_API },
        { RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY: path.resolve("test/fixtures/exit-one-worker.mjs") },
        /preset flattening worker exited/,
      ],
      [
        "a malformed RENOVATE_MCP_HOST_TOKENS",
        { endpoint: GITLAB_API },
        { RENOVATE_MCP_HOST_TOKENS: "not json" },
        /RENOVATE_MCP_HOST_TOKENS is not valid JSON/,
      ],
    ])("refuses %s", async (_name, args, env, message) => {
      await gitRepo({ "renovate.json": CONFIG }, "git@gitlab.example.com:acme/app.git");
      const { dump } = await start(env as Record<string, string>);

      const result = await dryRun(args);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(message);
      expect(await spawned(dump)).toBe(false);
      expect(await readdir(tmp)).toEqual([]);
      expect(await readFile(path.join(repo, "renovate.json"), "utf8")).toBe(CONFIG);
    });

    it("refuses a presetPlatform outside the schema", async () => {
      await gitRepo({ "renovate.json": CONFIG });
      const { dump } = await start({});
      const res = await session!.request<ToolResult>("tools/call", {
        name: "dry_run",
        arguments: { repoPath: repo, presetPlatform: "azure" },
      });
      expect(res.error ?? res.result?.isError).toBeTruthy();
      expect(await spawned(dump)).toBe(false);
    });
  });
});
