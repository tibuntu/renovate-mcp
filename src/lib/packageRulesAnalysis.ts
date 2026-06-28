import {
  runApplyPackageRules,
  type PerContextResult,
} from "./packageRulesWorker.js";

/**
 * Shared analysis layer for `test_package_rules` and `annotate_dry_run`. Wraps
 * the worker-isolated faithful matcher (see ADR-0006) and turns its raw
 * per-matcher verdict vector into a human-meaningful classification:
 *   - matched              — the matcher returned true
 *   - real non-match       — the matcher returned false AND the caller supplied
 *                            the field(s) it reads (so the verdict is trustworthy)
 *   - unevaluatable        — the matcher returned false but a field it needs was
 *                            not supplied, OR it threw (matchConfidence needs the
 *                            merge-confidence API), OR it is a JSONata expression
 *                            whose result may depend on unsupplied computed fields
 *
 * The crucial subtlety (verified in Renovate's matchers): a matcher returns
 * `false` identically for "supplied-but-no-match" and "field-absent". Only this
 * layer — which knows what the caller actually supplied — can tell them apart.
 *
 * If the worker is unavailable, falls back to a thin in-process glob-only matcher
 * over the common static keys and reports `matchQuality: "preview"`, mirroring
 * resolve_config / explain_config.
 */

export type MatchQuality = "faithful" | "preview";

type MatcherKind = "static" | "computed" | "mc-api" | "jsonata";

interface MatcherMeta {
  /** Friendly `match*` key as written in a packageRule. */
  key: string;
  /** Context fields the matcher reads; evaluatable iff ≥1 is supplied. */
  requiredAnyOf: string[];
  kind: MatcherKind;
}

/**
 * Class-name → metadata for every matcher in Renovate's registry. The keys are
 * tied to the matcher-registry drift sentinel (see packageRulesWorker.test.ts):
 * a Renovate bump that renames/adds/removes a matcher breaks both this map's
 * coverage assertion and the sentinel, forcing a deliberate update with ADR-0006.
 */
export const MATCHER_META: Record<string, MatcherMeta> = {
  MergeConfidenceMatcher: { key: "matchConfidence", requiredAnyOf: ["mergeConfidenceLevel"], kind: "mc-api" },
  RepositoriesMatcher: { key: "matchRepositories", requiredAnyOf: ["repository"], kind: "static" },
  BaseBranchesMatcher: { key: "matchBaseBranches", requiredAnyOf: ["baseBranch"], kind: "static" },
  CategoriesMatcher: { key: "matchCategories", requiredAnyOf: ["categories"], kind: "static" },
  ManagersMatcher: { key: "matchManagers", requiredAnyOf: ["manager"], kind: "static" },
  FileNamesMatcher: { key: "matchFileNames", requiredAnyOf: ["packageFile", "lockFiles"], kind: "static" },
  DatasourcesMatcher: { key: "matchDatasources", requiredAnyOf: ["datasource"], kind: "static" },
  PackageNameMatcher: { key: "matchPackageNames", requiredAnyOf: ["packageName", "depName"], kind: "static" },
  DepNameMatcher: { key: "matchDepNames", requiredAnyOf: ["depName"], kind: "static" },
  DepTypesMatcher: { key: "matchDepTypes", requiredAnyOf: ["depType", "depTypes"], kind: "static" },
  CurrentValueMatcher: { key: "matchCurrentValue", requiredAnyOf: ["currentValue"], kind: "static" },
  CurrentVersionMatcher: { key: "matchCurrentVersion", requiredAnyOf: ["currentVersion", "lockedVersion"], kind: "computed" },
  UpdateTypesMatcher: { key: "matchUpdateTypes", requiredAnyOf: ["updateType", "isBump"], kind: "computed" },
  SourceUrlsMatcher: { key: "matchSourceUrls", requiredAnyOf: ["sourceUrl"], kind: "static" },
  RegistryUrlsMatcher: { key: "matchRegistryUrls", requiredAnyOf: ["registryUrls"], kind: "static" },
  NewValueMatcher: { key: "matchNewValue", requiredAnyOf: ["newValue"], kind: "computed" },
  CurrentAgeMatcher: { key: "matchCurrentAge", requiredAnyOf: ["currentVersionTimestamp"], kind: "computed" },
  JsonataMatcher: { key: "matchJsonata", requiredAnyOf: [], kind: "jsonata" },
};

export type UnevaluatableReason =
  | "missing-input-field"
  | "needs-merge-confidence-api"
  | "jsonata-may-reference-computed-fields"
  | "matcher-error";

