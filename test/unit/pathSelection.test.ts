import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainPaths, filterFileList, listRepoFiles } from "../../src/lib/pathSelection.js";

let repo: string;

async function makeRepo(files: string[], git = true): Promise<void> {
  for (const f of files) {
    await mkdir(path.dirname(path.join(repo, f)), { recursive: true });
    await writeFile(path.join(repo, f), "{}\n");
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
  }
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "explain-paths-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("explainPaths", () => {
  it("flags a bare ignorePaths word that drops a file only by substring", async () => {
    await makeRepo(["package.json", "src/latest/package.json", "test/package.json"]);
    const r = await explainPaths(repo, { ignorePaths: ["test"] });

    const latest = r.substringOnlyHits.find((h) => h.file === "src/latest/package.json");
    expect(latest).toEqual({
      file: "src/latest/package.json",
      pattern: "test",
      suggestedGlob: "**/test/**",
      suggestedGlobMatches: false,
    });
    // The intended hit is still substring-only, but the suggestion covers it.
    expect(r.substringOnlyHits[0]!.file).toBe("src/latest/package.json");
    expect(r.substringOnlyHits.find((h) => h.file === "test/package.json")?.suggestedGlobMatches).toBe(true);
    expect(r.patterns).toEqual([
      expect.objectContaining({ field: "ignorePaths", pattern: "test", source: "<own>", matchKind: "substring", matchedCount: 2 }),
    ]);
    expect(r.summary).toMatchObject({ fileListSource: "git", totalFiles: 3, keptCount: 1, excludedByIgnorePaths: 2 });
  });

  it("lists a glob for a non-existent directory as dead", async () => {
    await makeRepo(["package.json", "packages/a/package.json"]);
    const r = await explainPaths(repo, { ignorePaths: ["legacy/**"], includePaths: ["packages/**", "package.json"] });
    expect(r.deadPatterns).toEqual([{ field: "ignorePaths", index: 0, pattern: "legacy/**", source: "<own>" }]);
    const include = r.patterns.filter((p) => p.field === "includePaths");
    expect(include.map((p) => p.matchKind)).toEqual(["glob", "exact"]);
  });

  it("applies Renovate's default ignorePaths when none is set, without calling them dead", async () => {
    await makeRepo(["package.json", "node_modules/x/package.json"]);
    const r = await explainPaths(repo, {});
    expect(r.patterns.map((p) => [p.pattern, p.source, p.matchedCount])).toEqual([
      ["**/node_modules/**", "<renovate default>", 1],
      ["**/bower_components/**", "<renovate default>", 0],
    ]);
    expect(r.deadPatterns).toEqual([]);
    expect(r.summary.keptCount).toBe(1);
  });

  it("attributes config:recommended's ignorePaths to :ignoreModulesAndTests and drops examples/", async () => {
    await makeRepo(["package.json", "examples/package.json"]);
    const r = await explainPaths(repo, { extends: ["config:recommended"] });
    const examples = r.patterns.find((p) => p.pattern === "**/examples/**")!;
    expect(examples.source).toBe(":ignoreModulesAndTests");
    expect(examples.sampleFiles).toEqual(["examples/package.json"]);
    expect(r.summary.keptCount).toBe(1);
    expect(r.deadPatterns).toEqual([]); // built-in preset globs are never "dead"
  });

  it("flags a matchFileNames entry that matches no kept file (case-insensitive match)", async () => {
    await makeRepo(["package.json", "apps/web/package.json"]);
    const r = await explainPaths(repo, {
      packageRules: [{ description: "web", matchFileNames: ["APPS/web/**", "services/**"], enabled: false }],
    });
    expect(r.matchFileNames.map((m) => [m.pattern, m.matchedCount, m.source])).toEqual([
      ["APPS/web/**", 1, "<own>"],
      ["services/**", 0, "<own>"],
    ]);
    expect(r.deadPatterns).toContainEqual({
      field: "packageRules[0].matchFileNames",
      index: 1,
      pattern: "services/**",
      source: "<own>",
    });
  });

  it("falls back to a full walk (node_modules included) outside a git repo", async () => {
    await makeRepo(["package.json", "node_modules/x/package.json"], false);
    const listed = await listRepoFiles(repo);
    expect(listed).toEqual({ source: "walk", files: ["node_modules/x/package.json", "package.json"] });
  });

  it("reports truncation past maxFiles", async () => {
    await makeRepo(["a.json", "b.json", "c.json"]);
    const r = await explainPaths(repo, {}, { maxFiles: 2 });
    expect(r.summary).toMatchObject({ totalFiles: 3, evaluatedFiles: 2, truncated: true });
  });
});

// Drift guard: the mirror must agree with Renovate's own filters. Importing
// `renovate` is allowed under test/ (CLAUDE.md scopes the ban to src/).
describe("filterFileList parity with Renovate's file-match.js", () => {
  const files = [
    "package.json",
    "src/latest/package.json",
    "test/package.json",
    "Test/package.json",
    ".github/workflows/ci.yml",
    "packages/a/node_modules/b/package.json",
    "docs/examples/x/pom.xml",
    "go.mod",
  ];
  const cases: Array<[string[], string[]]> = [
    [[], []],
    [[], ["test"]],
    [[], ["**/test/**", "**/node_modules/**"]],
    [["packages/**"], []],
    [["package.json", "src/**"], ["latest"]],
    [["TEST/**"], []],
    [[".github/**", "go.mod"], ["**/*.yml"]],
    [[], ["examples/"]],
  ];
  it.each(cases)("includePaths=%j ignorePaths=%j", async (includePaths, ignorePaths) => {
    // @ts-ignore — runtime import of Renovate internals for the oracle.
    const oracle = (await import("renovate/dist/workers/repository/extract/file-match.js")) as {
      getFilteredFileList: (c: object, f: string[]) => string[];
    };
    expect(filterFileList(files, includePaths, ignorePaths)).toEqual(
      oracle.getFilteredFileList({ includePaths, ignorePaths }, files),
    );
  });
});
