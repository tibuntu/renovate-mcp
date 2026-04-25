import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewCustomManager } from "../../src/lib/customManagerPreview.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
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

  it("applies every template field to the extracted dep", async () => {
    // Issue #67: depName/currentValue/datasource templates are exercised
    // above. This locks in the remaining seven so a refactor of
    // buildExtractedDep / TEMPLATE_FIELD_MAP can't silently drop any of them.
    await writeFile(
      path.join(repo, "all.txt"),
      "pkg=foo ver=1.2.3 dig=sha256:abc\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["all\\.txt$"],
      matchStrings: [
        "pkg=(?<pkg>\\S+) ver=(?<ver>\\S+) dig=(?<dig>\\S+)",
      ],
      depNameTemplate: "{{pkg}}",
      packageNameTemplate: "scope/{{pkg}}",
      currentValueTemplate: "{{ver}}",
      currentDigestTemplate: "{{dig}}",
      datasourceTemplate: "npm",
      versioningTemplate: "semver",
      registryUrlTemplate: "https://registry.example.com/{{pkg}}",
      depTypeTemplate: "dependencies",
      extractVersionTemplate: "^v?(?<version>.*)$",
      autoReplaceStringTemplate: "pkg={{pkg}} ver={{ver}}",
    });
    expect(result.extractedDeps).toEqual([
      expect.objectContaining({
        depName: "foo",
        packageName: "scope/foo",
        currentValue: "1.2.3",
        currentDigest: "sha256:abc",
        datasource: "npm",
        versioning: "semver",
        registryUrl: "https://registry.example.com/foo",
        depType: "dependencies",
        extractVersion: "^v?(?<version>.*)$",
        autoReplaceString: "pkg=foo ver=1.2.3",
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

  it("warns when matchStringsStrategy is unrecognized and falls back to 'any'", async () => {
    await writeFile(path.join(repo, "x.txt"), "foo=1");
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["x\\.txt$"],
      matchStrings: ["foo=(?<v>\\d+)"],
      matchStringsStrategy: "bogus",
    });
    expect(result.warnings.some((w) => /bogus/.test(w))).toBe(true);
    // Fallback to 'any' still extracts the match.
    expect(result.hits).toHaveLength(1);
  });

  it("combination strategy merges groups from every matchString into one dep", async () => {
    // Two matchStrings, each contributing one piece of dep info. Renovate's
    // combination strategy requires both to hit and produces a single merged dep.
    await writeFile(
      path.join(repo,  "Chart.yaml"),
      "name: my-chart\nversion: 1.2.3\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["Chart\\.yaml$"],
      matchStrings: [
        "name:\\s+(?<depName>\\S+)",
        "version:\\s+(?<currentValue>\\S+)",
      ],
      datasourceTemplate: "helm",
      matchStringsStrategy: "combination",
    });
    expect(result.hits).toHaveLength(2);
    expect(result.extractedDeps).toEqual([
      expect.objectContaining({
        file: "Chart.yaml",
        depName: "my-chart",
        currentValue: "1.2.3",
        datasource: "helm",
      }),
    ]);
    // Anchor at the first contributing match (line 1 — the `name:` line).
    expect(result.extractedDeps[0]!.line).toBe(1);
  });

  it("combination strategy yields no dep if any matchString has zero matches", async () => {
    await writeFile(
      path.join(repo, "Chart.yaml"),
      "name: my-chart\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["Chart\\.yaml$"],
      matchStrings: [
        "name:\\s+(?<depName>\\S+)",
        "version:\\s+(?<currentValue>\\S+)",
      ],
      matchStringsStrategy: "combination",
    });
    expect(result.extractedDeps).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it("recursive strategy descends through matchStrings and produces one dep per leaf", async () => {
    // Outer block captures the `dependencies:` section; inner regex enumerates
    // each entry. Each leaf inherits `depType` from the outer match.
    await writeFile(
      path.join(repo, "manifest.txt"),
      [
        "dependencies:",
        "  foo@1.0.0",
        "  bar@2.0.0",
        "devDependencies:",
        "  baz@3.0.0",
        "",
      ].join("\n"),
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["manifest\\.txt$"],
      matchStrings: [
        "(?<depType>dependencies|devDependencies):\\n(?:  \\S+\\n)+",
        "  (?<depName>[^@\\s]+)@(?<currentValue>\\S+)",
      ],
      datasourceTemplate: "npm",
      matchStringsStrategy: "recursive",
    });
    expect(result.extractedDeps).toEqual([
      expect.objectContaining({ depName: "foo", currentValue: "1.0.0", depType: "dependencies" }),
      expect.objectContaining({ depName: "bar", currentValue: "2.0.0", depType: "dependencies" }),
      expect.objectContaining({ depName: "baz", currentValue: "3.0.0", depType: "devDependencies" }),
    ]);
    // Leaf line numbers refer to absolute lines in the original file.
    expect(result.extractedDeps.map((d) => d.line)).toEqual([2, 3, 5]);
  });

  it("recursive strategy: inner groups override outer groups on key conflicts", async () => {
    // Outer group sets `currentValue=outer`; inner group sets `currentValue=inner`.
    // Per Renovate's mergeGroups (later wins), the inner value should win.
    await writeFile(
      path.join(repo, "x.txt"),
      "block(?<currentValue>outer):\nentry foo=inner\n",
    );
    const result = await previewCustomManager(repo, {
      customType: "regex",
      fileMatch: ["x\\.txt$"],
      matchStrings: [
        "block\\(\\?<currentValue>(?<currentValue>\\w+)\\):.*\\n.*",
        "entry (?<depName>\\w+)=(?<currentValue>\\w+)",
      ],
      matchStringsStrategy: "recursive",
    });
    expect(result.extractedDeps).toEqual([
      expect.objectContaining({ depName: "foo", currentValue: "inner" }),
    ]);
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
    // not burn the maxFilesWalked budget. We use a lower cap (500) to keep
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
      { maxFilesWalked: 500 },
    );
    expect(result.filesMatched).toEqual(["Dockerfile"]);
    expect(result.warnings.some((w) => /Stopped walking/.test(w))).toBe(false);
    // We walked the real files, not the 3000 junk ones.
    expect(result.filesWalked).toBeLessThan(10);
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

  it("names the walk limit (not the match limit) when stopping mid-walk, and may miss matches past the cap", async () => {
    // Issue #58: previously the walk cap early-exit emitted a warning that
    // talked about "scanning" without distinguishing walk-limit from
    // match-limit. Verify: (a) the target file past the cap is silently
    // dropped today (acceptable trade-off), and (b) the warning text names
    // the walk cap specifically so the user knows which knob to turn.
    for (let i = 0; i < 20; i++) {
      await writeFile(path.join(repo, `noise-${i.toString().padStart(2, "0")}.txt`), "x");
    }
    // `z-target.txt` sorts last, so any reasonable walk order puts it after
    // the noise files and past the cap.
    await writeFile(path.join(repo, "z-target.txt"), "pkg=foo ver=1");

    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["z-target\\.txt$"],
        matchStrings: ["pkg=(?<depName>\\S+) ver=(?<currentValue>\\S+)"],
      },
      { maxFilesWalked: 5 },
    );

    expect(result.filesWalked).toBe(5);
    expect(result.filesMatched).toEqual([]);
    expect(
      result.warnings.some(
        (w) => /Stopped walking/.test(w) && /maxFilesWalked/.test(w),
      ),
    ).toBe(true);
    expect(result.warnings.some((w) => /maxFilesMatched/.test(w))).toBe(false);
  });

  it("caps filesMatched at maxFilesMatched and names that limit in the warning", async () => {
    // Issue #58: a broad fileMatch can match thousands of files. The result
    // set is capped independently of the walk cap, with a dedicated warning.
    for (let i = 0; i < 30; i++) {
      await writeFile(path.join(repo, `hit-${i.toString().padStart(2, "0")}.txt`), "v");
    }

    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["hit-.*\\.txt$"],
        matchStrings: ["(?<v>\\S+)"],
      },
      { maxFilesMatched: 5 },
    );

    expect(result.filesWalked).toBe(30);
    expect(result.filesMatched).toHaveLength(5);
    expect(
      result.warnings.some(
        (w) => /fileMatch matched 30 files/.test(w) && /maxFilesMatched=5/.test(w),
      ),
    ).toBe(true);
    expect(result.warnings.some((w) => /Stopped walking/.test(w))).toBe(false);
    // Hits only come from the capped subset — not from the full match set.
    const hitFiles = new Set(result.hits.map((h) => h.file));
    expect(hitFiles.size).toBe(5);
  });

  it("skips files exceeding maxFileBytes without reading them", async () => {
    // Acceptance from issue #62: a file that slipped past fileMatch (lockfile,
    // generated artifact, SQL dump) must not OOM the server. We create a small
    // file and an oversized file, set maxFileBytes just above the small one,
    // and confirm only the small one is read.
    await writeFile(path.join(repo, "small.txt"), "pkg=foo ver=1.0.0\n");
    const big = "x".repeat(2048);
    await writeFile(path.join(repo, "huge.txt"), big);
    const result = await previewCustomManager(
      repo,
      {
        customType: "regex",
        fileMatch: ["\\.txt$"],
        matchStrings: ["pkg=(?<depName>\\S+) ver=(?<currentValue>\\S+)"],
      },
      { maxFileBytes: 1024 },
    );
    expect([...result.filesMatched].sort()).toEqual(["huge.txt", "small.txt"]);
    expect(result.hits.map((h) => h.file)).toEqual(["small.txt"]);
    expect(
      result.warnings.some(
        (w) =>
          /huge\.txt/.test(w) &&
          /skipped/.test(w) &&
          /maxFileBytes=1024/.test(w),
      ),
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
