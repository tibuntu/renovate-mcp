import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLogPath, resolveReportInput } from "../../src/lib/reportInput.js";
import { explainDependency } from "../../src/lib/dependencyExplainer.js";
import { resolveBundledBinary } from "../../src/lib/renovateCli.js";
import { BRANCHES, PACKAGE_FILES, REPO, logLine, syntheticLog } from "../helpers/botLog.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), `rmcp-log-${process.pid}-`));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function logOf(content: string): Promise<string> {
  const p = path.join(scratch, "bot.log");
  await writeFile(p, content);
  return p;
}

type Repo = { packageFiles?: unknown; branches: Array<{ upgrades: Array<Record<string, unknown>> }>; problems: unknown[] };
async function load(p: string): Promise<Record<string, Repo>> {
  const res = await readLogPath(p);
  if (!res.ok) throw new Error(res.error);
  return (res.value as { repositories: Record<string, Repo> }).repositories;
}

describe("readLogPath: synthetic bot log", () => {
  it("rebuilds packageFiles and branches, skipping noise and non-JSON lines", async () => {
    const repos = await load(await logOf(syntheticLog()));
    const repo = repos[REPO]!;
    expect(repo.packageFiles).toEqual(PACKAGE_FILES);
    expect(repo.problems).toEqual([]);
    expect(repo.branches).toHaveLength(BRANCHES.length);
    expect(repo.branches.map((b) => (b as Record<string, unknown>).result)).toEqual(
      BRANCHES.map((b) => b.result),
    );
  });

  it("backfills the manager the branch upgrades lack, from the matching extracted dep", async () => {
    const repo = (await load(await logOf(syntheticLog())))[REPO]!;
    expect(BRANCHES[0]!.upgrades[0]).not.toHaveProperty("manager");
    expect(repo.branches.flatMap((b) => b.upgrades.map((u) => u.manager))).toEqual(["npm", "npm", "npm", "npm"]);
  });

  it("accepts a log with only one of the two lines", async () => {
    const onlyBranches = (await load(await logOf(syntheticLog({ packageFiles: false }))))[REPO]!;
    expect(onlyBranches.packageFiles).toBeUndefined();
    expect(onlyBranches.branches).toHaveLength(BRANCHES.length);
    const onlyFiles = (await load(await logOf(syntheticLog({ branches: false }))))[REPO]!;
    expect(onlyFiles.packageFiles).toEqual(PACKAGE_FILES);
    expect(onlyFiles.branches).toEqual([]);
  });

  it("several base branches: the last packageFiles line wins, like Renovate's own report", async () => {
    const first = logLine("packageFiles with updates", { baseBranch: "main", config: { npm: [] } });
    const second = logLine("packageFiles with updates", { baseBranch: "next", config: PACKAGE_FILES });
    const repo = (await load(await logOf(`${first}\n${second}\n`)))[REPO]!;
    expect(repo.packageFiles).toEqual(PACKAGE_FILES);
  });

  it("keeps repositories apart", async () => {
    const a = logLine("packageFiles with updates", { config: { npm: [] } }, "a/a");
    const b = logLine("packageFiles with updates", { config: PACKAGE_FILES }, "b/b");
    const repos = await load(await logOf(`${a}\n${b}\n`));
    expect(Object.keys(repos).sort()).toEqual(["a/a", "b/b"]);
  });

  it("a log with neither line is an error naming both settings", async () => {
    const res = await readLogPath(await logOf(syntheticLog({ packageFiles: false, branches: false })));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/LOG_LEVEL=debug.*LOG_FORMAT=json/);
  });

  it("an unreadable path is an error", async () => {
    const res = await readLogPath(path.join(scratch, "nope.log"));
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/Could not read logPath/);
  });
});

// A trimmed debug log from a real production run (Renovate 44.239.1, platform
// github): the two messages verbatim, poetry section only, repository and
// hostname replaced. Both branches were held by minimumReleaseAge
// ("creation is disabled because internalChecksFilter was not met").
describe("readLogPath: real bot log", () => {
  const fixture = path.join(process.cwd(), "test/fixtures/bot-log-real.jsonl");

  it("reads the real line shape, backfilling the manager on branch upgrades", async () => {
    const repos = await load(fixture);
    expect(Object.keys(repos)).toEqual(["example/repo"]);
    const branches = repos["example/repo"]!.branches as Array<Record<string, unknown>>;
    expect(branches.map((b) => [b.branchName, b.result, b.prNo])).toEqual([
      ["renovate/ruff", "pending", null],
      ["renovate/patch-updates", "pending", null],
    ]);
    for (const b of repos["example/repo"]!.branches) {
      expect(b.upgrades.map((u) => u.manager)).toEqual(["poetry"]);
    }
  });

  it("explain_dependency reports both updates as held: pending", async () => {
    const res = await readLogPath(fixture);
    if (!res.ok) throw new Error(res.error);
    for (const [dep, branch] of [["ruff", "renovate/ruff"], ["zensical", "renovate/patch-updates"]] as const) {
      const e = explainDependency(res.value, { depName: dep });
      expect(e.verdict).toBe("1 update available; held: pending");
      expect(e.hits.flatMap((h) => h.updates ?? [])).toMatchObject([{ branchName: branch, branchResult: "pending" }]);
      expect(e.hints.join("\n")).toMatch(/minimumReleaseAge/);
    }
    expect(explainDependency(res.value, { depName: "mypy" }).verdict).toBe("up to date");
  });
});

