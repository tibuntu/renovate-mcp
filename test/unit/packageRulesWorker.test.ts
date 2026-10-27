import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import matchers from "renovate/dist/util/package-rules/matchers.js";
import { applyPackageRules } from "renovate/dist/util/package-rules/index.js";
import { runApplyPackageRules } from "../../src/lib/packageRulesWorker.js";
import { WorkerTimeoutError } from "../../src/lib/renovateWorker.js";

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
    // Every rule reports the full 19-matcher verdict vector.
    expect(res!.rules[0]!.matchers).toHaveLength(19);
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

  it("throws WorkerTimeoutError when the cold-load budget is exceeded", async () => {
    await expect(
      runApplyPackageRules([{ matchPackageNames: ["lodash"] }], [BASE], {
        timeoutMs: 1,
      }),
    ).rejects.toBeInstanceOf(WorkerTimeoutError);
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
  it("has exactly the 19 expected matchers in the expected order", () => {
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
      "IsBreakingMatcher",
      "SourceUrlsMatcher",
      "RegistryUrlsMatcher",
      "NewValueMatcher",
      "CurrentAgeMatcher",
      "JsonataMatcher",
    ]);
  });
});

describe("runApplyPackageRules — template rendering (renderBase)", () => {
  const MAJOR = {
    ...BASE,
    newValue: "^5.0.0",
    newVersion: "5.0.0",
    updateType: "major",
  };

  it("renders branchName / commitMessage / prTitle from Renovate's defaults, even with zero rules", async () => {
    const [res] = await runApplyPackageRules([], [MAJOR], { renderBase: {} });
    expect(res!.rendered).toEqual({
      branchName: "renovate/lodash-5.x",
      commitMessage: "Update dependency lodash to v5",
      prTitle: "Update dependency lodash to v5",
      missingTemplateVariables: [],
    });
  });

  it("does not render when renderBase is absent", async () => {
    const [res] = await runApplyPackageRules([{ matchPackageNames: ["lodash"] }], [MAJOR]);
    expect(res!.rendered).toBeUndefined();
  });

  it("applies the top-level config and a matched rule's contribution (semantic prefix)", async () => {
    const [res] = await runApplyPackageRules(
      [{ matchPackageNames: ["lodash"], semanticCommitType: "fix" }],
      [MAJOR],
      { renderBase: { semanticCommits: "enabled", branchPrefix: "deps/" } },
    );
    // missingTemplateVariables must be empty: the probe never marks config
    // options (commitMessagePrefix, groupName, prTitle), so it takes the same
    // semantic-prefix / non-group path as the real render.
    expect(res!.rendered).toEqual({
      branchName: "deps/lodash-5.x",
      commitMessage: "fix(deps): update dependency lodash to v5",
      prTitle: "fix(deps): update dependency lodash to v5",
      missingTemplateVariables: [],
    });
  });

  it("reports a template error per context instead of failing the whole evaluation", async () => {
    const [res] = await runApplyPackageRules(
      [{ matchPackageNames: ["lodash"], automerge: true }],
      [MAJOR],
      { renderBase: { prTitle: "{{#if isMajor}}unclosed" } },
    );
    expect(res!.rules[0]!.matched).toBe(true); // matching is untouched
    expect(res!.mergedConfig.automerge).toBe(true);
    expect(res!.rendered).toBeUndefined();
    expect(res!.renderError).toMatch(/Parse error/);
  });

  it("renders a groupName as a group branch (slug topic, group commit topic)", async () => {
    const [res] = await runApplyPackageRules(
      [{ matchPackageNames: ["lodash"], groupName: "all non-major" }],
      [{ ...BASE, newValue: "^4.1.0", newVersion: "4.1.0", updateType: "minor" }],
      { renderBase: {} },
    );
    expect(res!.rendered).toMatchObject({
      branchName: "renovate/all-non-major",
      commitMessage: "Update all non-major",
      groupName: "all non-major",
    });
  });

  it("lists only the post-lookup variables that actually reach the output", async () => {
    // No newVersion and a range newValue: newMajor cannot be derived, so the
    // default branchTopic / commitMessageExtra render with a hole. Variables in
    // untaken {{#if}} branches (newMinor, newDigestShort, …) must NOT be listed.
    const [res] = await runApplyPackageRules([], [{ ...BASE, newValue: "^5.0.0", updateType: "major" }], {
      renderBase: {},
    });
    expect(res!.rendered!.branchName).toBe("renovate/lodash-.x");
    expect(res!.rendered!.missingTemplateVariables).toEqual(["newMajor"]);
  });
});

describe("template rendering parity oracle", () => {
  // Prove the worker's mirror of generateBranchConfig's single-update path
  // (semantic prefix, 3× compile, whitespace/lower-casing, prTitle fallback)
  // matches Renovate's real output. The oracle is fed the same post-lookup
  // fields explicitly, so this pins the compile path, not the derivation.
  async function oracle(ctx: Record<string, unknown>) {
    const { getConfig } = await import("renovate/dist/config/defaults.js");
    const { mergeChildConfig } = await import("renovate/dist/config/utils.js");
    const { applyUpdateConfig } = await import("renovate/dist/workers/repository/updates/flatten.js");
    const { generateBranchConfig } = await import("renovate/dist/workers/repository/updates/generate.js");
    const upgrade = applyUpdateConfig(mergeChildConfig(getConfig(), ctx));
    const g = generateBranchConfig([upgrade]);
    return { branchName: g.branchName, commitMessage: g.commitMessage, prTitle: g.prTitle };
  }

  const LOOKED_UP = {
    ...BASE,
    newValue: "^5.0.0",
    newVersion: "5.0.0",
    newMajor: 5,
    newMinor: 0,
    newPatch: 0,
    updateType: "major",
    isMajor: true,
    isSingleVersion: false,
  };

  const cases: Array<{ name: string; ctx: Record<string, unknown> }> = [
    { name: "defaults, major", ctx: LOOKED_UP },
    {
      name: "semantic commits with scope",
      ctx: { ...LOOKED_UP, semanticCommits: "enabled", semanticCommitType: "fix", semanticCommitScope: "deps/{{depType}}", depType: "devDependencies" },
    },
    {
      name: "custom commitMessagePrefix + prTitle template + branchNameStrict",
      ctx: {
        ...LOOKED_UP,
        commitMessagePrefix: "[deps]",
        prTitle: "bump {{depName}} to {{newVersion}} ({{updateType}})",
        additionalBranchPrefix: "{{parentDir}}-",
        parentDir: "web",
        branchNameStrict: true,
      },
    },
    {
      name: "groupName with groupSingleUpdates",
      ctx: { ...LOOKED_UP, groupName: "lodash family", groupSingleUpdates: true },
    },
    {
      // Pins the mirrored sanitizeDepName quirk: only the FIRST run of dashes
      // is collapsed (non-global replace), scope/@types stripped, slashes → dashes.
      name: "scoped depName with repeated dashes and slashes",
      ctx: { ...LOOKED_UP, depName: "@types/foo--bar//baz--qux", packageName: "@types/foo--bar//baz--qux" },
    },
  ];

  for (const c of cases) {
    it(`rendered names match Renovate: ${c.name}`, async () => {
      const [res] = await runApplyPackageRules([], [c.ctx], { renderBase: {} });
      const { groupName: _g, missingTemplateVariables: _m, ...names } = res!.rendered!;
      expect(names).toEqual(await oracle(c.ctx));
    });
  }
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