export interface MatcherFinding {
  /** Friendly `match*` key. */
  matcher: string;
  /** Context fields the matcher reads (when relevant). */
  requiredFields: string[];
  reason: UnevaluatableReason;
  /** Present for matcher-error / needs-merge-confidence-api. */
  error?: string;
}

export interface RuleAnalysis {
  index: number;
  rule: Record<string, unknown>;
  /** True iff the rule cleanly matched (no matcher returned false, none threw). */
  matched: boolean;
  /** Friendly keys that returned true. */
  matchedBy: string[];
  /** Friendly keys that returned a trustworthy false (their fields were supplied). */
  decidedBy: string[];
  /** Matchers we could not evaluate (missing field, mc-api, jsonata advisory, error). */
  unevaluatable: MatcherFinding[];
  /** The rule's contribution (match/exclude stripped, overrides applied). Present only when matched. */
  contributedConfig?: Record<string, unknown>;
}

export interface ContextAnalysis {
  /** Faithful merged config (worker path) or approximate (preview path). */
  mergedConfig: Record<string, unknown>;
  rules: RuleAnalysis[];
}

export interface PackageRulesAnalysis {
  matchQuality: MatchQuality;
  contexts: ContextAnalysis[];
  warnings: string[];
}

const LEGACY_MATCHER_KEYS = [
  "matchPackagePatterns",
  "matchPackagePrefixes",
  "excludePackagePatterns",
  "excludePackagePrefixes",
  "matchPaths",
  "paths",
] as const;

/** Field names the caller actually supplied (present and not undefined). */
export function suppliedFieldsOf(context: Record<string, unknown>): Set<string> {
  const set = new Set<string>();
  for (const [k, v] of Object.entries(context)) {
    if (v !== undefined) set.add(k);
  }
  return set;
}

/**
 * Detect deprecated matcher keys. Renovate migrates these to matchPackageNames /
 * matchFileNames internally before applying rules; the real matchers we evaluate
 * only understand the migrated keys, so a legacy rule would faithfully match
 * nothing. We warn and point at migrate_config (consistent with
 * lint_config → migrate_config) rather than auto-migrating.
 */
