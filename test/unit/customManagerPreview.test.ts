import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewCustomManager } from "../../src/lib/customManagerPreview.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "rmcp-cmp-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("previewCustomManager", () => {
  it("matches files by regex (not glob) and extracts named groups", async () => {
    await writeFile(
      path.join(repo, "Dockerfile"),
      "FROM alpine:3.19\nRUN apk add foo\nFROM nginx:1.25\n",
    );
    await writeFile(path.join(repo, "unrelated.txt"), "nothing to see");

    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["(^|/)Dockerfile$"],
      matchStrings: ["FROM (?<depName>[^:\\s]+):(?<currentValue>\\S+)"],
      datasourceTemplate: "docker",
    });

    expect(result.filesMatched).toEqual(["Dockerfile"]);
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      file: "Dockerfile",
      line: 1,
      groups: { depName: "alpine", currentValue: "3.19" },
    });
    expect(result.hits[1]).toMatchObject({ line: 3 });
    expect(result.extractedDeps[0]).toMatchObject({
      depName: "alpine",
      currentValue: "3.19",
      datasource: "docker",
      line: 1,
    });
  });

  it("surfaces a clear error when fileMatch looks like a glob instead of a regex", async () => {
    // `**/*.yaml` is the glob most users reach for. It is not a valid regex —
    // the leading `**` is a "nothing to repeat" error. We want that to throw
    // loudly so the user notices rather than silently getting zero matches.
    await writeFile(path.join(repo, "config.yaml"), "image: foo:1.0");
    await expect(
      previewCustomManager(repo, {
        customType: "regex",
        fileMatch: ["**/*.yaml"],
        matchStrings: ["image: (?<depName>[^:]+):(?<currentValue>.+)"],
      }),
    ).rejects.toThrow(/Invalid regex/);
  });

  it("applies templates, which override matching named groups", async () => {
    await writeFile(path.join(repo, "versions.txt"), "pkg=foo ver=1.2.3\n");
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["versions\\.txt$"],
      matchStrings: ["pkg=(?<pkg>\\S+) ver=(?<ver>\\S+)"],
      depNameTemplate: "{{pkg}}",
      currentValueTemplate: "{{ver}}",
      datasourceTemplate: "npm",
    });
    expect(result.extractedDeps).toEqual([
      expect.objectContaining({
        depName: "foo",
        currentValue: "1.2.3",
        datasource: "npm",
      }),
    ]);
  });

  it("runs multiple matchStrings regexes independently", async () => {
    await writeFile(
      path.join(repo, "mixed.txt"),
      "use foo@1.0\nother bar==2.0\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["mixed\\.txt$"],
      matchStrings: [
        "use (?<depName>\\S+)@(?<currentValue>\\S+)",
        "other (?<depName>\\S+)==(?<currentValue>\\S+)",
      ],
    });
    expect(result.hits.map((h) => h.matchStringIndex)).toEqual([0, 1]);
    expect(result.hits.map((h) => h.groups.depName)).toEqual(["foo", "bar"]);
  });

  it("warns when matchStringsStrategy is not 'any'", async () => {
    await writeFile(path.join(repo, "x.txt"), "foo=1");
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["x\\.txt$"],
      matchStrings: ["foo=(?<v>\\d+)"],
      matchStringsStrategy: "recursive",
    });
    expect(result.warnings.some((w) => /recursive/.test(w))).toBe(true);
  });

  it("skips node_modules and .git", async () => {
    await mkdir(path.join(repo, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(repo, "node_modules/pkg/Dockerfile"), "FROM x:1");
    await mkdir(path.join(repo, ".git"));
    await writeFile(path.join(repo, ".git/Dockerfile"), "FROM y:1");
    await writeFile(path.join(repo, "Dockerfile"), "FROM z:1");

    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["Dockerfile$"],
      matchStrings: ["FROM (?<depName>\\S+):(?<currentValue>\\S+)"],
    });
    expect(result.filesMatched).toEqual(["Dockerfile"]);
  });

  it("returns empty results for a regex that matches nothing, not an error", async () => {
    await writeFile(path.join(repo, "x.txt"), "no matches here");
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["x\\.txt$"],
      matchStrings: ["NOPE-(?<v>\\d+)"],
    });
    expect(result.filesMatched).toEqual(["x.txt"]);
    expect(result.hits).toEqual([]);
    expect(result.extractedDeps).toEqual([]);
  });

  it("reports a useful error for invalid regex", async () => {
    await expect(
      previewCustomManager(repo, {
        customType: "regex",
        fileMatch: ["["],
        matchStrings: ["foo"],
      }),
    ).rejects.toThrow(/Invalid regex/);
  });

  it("honors a root .gitignore — generated dirs don't crowd out real hits", async () => {
    // Acceptance from issue #21: 3000 junk files in a gitignored dist/ must
    // not burn the maxFilesScanned budget. We use a lower cap (500) to keep
    // the test fast while still proving the point.
    await writeFile(path.join(repo, ".gitignore"), "dist/\ncoverage/\n");
    await mkdir(path.join(repo, "dist"), { recursive: true });
    for (let i = 0; i < 3000; i++) {
      await writeFile(path.join(repo, `dist/junk-${i}.txt`), "noise");
    }
    await writeFile(path.join(repo, "Dockerfile"), "FROM alpine:3.19");

    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["(^|/)Dockerfile$"],
        matchStrings: ["FROM (?<depName>[^:\\s]+):(?<currentValue>\\S+)"],
      },
      { maxFilesScanned: 500 },
    );
    expect(result.filesMatched).toEqual(["Dockerfile"]);
    expect(result.warnings.some((w) => /Stopped after scanning/.test(w))).toBe(false);
    // We walked the real files, not the 3000 junk ones.
    expect(result.filesScanned).toBeLessThan(10);
  });

  it("honors .git/info/exclude in addition to .gitignore", async () => {
    await mkdir(path.join(repo, ".git/info"), { recursive: true });
    await writeFile(path.join(repo, ".git/info/exclude"), "secret.txt\n");
    await writeFile(path.join(repo, "secret.txt"), "shh");
    await writeFile(path.join(repo, "public.txt"), "ok");

    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["\\.txt$"],
      matchStrings: ["(?<depName>\\w+)"],
    });
    expect(result.filesMatched).toEqual(["public.txt"]);
  });

  it("honors a nested .gitignore only within its own subtree", async () => {
    // `foo.txt` in `sub/.gitignore` must NOT match `foo.txt` at the root.
    await mkdir(path.join(repo, "sub"), { recursive: true });
    await writeFile(path.join(repo, "sub/.gitignore"), "foo.txt\n");
    await writeFile(path.join(repo, "sub/foo.txt"), "hidden");
    await writeFile(path.join(repo, "foo.txt"), "visible");

    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["foo\\.txt$"],
      matchStrings: ["(?<v>\\S+)"],
    });
    expect(result.filesMatched).toEqual(["foo.txt"]);
  });

  it("respects negation in .gitignore", async () => {
    await writeFile(path.join(repo, ".gitignore"), "*.log\n!keep.log\n");
    await writeFile(path.join(repo, "drop.log"), "x");
    await writeFile(path.join(repo, "keep.log"), "x");

    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["\\.log$"],
      matchStrings: ["(?<v>\\S+)"],
    });
    expect(result.filesMatched).toEqual(["keep.log"]);
  });

  it("aborts a pathological matchStrings regex within the timeout budget", async () => {
    // Catastrophic backtracking: `^(a+)+b$` over "aaaa…c" tries exponentially
    // many partitions of `a`s before failing. With 40 a's this would never
    // return in a reasonable time on the main thread — but the worker + wall
    // clock caps it.
    const pathological = `${"a".repeat(40)}c`;
    await writeFile(path.join(repo, "victim.txt"), pathological);

    const start = Date.now();
    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["victim\\.txt$"],
        matchStrings: ["^(a+)+b$"],
      },
      { matchTimeoutMs: 300 },
    );
    const elapsed = Date.now() - start;

    // The 300ms budget + worker startup + terminate overhead. Allow generous
    // slack so CI jitter doesn't flake this — the point is it DOES NOT hang.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.hits).toEqual([]);
    expect(
      result.warnings.some(
        (w) => /matchStrings\[0\].*exceeded 300ms/.test(w),
      ),
    ).toBe(true);
  });

  it("aborts a pathological fileMatch regex within the timeout budget", async () => {
    // Same backtracking pathology, but applied during the fileMatch phase
    // against a long path. The walk happens on the main thread, but the
    // regex testing is in a worker — so the pathological pattern can't hang
    // the server.
    const dir = "a".repeat(60);
    await mkdir(path.join(repo, dir), { recursive: true });
    await writeFile(path.join(repo, dir, "x.txt"), "irrelevant");

    const start = Date.now();
    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["^(a+)+b$"],
        matchStrings: ["(?<v>\\S+)"],
      },
      { matchTimeoutMs: 300 },
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5_000);
    expect(result.filesMatched).toEqual([]);
    expect(
      result.warnings.some((w) => /fileMatch\[0\].*exceeded 300ms/.test(w)),
    ).toBe(true);
  });

  it("honors maxHitsPerFile and records a warning", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `pkg=foo${i} ver=${i}`).join("\n");
    await writeFile(path.join(repo, "many.txt"), lines);
    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["many\\.txt$"],
        matchStrings: ["pkg=(?<depName>\\S+) ver=(?<currentValue>\\S+)"],
      },
      { maxHitsPerFile: 5 },
    );
    expect(result.hits).toHaveLength(5);
    expect(result.warnings.some((w) => /capped at 5/.test(w))).toBe(true);
  });
});
