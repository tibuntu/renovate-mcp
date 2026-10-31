import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { locateConfig } from "../../src/lib/configLocations.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("locateConfig", () => {
  it("reads an empty renovate.json as {}", async () => {
    await writeFile(path.join(repo, "renovate.json"), "");
    const loc = await locateConfig(repo);
    expect(loc?.relPath).toBe("renovate.json");
    expect(loc?.format).toBe("json");
    expect(loc?.config).toEqual({});
  });

  it("prefers an empty renovate.json over a non-empty .renovaterc", async () => {
    await writeFile(path.join(repo, "renovate.json"), "");
    await writeFile(path.join(repo, ".renovaterc"), '{"extends":["config:recommended"]}');
    const loc = await locateConfig(repo);
    expect(loc?.relPath).toBe("renovate.json");
    expect(loc?.config).toEqual({});
  });

  it("rejects a whitespace-only renovate.json", async () => {
    await writeFile(path.join(repo, "renovate.json"), "\n");
    await expect(locateConfig(repo)).rejects.toThrow();
  });

  it("expands a string package.json#renovate to extends", async () => {
    await writeFile(path.join(repo, "package.json"), '{"renovate":"config:recommended"}');
    const loc = await locateConfig(repo);
    expect(loc?.format).toBe("package.json");
    expect(loc?.relPath).toBe("package.json");
    expect(loc?.config).toEqual({ extends: ["config:recommended"] });
  });

  it("expands a local> preset string in package.json#renovate", async () => {
    await writeFile(path.join(repo, "package.json"), '{"renovate":"local>org/presets"}');
    const loc = await locateConfig(repo);
    expect(loc?.config).toEqual({ extends: ["local>org/presets"] });
  });

  it("returns null for an empty-string package.json#renovate", async () => {
    await writeFile(path.join(repo, "package.json"), '{"renovate":""}');
    expect(await locateConfig(repo)).toBeNull();
  });

  it("returns null for a malformed package.json", async () => {
    await writeFile(path.join(repo, "package.json"), "{not json");
    expect(await locateConfig(repo)).toBeNull();
  });

  it("returns null when no config is present", async () => {
    expect(await locateConfig(repo)).toBeNull();
  });

  it("finds renovate.json", async () => {
    await writeFile(path.join(repo, "renovate.json"), '{"extends":["config:recommended"]}');
    const loc = await locateConfig(repo);
    expect(loc).not.toBeNull();
    expect(loc?.relPath).toBe("renovate.json");
    expect(loc?.format).toBe("json");
    expect(loc?.config).toMatchObject({ extends: ["config:recommended"] });
  });

  it("parses renovate.json5 with comments and unquoted keys", async () => {
    await writeFile(
      path.join(repo, "renovate.json5"),
      '{\n  // a comment\n  extends: ["config:recommended"],\n}',
    );
    const loc = await locateConfig(repo);
    expect(loc?.format).toBe("json5");
    expect(loc?.config).toMatchObject({ extends: ["config:recommended"] });
  });

  it("parses renovate.json with a comment and a trailing comma (JSONC, like Renovate)", async () => {
    await writeFile(
      path.join(repo, "renovate.json"),
      '{\n  // keep me\n  "extends": ["config:recommended"],\n}\n',
    );
    const loc = await locateConfig(repo);
    expect(loc?.format).toBe("json");
    expect(loc?.config).toMatchObject({ extends: ["config:recommended"] });
  });

  it("finds renovate.jsonc with a comment and a trailing comma", async () => {
    await writeFile(
      path.join(repo, "renovate.jsonc"),
      '{\n  // keep me\n  "extends": ["config:recommended"],\n}\n',
    );
    const loc = await locateConfig(repo);
    expect(loc?.relPath).toBe("renovate.jsonc");
    expect(loc?.format).toBe("json");
    expect(loc?.config).toMatchObject({ extends: ["config:recommended"] });
  });

  it("finds .github/renovate.json", async () => {
    await mkdir(path.join(repo, ".github"));
    await writeFile(path.join(repo, ".github/renovate.json"), '{"enabled":false}');
    const loc = await locateConfig(repo);
    expect(loc?.relPath).toBe(".github/renovate.json");
    expect(loc?.config).toMatchObject({ enabled: false });
  });

  it("finds package.json#renovate", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "x",
        version: "0.0.1",
        renovate: { extends: ["config:recommended"] },
      }),
    );
    const loc = await locateConfig(repo);
    expect(loc?.format).toBe("package.json");
    expect(loc?.relPath).toBe("package.json");
    expect(loc?.config).toMatchObject({ extends: ["config:recommended"] });
  });

  it("ignores package.json without a renovate field", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.1" }),
    );
    expect(await locateConfig(repo)).toBeNull();
  });

  // Mirrors the priority order in src/lib/configLocations.ts. Each adjacent
  // pair is tested below to catch reorderings within the chain.
  const PRIORITY_CHAIN = [
    "renovate.json",
    "renovate.jsonc",
    "renovate.json5",
    ".github/renovate.json",
    ".github/renovate.jsonc",
    ".github/renovate.json5",
    ".gitlab/renovate.json",
    ".gitlab/renovate.jsonc",
    ".gitlab/renovate.json5",
    ".renovaterc",
    ".renovaterc.json",
    ".renovaterc.jsonc",
    ".renovaterc.json5",
    "package.json",
  ] as const;

  async function writeConfigAt(relPath: string, marker: string): Promise<void> {
    const dir = path.dirname(relPath);
    if (dir !== ".") await mkdir(path.join(repo, dir), { recursive: true });
    if (relPath === "package.json") {
      await writeFile(
        path.join(repo, relPath),
        JSON.stringify({
          name: "x",
          version: "0.0.1",
          renovate: { schedule: [marker] },
        }),
      );
      return;
    }
    if (relPath.endsWith(".json5")) {
      await writeFile(
        path.join(repo, relPath),
        `{\n  // marker\n  schedule: ["${marker}"],\n}`,
      );
      return;
    }
    await writeFile(path.join(repo, relPath), `{"schedule":["${marker}"]}`);
  }

  const ADJACENT_PAIRS = PRIORITY_CHAIN.slice(0, -1).map(
    (higher, i) => [higher, PRIORITY_CHAIN[i + 1]!] as const,
  );

  for (const [higher, lower] of ADJACENT_PAIRS) {
    it(`prefers ${higher} over ${lower}`, async () => {
      await writeConfigAt(higher, "higher");
      await writeConfigAt(lower, "lower");
      const loc = await locateConfig(repo);
      expect(loc?.relPath).toBe(higher);
      expect(loc?.config).toMatchObject({ schedule: ["higher"] });
    });
  }

  it("throws on malformed JSON", async () => {
    await writeFile(path.join(repo, "renovate.json"), "{not json");
    await expect(locateConfig(repo)).rejects.toThrow();
  });
});
