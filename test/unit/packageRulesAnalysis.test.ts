import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import matchers from "renovate/dist/util/package-rules/matchers.js";
import {
  analyzePackageRules,
  detectLegacyKeys,
  suppliedFieldsOf,
  MATCHER_META,
} from "../../src/lib/packageRulesAnalysis.js";

describe("MATCHER_META coverage (tied to the registry)", () => {
  it("covers exactly the matchers in Renovate's registry", () => {
    expect(Object.keys(MATCHER_META).sort()).toEqual(
      matchers.map((m) => m.constructor.name).sort(),
    );
  });
});

describe("suppliedFieldsOf", () => {
  it("includes only present, non-undefined fields", () => {
    const s = suppliedFieldsOf({ depName: "x", datasource: undefined, manager: "npm" });
    expect(s.has("depName")).toBe(true);
    expect(s.has("manager")).toBe(true);
    expect(s.has("datasource")).toBe(false);
  });
});

describe("analyzePackageRules — faithful classification", () => {
  it("records a clean match with its contribution", async () => {
    const { matchQuality, contexts } = await analyzePackageRules(
      [{ matchPackageNames: ["lodash"], automerge: true }],
      [{ packageName: "lodash", depName: "lodash" }],
    );
    expect(matchQuality).toBe("faithful");
    const rule = contexts[0]!.rules[0]!;
    expect(rule.matched).toBe(true);
    expect(rule.matchedBy).toContain("matchPackageNames");
    expect(rule.contributedConfig).toEqual({ automerge: true });
  });

  it("distinguishes a real non-match (field supplied) from unevaluatable (field absent)", async () => {
    const rules = [{ matchDatasources: ["docker"], automerge: true }];
    const { contexts } = await analyzePackageRules(rules, [
      { datasource: "npm", depName: "x" }, // supplied → trustworthy false
      { depName: "x" }, // datasource absent → unevaluatable
    ]);

    const supplied = contexts[0]!.rules[0]!;
    expect(supplied.matched).toBe(false);
    expect(supplied.decidedBy).toContain("matchDatasources");
    expect(supplied.unevaluatable).toHaveLength(0);

    const missing = contexts[1]!.rules[0]!;
    expect(missing.matched).toBe(false);
    expect(missing.decidedBy).not.toContain("matchDatasources");
    expect(missing.unevaluatable).toEqual([
      expect.objectContaining({
        matcher: "matchDatasources",
        reason: "missing-input-field",
      }),
    ]);
  });

  it("classifies matchConfidence as needs-merge-confidence-api", async () => {
    const { contexts } = await analyzePackageRules(
      [{ matchConfidence: ["high"], automerge: true }],
      [{ depName: "x" }],
    );
    const rule = contexts[0]!.rules[0]!;
    expect(rule.matched).toBe(false);
    expect(rule.unevaluatable).toEqual([
      expect.objectContaining({
        matcher: "matchConfidence",
        reason: "needs-merge-confidence-api",
      }),
    ]);
  });

  it("flags matchJsonata as advisory even when it matches", async () => {
    const { contexts } = await analyzePackageRules(
      [{ matchJsonata: ["datasource = 'npm'"], automerge: true }],
      [{ datasource: "npm", depName: "x" }],
    );
    const rule = contexts[0]!.rules[0]!;
    expect(rule.matched).toBe(true);
    expect(rule.matchedBy).toContain("matchJsonata");
    expect(rule.unevaluatable).toEqual([
      expect.objectContaining({
        matcher: "matchJsonata",
        reason: "jsonata-may-reference-computed-fields",
      }),
    ]);
  });
});

describe("detectLegacyKeys", () => {
  it("warns about deprecated matcher keys and points at migrate_config", () => {
    const warnings = detectLegacyKeys([
      { matchPackagePatterns: ["^@types/"], automerge: true },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/matchPackagePatterns/);
    expect(warnings[0]).toMatch(/migrate_config/);
  });

  it("is silent for fully-migrated configs", () => {
    expect(detectLegacyKeys([{ matchPackageNames: ["x"] }])).toEqual([]);
  });

  it("surfaces the legacy warning through analyzePackageRules", async () => {
    const { warnings } = await analyzePackageRules(
      [{ matchPackagePatterns: ["^@types/"], automerge: true }],
      [{ depName: "@types/node" }],
    );
    expect(warnings.some((w) => /matchPackagePatterns/.test(w))).toBe(true);
  });
});

describe("analyzePackageRules — preview fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("degrades to glob-only preview when the worker is unavailable", async () => {
    vi.stubEnv(
      "RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY",
      resolve(process.cwd(), "dist/lib/does-not-exist.js"),
    );
    const { matchQuality, warnings, contexts } = await analyzePackageRules(
      [{ matchPackageNames: ["lodash"], automerge: true }],
      [{ packageName: "lodash" }],
    );
    expect(matchQuality).toBe("preview");
    expect(warnings.some((w) => /preview/.test(w))).toBe(true);
    const rule = contexts[0]!.rules[0]!;
    expect(rule.matched).toBe(true);
    expect(rule.matchedBy).toContain("matchPackageNames");
  });

  it("treats a missing field in preview as unevaluatable, not a decisive non-match", async () => {
    vi.stubEnv(
      "RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY",
      resolve(process.cwd(), "dist/lib/does-not-exist.js"),
    );
    // Rule needs `manager`, but the context doesn't supply it.
    const { matchQuality, contexts } = await analyzePackageRules(
      [{ matchManagers: ["npm"], automerge: true }],
      [{ depName: "x" }],
    );
    expect(matchQuality).toBe("preview");
    const rule = contexts[0]!.rules[0]!;
    expect(rule.matched).toBe(false);
    expect(rule.decidedBy).not.toContain("matchManagers");
    expect(rule.unevaluatable[0]).toMatchObject({
      matcher: "matchManagers",
      reason: "missing-input-field",
    });
  });

  it("marks rules with unsupported matchers as unevaluatable in preview", async () => {
    vi.stubEnv(
      "RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY",
      resolve(process.cwd(), "dist/lib/does-not-exist.js"),
    );
    const { matchQuality, contexts } = await analyzePackageRules(
      [{ matchCurrentVersion: ">=1.0.0", automerge: true }],
      [{ depName: "x" }],
    );
    expect(matchQuality).toBe("preview");
    const rule = contexts[0]!.rules[0]!;
    expect(rule.matched).toBe(false);
    expect(rule.unevaluatable[0]?.matcher).toBe("matchCurrentVersion");
  });
});
