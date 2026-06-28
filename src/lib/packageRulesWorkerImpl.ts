import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker entry point for faithful `packageRules` matching used by
 * `test_package_rules` and `annotate_dry_run`. Imports Renovate's real matcher
 * registry (`renovate/dist/util/package-rules/matchers.js`) plus the merge
 * helpers `applyPackageRules` itself uses, and **replicates `applyPackageRules`'
 * loop** (it does NOT call the function as a black box) — because Renovate's
 * `matchesRule` returns only a boolean and exposes no per-rule / per-matcher
 * provenance, which is exactly what these tools surface (see ADR-0006).
 *
 * The replicated loop reproduces Renovate's exact merge (removeMatchers +
 * overrides applied via compile, mid-loop, + mergeChildConfig), so
 * `mergedConfig` is bit-identical to `applyPackageRules` for
 * matchConfidence-free configs — a
 * property pinned by the parity oracle test. Unlike Renovate's loop we do NOT
 * short-circuit `matchesRule`: every matcher is evaluated so the caller sees the
 * full per-matcher verdict vector, and a matcher that throws (e.g.
 * `matchConfidence` with no merge-confidence credentials) is caught per-matcher
 * as `"threw"` instead of aborting the whole context.
 *
 * Kept deliberately narrow: no logger, no shared state, single request/response.
 * `packageRulesWorker.ts` is the only caller; do not import this from anywhere
 * in the main process.
 */

interface WorkerData {
  packageRules: Record<string, unknown>[];
  contexts: Record<string, unknown>[];
}

type MatcherResultValue = "null" | "true" | "false" | "threw";

interface MatcherResult {
  /** The matcher's class name, e.g. `DepNameMatcher`. */
  name: string;
  result: MatcherResultValue;
  /** Present only when `result === "threw"`. */
  error?: string;
}

interface PerRuleResult {
  /** True iff no applicable matcher returned false and none threw. */
  matched: boolean;
  matchers: MatcherResult[];
  /** The rule's contribution (match/exclude keys stripped, overrides applied). Present only when matched. */
  contributedConfig?: Record<string, unknown>;
}

interface PerContextResult {
  /** Faithful merged config — bit-identical to applyPackageRules for matchConfidence-free configs. */
  mergedConfig: Record<string, unknown>;
  rules: PerRuleResult[];
}

interface Matcher {
  matches: (
    config: Record<string, unknown>,
    rule: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}

const { packageRules, contexts } = workerData as WorkerData;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Mirror of Renovate's `removeMatchers` (dist/util/package-rules/index.js). */
function removeMatchers(rule: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(rule)) {
    if (key.startsWith("match") || key.startsWith("exclude")) delete rule[key];
  }
  return rule;
}

try {
  const matchers = (
    (await import("renovate/dist/util/package-rules/matchers.js")) as {
      default: Matcher[];
    }
  ).default;
  const { mergeChildConfig } = (await import(
    "renovate/dist/config/utils.js"
  )) as {
    mergeChildConfig: (
      parent: Record<string, unknown>,
      child: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
  const { compile } = (await import("renovate/dist/util/template/index.js")) as {
    compile: (template: string, config: Record<string, unknown>) => string;
  };
  const slugify = (
    (await import("slugify")) as {
      default: (input: string, opts?: { lower?: boolean }) => string;
    }
  ).default;

  const results: PerContextResult[] = [];

  for (const context of contexts) {
    // Renovate's applyPackageRules reads `config.packageRules` off the input.
    let config: Record<string, unknown> = { ...context, packageRules };
    const rules: PerRuleResult[] = [];

    for (const rule of packageRules) {
      const matcherResults: MatcherResult[] = [];
      let anyFalse = false;
      let anyThrew = false;

      for (const matcher of matchers) {
        const name = matcher.constructor.name;
        try {
          const verdict = await matcher.matches(config, rule);
          if (verdict === null || verdict === undefined) {
            matcherResults.push({ name, result: "null" });
          } else if (verdict) {
            matcherResults.push({ name, result: "true" });
          } else {
            matcherResults.push({ name, result: "false" });
            anyFalse = true;
          }
        } catch (err) {
          matcherResults.push({
            name,
            result: "threw",
            error: err instanceof Error ? err.message : String(err),
          });
          anyThrew = true;
        }
      }

      const matched = !anyFalse && !anyThrew;
      let contributedConfig: Record<string, unknown> | undefined;

      if (matched) {
        // Replicate the merge in dist/util/package-rules/index.js exactly so
        // `mergedConfig` matches applyPackageRules. Overrides mutate `config`
        // mid-loop, so a later rule sees an earlier rule's overrides.
        const toApply = removeMatchers({ ...rule });
        const force = asRecord(toApply.force);

        if (config.groupSlug && rule.groupName && !rule.groupSlug) {
          toApply.groupSlug = slugify(String(rule.groupName), { lower: true });
        }
        if (
          force?.enabled === false ||
          (toApply.enabled === false && config.enabled !== false)
        ) {
          config.skipReason = "package-rules";
        }
        if (force?.enabled || toApply.enabled) {
          delete config.skipReason;
          delete config.skipStage;
        }
        if (
          typeof toApply.overrideDatasource === "string" &&
          toApply.overrideDatasource !== config.datasource
        ) {
          config.datasource = toApply.overrideDatasource;
        }
        if (
          typeof toApply.overrideDepName === "string" &&
          toApply.overrideDepName !== config.depName
        ) {
          config.depName = compile(toApply.overrideDepName, config);
        }
        if (
          typeof toApply.overridePackageName === "string" &&
          toApply.overridePackageName !== config.packageName
        ) {
          config.packageName = compile(toApply.overridePackageName, config);
        }
        if (typeof toApply.sourceUrl === "string") {
          toApply.sourceUrl = compile(toApply.sourceUrl, config);
        }
        delete toApply.overrideDatasource;
        delete toApply.overrideDepName;
        delete toApply.overridePackageName;

        contributedConfig = structuredClone(toApply);
        config = mergeChildConfig(config, toApply);
      }

      rules.push({
        matched,
        matchers: matcherResults,
        ...(contributedConfig ? { contributedConfig } : {}),
      });
    }

    results.push({ mergedConfig: config, rules });
  }

  parentPort!.postMessage({ ok: true, results });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error: message });
}
