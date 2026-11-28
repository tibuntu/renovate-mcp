import { describe, it, expect } from "vitest";
import {
  SNAPSHOTS,
  checkInstalledMatchesPin,
  checkSnapshotVersions,
  extractRenovateVersion,
} from "../../scripts/check-snapshot-versions.mjs";

describe("SNAPSHOTS catalogue", () => {
  it("describes exactly the five generated snapshot files with the right regenerate commands", () => {
    expect(SNAPSHOTS).toHaveLength(5);
    expect(SNAPSHOTS.map((s) => s.file)).toEqual([
      "src/data/presets.generated.ts",
      "src/data/managers.generated.ts",
      "src/data/migrations.generated.ts",
      "src/data/options.generated.ts",
      "src/data/datasources.generated.ts",
    ]);
    expect(SNAPSHOTS.map((s) => s.regenerateCmd)).toEqual([
      "npm run generate:presets",
      "npm run generate:managers",
      "npm run generate:migrations",
      "npm run generate:options",
      "npm run generate:datasources",
    ]);
  });
});

describe("checkSnapshotVersions", () => {
  const liveVersion = "43.150.0";
  const baseSnaps = [
    {
      file: "src/data/presets.generated.ts",
      version: liveVersion,
      regenerateCmd: "npm run generate:presets",
    },
    {
      file: "src/data/managers.generated.ts",
      version: liveVersion,
      regenerateCmd: "npm run generate:managers",
    },
    {
      file: "src/data/migrations.generated.ts",
      version: liveVersion,
      regenerateCmd: "npm run generate:migrations",
    },
    {
      file: "src/data/options.generated.ts",
      version: liveVersion,
      regenerateCmd: "npm run generate:options",
    },
  ];

  it("returns ok when every snapshot matches the live version", () => {
    const result = checkSnapshotVersions({
      liveVersion,
      snapshots: baseSnaps,
    });
    expect(result).toEqual({ ok: true, liveVersion });
  });

  it("returns one stale entry when only the managers snapshot is behind", () => {
    const snapshots = baseSnaps.map((s) =>
      s.file === "src/data/managers.generated.ts"
        ? { ...s, version: "43.141.5" }
        : s,
    );
    const result = checkSnapshotVersions({ liveVersion, snapshots });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.liveVersion).toBe(liveVersion);
    expect(result.stale).toEqual([
      {
        file: "src/data/managers.generated.ts",
        snapshotVersion: "43.141.5",
        regenerateCmd: "npm run generate:managers",
      },
    ]);
  });

  it("reports all four snapshots when every one is behind, preserving regenerate mapping", () => {
    const snapshots = baseSnaps.map((s) => ({ ...s, version: "43.100.0" }));
    const result = checkSnapshotVersions({ liveVersion, snapshots });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.stale).toHaveLength(4);
    const byFile = Object.fromEntries(
      result.stale.map((s) => [s.file, s.regenerateCmd]),
    );
    expect(byFile["src/data/presets.generated.ts"]).toBe(
      "npm run generate:presets",
    );
    expect(byFile["src/data/managers.generated.ts"]).toBe(
      "npm run generate:managers",
    );
    expect(byFile["src/data/migrations.generated.ts"]).toBe(
      "npm run generate:migrations",
    );
    expect(byFile["src/data/options.generated.ts"]).toBe(
      "npm run generate:options",
    );
  });
});

describe("extractRenovateVersion", () => {
  it("returns the captured version when the literal is present", () => {
    const source = [
      "// header",
      '',
      'export const RENOVATE_VERSION = "43.150.0";',
      "",
    ].join("\n");
    expect(extractRenovateVersion(source)).toBe("43.150.0");
  });

  it("throws with 'RENOVATE_VERSION not found' when the literal is absent", () => {
    const source =
      "// nothing useful here\nexport const SOMETHING_ELSE = \"42\";\n";
    expect(() => extractRenovateVersion(source)).toThrow(
      /RENOVATE_VERSION not found/,
    );
  });
});

describe("checkInstalledMatchesPin", () => {
  it("names both versions and points at npm ci when node_modules is stale", () => {
    expect(
      checkInstalledMatchesPin({ installed: "45.3.1", pinned: "45.3.2" }),
    ).toBe(
      "node_modules/renovate is 45.3.1 but package.json pins 45.3.2; run `npm ci`.",
    );
  });

  it("passes when installed matches the pin and skips non-exact pins", () => {
    expect(
      checkInstalledMatchesPin({ installed: "45.3.2", pinned: "45.3.2" }),
    ).toBeNull();
    expect(
      checkInstalledMatchesPin({ installed: "45.3.2", pinned: "^45.0.0" }),
    ).toBeNull();
    expect(
      checkInstalledMatchesPin({ installed: "45.3.2", pinned: undefined }),
    ).toBeNull();
  });
});
