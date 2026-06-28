import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import matchers from "renovate/dist/util/package-rules/matchers.js";
import { applyPackageRules } from "renovate/dist/util/package-rules/index.js";
import {
  runApplyPackageRules,
  PackageRulesTimeoutError,
} from "../../src/lib/packageRulesWorker.js";

/**
 * The worker entry (dist/lib/packageRulesWorkerImpl.js) is pointed at via
 * RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY in vitest.config.ts, because in the
 * vitest runtime `import.meta.url` resolves to the TS source under src/ where no
 * compiled sibling .js exists. `pretest` builds dist/ before the suite runs.
 */
const BASE = {
  depName: "lodash",
  packageName: "lodash",
  datasource: "npm",
  manager: "npm",
  currentValue: "^4.0.0",
};

describe("runApplyPackageRules (worker-isolated faithful matching)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns [] for zero contexts without spawning a worker", async () => {
    expect(await runApplyPackageRules([{ matchPackageNames: ["a"] }], [])).toEqual([]);
  });

  it("returns each context unchanged for zero rules without spawning a worker", async () => {
    const results = await runApplyPackageRules([], [{ depName: "x" }]);
    expect(results).toEqual([
      { mergedConfig: { depName: "x", packageRules: [] }, rules: [] },
    ]);
  });

  it("faithfully matches a glob rule and records its contribution", async () => {
    const [res] = await runApplyPackageRules(
      [{ matchPackageNames: ["lodash"], automerge: true }],
      [BASE],
    );
    expect(res!.rules[0]!.matched).toBe(true);
    expect(res!.rules[0]!.contributedConfig).toEqual({ automerge: true });
    expect(res!.mergedConfig.automerge).toBe(true);
    // Every rule reports the full 18-matcher verdict vector.
    expect(res!.rules[0]!.matchers).toHaveLength(18);
  });

  it("distinguishes a vacuous match (all matchers null) from a real non-match (a matcher returns false)", async () => {
    const [res] = await runApplyPackageRules(
      [
        { description: "no selectors — matches everything", automerge: true },
        { matchPackageNames: ["something-else"], automerge: false },
      ],
      [BASE],
    );
    // Rule 0: no match* keys → every matcher returns null → vacuously matched.
    expect(res!.rules[0]!.matched).toBe(true);
    expect(res!.rules[0]!.matchers.every((m) => m.result === "null")).toBe(true);
    // Rule 1: a selector is present but doesn't match → a matcher returns false.
    expect(res!.rules[1]!.matched).toBe(false);
    expect(res!.rules[1]!.matchers.some((m) => m.result === "false")).toBe(true);
    expect(res!.rules[1]!.matchers.some((m) => m.result === "threw")).toBe(false);
  });

  it("tags matchConfidence as 'threw' offline (no credentials) without aborting the context", async () => {
    const [res] = await runApplyPackageRules(
      [{ matchConfidence: ["high"], automerge: true }],
      [BASE],
    );
    const mc = res!.rules[0]!.matchers.find(
      (m) => m.name === "MergeConfidenceMatcher",
    );
    expect(mc?.result).toBe("threw");
    expect(mc?.error).toBeTruthy();
    // A throwing matcher makes the rule unevaluatable, so it is not applied.
    expect(res!.rules[0]!.matched).toBe(false);
    expect(res!.mergedConfig.automerge).toBeUndefined();
  });

  it("applies an override mid-loop so a later rule sees it", async () => {
    const packageRules = [
      { matchPackageNames: ["lodash"], overrideDatasource: "docker" },
      { matchDatasources: ["docker"], automerge: true },
    ];
    const [res] = await runApplyPackageRules(packageRules, [BASE]);
    expect(res!.rules[0]!.matched).toBe(true);
    expect(res!.rules[1]!.matched).toBe(true);
    expect(res!.mergedConfig.datasource).toBe("docker");
    expect(res!.mergedConfig.automerge).toBe(true);
  });

  it("throws PackageRulesTimeoutError when the cold-load budget is exceeded", async () => {
    await expect(
      runApplyPackageRules([{ matchPackageNames: ["lodash"] }], [BASE], {
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(PackageRulesTimeoutError);
  });

  it("rejects promptly when the worker exits non-zero without posting a result", async () => {
    vi.stubEnv(
      "RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY",
      resolve(process.cwd(), "test/fixtures/exit-one-worker.mjs"),
    );
    await expect(
      runApplyPackageRules([{ matchPackageNames: ["lodash"] }], [BASE], {
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/exited \(code 1\)/);
  });
});

describe("matcher-registry drift sentinel", () => {
  // The matchers array (count + order) is load-bearing: the worker iterates it
  // to build the per-matcher verdict vector. Pin it so a Renovate bump that
  // adds/removes/reorders/renames a matcher fails loudly in PR CI — not only in
  // the nightly real-Renovate run. Update deliberately alongside ADR-0006 when
  // Renovate's matcher set genuinely changes.
  it("has exactly the 18 expected matchers in the expected order", () => {
    expect(matchers.map((m) => m.constructor.name)).toEqual([
      "MergeConfidenceMatcher",
      "RepositoriesMatcher",
      "BaseBranchesMatcher",
      "CategoriesMatcher",
      "ManagersMatcher",
      "FileNamesMatcher",
      "DatasourcesMatcher",
      "PackageNameMatcher",
      "DepNameMatcher",
      "DepTypesMatcher",
      "CurrentValueMatcher",
      "CurrentVersionMatcher",
      "UpdateTypesMatcher",
      "SourceUrlsMatcher",
      "RegistryUrlsMatcher",
      "NewValueMatcher",
      "CurrentAgeMatcher",
      "JsonataMatcher",
    ]);
  });
});

describe("applyPackageRules parity oracle", () => {
  // Prove the worker's loop replication stays faithful: its mergedConfig must
  // deep-equal a direct applyPackageRules() call. Covers glob match, override
  // mid-loop, mergeable-array concatenation, and no-match. Excludes
  // matchConfidence (which applyPackageRules throws on offline, by design).
  const cases: Array<{ name: string; context: Record<string, unknown>; packageRules: Record<string, unknown>[] }> = [
    {
      name: "glob match",
      context: { ...BASE },
      packageRules: [{ matchPackageNames: ["lodash"], automerge: true, addLabels: ["deps"] }],
    },
    {
      name: "override mid-loop",
      context: { ...BASE },
      packageRules: [
        { matchPackageNames: ["lodash"], overrideDatasource: "docker" },
        { matchDatasources: ["docker"], automerge: true },
      ],
    },
    {
      name: "mergeable-array concatenation across two matched rules",
      context: { ...BASE },
      packageRules: [
        { matchPackageNames: ["lodash"], addLabels: ["a"] },
        { matchDatasources: ["npm"], addLabels: ["b"] },
      ],
    },
    {
      name: "no match",
      context: { ...BASE },
      packageRules: [{ matchPackageNames: ["not-lodash"], automerge: true }],
    },
  ];

  for (const c of cases) {
    it(`mergedConfig matches applyPackageRules: ${c.name}`, async () => {
      const [res] = await runApplyPackageRules(c.packageRules, [c.context]);
      const oracle = await applyPackageRules({
        ...c.context,
        packageRules: c.packageRules,
      });
      expect(res!.mergedConfig).toEqual(oracle);
    });
  }
});
