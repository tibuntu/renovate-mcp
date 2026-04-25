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

  it("prefers renovate.json over .renovaterc", async () => {
    await writeFile(path.join(repo, "renovate.json"), '{"schedule":["weekly"]}');
    await writeFile(path.join(repo, ".renovaterc"), '{"schedule":["daily"]}');
    const loc = await locateConfig(repo);
    expect(loc?.relPath).toBe("renovate.json");
    expect(loc?.config).toMatchObject({ schedule: ["weekly"] });
  });

  it("prefers renovate.json over package.json#renovate", async () => {
    await writeFile(path.join(repo, "renovate.json"), '{"schedule":["weekly"]}');
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "x",
        version: "0.0.1",
        renovate: { schedule: ["daily"] },
      }),
    );
    const loc = await locateConfig(repo);
    expect(loc?.relPath).toBe("renovate.json");
  });

  it("throws on malformed JSON", async () => {
    await writeFile(path.join(repo, "renovate.json"), "{not json");
    await expect(locateConfig(repo)).rejects.toThrow();
  });
});
