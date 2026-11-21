import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getDatasources } from "renovate/dist/modules/datasource/index.js";
import {
  DATASOURCES_WITHOUT_RELEASE_TIMESTAMP,
  RELEASE_TIMESTAMP_EXCLUSIONS,
} from "../../src/data/datasources.generated.js";

// Oracle for the `release-age-without-timestamp` lint list: a datasource whose
// class says `releaseTimestampSupport = false` may still emit timestamps. The
// generator excludes those by hand; this fails when a Renovate bump changes
// the picture so the list gets re-reviewed instead of silently reshaped.
const dsDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve("renovate/package.json")),
  "dist/modules/datasource",
);

function emitsTimestamp(id: string): boolean {
  const walk = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!p.endsWith(".js")) return false;
      return readFileSync(p, "utf8").replaceAll("releaseTimestamp: null", "").includes("releaseTimestamp");
    });
  return walk(path.join(dsDir, id));
}

const flaggedFalse = [...getDatasources()]
  .filter(([, ds]) => ds.releaseTimestampSupport !== true)
  .map(([id]) => id);

describe("datasource release-timestamp drift guard", () => {
  it("lists exactly the flagged-false datasources minus the exclusions", () => {
    expect([...DATASOURCES_WITHOUT_RELEASE_TIMESTAMP]).toEqual(
      flaggedFalse.filter((id) => !RELEASE_TIMESTAMP_EXCLUSIONS.includes(id)).sort(),
    );
  });

  it("no listed datasource has dist source emitting a releaseTimestamp", () => {
    expect(DATASOURCES_WITHOUT_RELEASE_TIMESTAMP.filter(emitsTimestamp)).toEqual([]);
  });

  it("every exclusion still exists, is flagged false, and still emits a releaseTimestamp", () => {
    for (const id of RELEASE_TIMESTAMP_EXCLUSIONS) {
      expect(flaggedFalse, id).toContain(id);
      expect(emitsTimestamp(id), id).toBe(true);
    }
  });
});
