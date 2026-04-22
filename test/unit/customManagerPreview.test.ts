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