describe("resolveReportInput", () => {
  it("rejects every combination of the three inputs", async () => {
    const both = await resolveReportInput({ report: {}, logPath: "/x" });
    expect(both).toEqual({ ok: false, error: "Pass either report or logPath, not both." });
    const all = await resolveReportInput({ report: {}, reportPath: "/x", logPath: "/y" });
    expect(all.ok).toBe(false);
    const none = await resolveReportInput({});
    expect(none).toMatchObject({ ok: false });
  });

  it("follows an inline report that is only dry_run's reportOutputPath pointer", async () => {
    const saved = path.join(scratch, "report.json");
    await writeFile(saved, JSON.stringify({ repositories: { r: {} } }));
    const expected = { ok: true, value: { repositories: { r: {} } }, source: "reportPath" };
    // The collapsed pointer itself, and a full dry_run summary carrying it.
    expect(await resolveReportInput({ report: { reportPath: saved, repoCount: 1, updateCount: 0 } })).toEqual(expected);
    expect(await resolveReportInput({ report: { ok: true, report: { reportPath: saved } } })).toEqual(expected);
  });
});

describe("readLogPath: memory", () => {
  it("parses a 200 MB log without holding it in memory", async () => {
    const p = path.join(scratch, "big.log");
    const out = createWriteStream(p);
    const filler = JSON.stringify({ name: "renovate", level: 20, msg: "x".repeat(180), repository: REPO }) + "\n";
    const target = syntheticLog();
    const lines = Math.ceil((200 * 1024 * 1024) / filler.length);
    const chunk = filler.repeat(1000);
    for (let i = 0; i < lines; i += 1000) {
      if (!out.write(chunk)) await once(out, "drain");
      if (i === 0) out.write(target);
    }
    out.end();
    await once(out, "finish");

    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
    const res = await readLogPath(p);
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);

    expect(res.ok).toBe(true);
    expect((peak - before) / 1024 / 1024).toBeLessThan(120);
  }, 120_000);
});

// The oracle: one real local Renovate run. Its report file is the truth for
// `packageFiles`. A local run never records branches (the local platform
// forces dryRun to "lookup"), so `branches` is [] in the report and the
// `branches info extended` line is not emitted at all.
const renovateBin = resolveBundledBinary("renovate");
// In CI `renovate` is a runtime dependency, so a failed lookup there is a
// regression, not a reason to silently skip the oracle.
it.runIf(process.env.CI)("bundled renovate resolves", () => expect(renovateBin).not.toBeNull());
describe.skipIf(!renovateBin)("readLogPath: oracle against a real local run", () => {
  it("packageFiles deep-equals the report file; branches are empty on both sides", async () => {
    const repo = path.join(scratch, "repo");
    await writeFile(path.join(scratch, "idx.json"), JSON.stringify({ releases: [{ version: "1.0.0" }, { version: "1.1.0" }] }));
    await mkdir(repo);
    await writeFile(path.join(repo, "tool.txt"), "tool: foo 1.0.0\n");
    await writeFile(
      path.join(repo, "renovate.json"),
      JSON.stringify({
        customDatasources: {
          local: { defaultRegistryUrlTemplate: `file://${path.join(scratch, "idx.json")}`, format: "json" },
        },
        customManagers: [
          {
            customType: "regex",
            managerFilePatterns: ["tool.txt"],
            matchStrings: ["tool: (?<depName>\\w+) (?<currentValue>[\\d.]+)"],
            datasourceTemplate: "custom.local",
            versioningTemplate: "semver",
          },
        ],
        enabledManagers: ["custom.regex"],
      }),
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q", ".");
    git("add", "-A");
    git("commit", "-qm", "init");

    const reportPath = path.join(scratch, "report.json");
    const logPath = path.join(scratch, "renovate.log");
    const child = spawn(
      process.execPath,
      [renovateBin!, "--platform=local", "--dry-run=full", "--report-type=file", `--report-path=${reportPath}`],
      { cwd: repo, env: { ...process.env, LOG_FORMAT: "json", LOG_LEVEL: "debug" }, stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    const [code] = (await once(child, "close")) as [number];
    await writeFile(logPath, Buffer.concat(chunks));
    expect(code).toBe(0);

    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      repositories: Record<string, { packageFiles: unknown; branches: unknown[] }>;
    };
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("packageFiles with updates");
    expect(log).not.toContain("branches info extended");

    const res = await readLogPath(logPath);
    expect(res.ok).toBe(true);
    const parsed = (res as { value: { repositories: Record<string, Repo> } }).value.repositories;
    expect(Object.keys(parsed)).toEqual(Object.keys(report.repositories));
    for (const [name, expected] of Object.entries(report.repositories)) {
      expect(parsed[name]!.packageFiles).toEqual(expected.packageFiles);
      expect(parsed[name]!.branches).toEqual(expected.branches);
    }
  }, 120_000);
});
