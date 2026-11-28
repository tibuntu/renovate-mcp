import { describe, it, expect } from "vitest";
import { isValidDependency, missingFields } from "../../src/lib/customManagerPreview.js";

// Oracle: Renovate's own predicate (importing `renovate` is allowed under test/).
async function oracle(): Promise<(d: Record<string, unknown>) => boolean> {
  const mod = await import(
    // @ts-ignore — runtime import of an untyped deep path
    "renovate/dist/modules/manager/custom/utils.js"
  );
  return (mod as { isValidDependency: (d: Record<string, unknown>) => boolean }).isValidDependency;
}

const table: Array<[string, Record<string, unknown>]> = [
  ["full dep", { depName: "a", currentValue: "1", datasource: "npm" }],
  ["packageName-only name", { packageName: "a", currentValue: "1", datasource: "npm" }],
  ["digest-only version", { depName: "a", currentDigest: "sha256:x", datasource: "docker" }],
  ["missing datasource", { depName: "a", currentValue: "1" }],
  ["whitespace currentValue", { depName: "a", currentValue: "  ", datasource: "npm" }],
  ["empty depName with packageName", { depName: "", packageName: "a", currentValue: "1", datasource: "npm" }],
  ["nothing", {}],
];

describe("isValidDependency parity with Renovate", () => {
  for (const [name, dep] of table) {
    it(name, async () => {
      const upstream = await oracle();
      expect(isValidDependency(dep)).toBe(upstream(dep));
      expect(missingFields(dep).length === 0).toBe(upstream(dep));
    });
  }
});