export function detectLegacyKeys(
  packageRules: Record<string, unknown>[],
): string[] {
  const found = new Set<string>();
  for (const rule of packageRules) {
    for (const key of LEGACY_MATCHER_KEYS) {
      if (key in rule) found.add(key);
    }
  }
  if (found.size === 0) return [];
  return [
    `Config uses deprecated matcher key(s) ${[...found]
      .map((k) => `\`${k}\``)
      .join(", ")}. Renovate migrates these before applying rules, but this tool ` +
      `evaluates the real (post-migration) matchers, so those rules will appear to ` +
      `match nothing. Run migrate_config first, then re-run this tool.`,
  ];
}

/**
 * Evaluate `packageRules` against each context and classify the results. The
 * caller passes the same `contexts` it would hand the worker; `suppliedFieldsOf`
 * is applied per context so false-vs-missing-field can be distinguished.
 */
export async function analyzePackageRules(
  packageRules: Record<string, unknown>[],
  contexts: Record<string, unknown>[],
  options: { timeoutMs?: number } = {},
): Promise<PackageRulesAnalysis> {
  const warnings = detectLegacyKeys(packageRules);

  let workerResults: PerContextResult[];
  try {
    workerResults = await runApplyPackageRules(packageRules, contexts, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `Faithful packageRules worker unavailable (${message}); used an approximate ` +
        `glob-only preview that only evaluates matchPackageNames / matchDepNames / ` +
        `matchManagers / matchDatasources / matchFileNames / matchCategories. Run ` +
        `dry_run for authoritative output.`,
    );
    return {
      matchQuality: "preview",
      warnings,
      contexts: contexts.map((ctx) => previewContext(packageRules, ctx)),
    };
  }

  const analysed: ContextAnalysis[] = workerResults.map((res, i) => {
    const supplied = suppliedFieldsOf(contexts[i] ?? {});
    return {
      mergedConfig: res.mergedConfig,
      rules: res.rules.map((ruleResult, index) =>
        classifyRule(ruleResult, packageRules[index] ?? {}, index, supplied),
      ),
    };
  });

  return { matchQuality: "faithful", warnings, contexts: analysed };
}

function classifyRule(
  ruleResult: PerContextResult["rules"][number],
  rule: Record<string, unknown>,
  index: number,
  supplied: Set<string>,
): RuleAnalysis {
  const matchedBy: string[] = [];
  const decidedBy: string[] = [];
  const unevaluatable: MatcherFinding[] = [];

  for (const m of ruleResult.matchers) {
    const meta = MATCHER_META[m.name];
    const key = meta?.key ?? m.name;
    const requiredFields = meta?.requiredAnyOf ?? [];

    if (m.result === "null") continue; // matcher not used by this rule

    if (m.result === "threw") {
      unevaluatable.push({
        matcher: key,
        requiredFields,
        reason: meta?.kind === "mc-api" ? "needs-merge-confidence-api" : "matcher-error",
        ...(m.error ? { error: m.error } : {}),
      });
      continue;
    }

    if (meta?.kind === "jsonata") {
      // JSONata can read any field; its verdict may depend on unsupplied
      // computed context. Surface as advisory regardless of true/false.
      unevaluatable.push({
        matcher: key,
        requiredFields: [],
        reason: "jsonata-may-reference-computed-fields",
      });
      if (m.result === "true") matchedBy.push(key);
      continue;
    }

    if (m.result === "true") {
      matchedBy.push(key);
      continue;
    }

    // result === "false": trustworthy only if a field it reads was supplied.
    const evaluatable = requiredFields.some((f) => supplied.has(f));
    if (evaluatable) {
      decidedBy.push(key);
    } else {
      // The only way to reach here is a missing input field. mc-api matchers
      // (matchConfidence) reach `unevaluatable` via the "threw" branch above —
      // they throw offline rather than returning false — so the
      // "needs-merge-confidence-api" reason belongs there, never here.
      unevaluatable.push({ matcher: key, requiredFields, reason: "missing-input-field" });
    }
  }

  return {
    index,
    rule,
    matched: ruleResult.matched,
    matchedBy,
    decidedBy,
    unevaluatable,
    ...(ruleResult.contributedConfig
      ? { contributedConfig: ruleResult.contributedConfig }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Preview fallback: thin in-process glob-only matcher over the common static
// keys. Deliberately approximate — only reached when the worker is unavailable.
// ---------------------------------------------------------------------------

const PREVIEW_SUPPORTED: Record<string, { field: string; array?: boolean }> = {
  matchPackageNames: { field: "packageName" },
  matchDepNames: { field: "depName" },
  matchManagers: { field: "manager" },
  matchDatasources: { field: "datasource" },
  matchFileNames: { field: "packageFile" },
  matchCategories: { field: "categories", array: true },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globEquals(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const re = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return re.test(value);
}

function globListMatches(patterns: unknown, value: unknown): boolean {
  if (!Array.isArray(patterns) || typeof value !== "string") return false;
  return patterns.some((p) => typeof p === "string" && globEquals(p, value));
}

function previewContext(
  packageRules: Record<string, unknown>[],
  context: Record<string, unknown>,
): ContextAnalysis {
  const supplied = suppliedFieldsOf(context);
  const rules: RuleAnalysis[] = packageRules.map((rule, index) => {
    const matchedBy: string[] = [];
    const decidedBy: string[] = [];
    const unevaluatable: MatcherFinding[] = [];
    let unmatched = false;

    for (const key of Object.keys(rule)) {
      if (!key.startsWith("match") && !key.startsWith("exclude")) continue;
      const supported = PREVIEW_SUPPORTED[key];
      if (!supported) {
        unevaluatable.push({
          matcher: key,
          requiredFields: [],
          reason: "matcher-error",
          error: "not evaluated in preview mode (worker unavailable)",
        });
        continue;
      }
      const value = context[supported.field];
      const ok = supported.array
        ? Array.isArray(value) &&
          value.some((v) => globListMatches(rule[key], v))
        : globListMatches(rule[key], value);
      if (ok) {
        matchedBy.push(key);
      } else if (supplied.has(supported.field)) {
        // Field supplied but didn't match → a trustworthy non-match.
        decidedBy.push(key);
        unmatched = true;
      } else {
        // Field absent → can't decide (same distinction the faithful path makes).
        unevaluatable.push({
          matcher: key,
          requiredFields: [supported.field],
          reason: "missing-input-field",
        });
      }
    }

    // Match only if no supported matcher rejected AND nothing was unevaluatable.
    const matched = !unmatched && unevaluatable.length === 0;
    return {
      index,
      rule,
      matched,
      matchedBy,
      decidedBy,
      unevaluatable,
      ...(matched ? { contributedConfig: stripMatchers(rule) } : {}),
    };
  });

  return { mergedConfig: { ...context }, rules };
}

function stripMatchers(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) {
    if (k.startsWith("match") || k.startsWith("exclude")) continue;
    out[k] = v;
  }
  return out;
}
