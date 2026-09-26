import { DEFAULT_WORKER_TIMEOUT_MS, runRenovateWorker } from "./renovateWorker.js";

/**
 * Evaluates Renovate's real `packageRules` matchers against one or more
 * dependency contexts in a worker thread, isolating the main-process cost of
 * importing `renovate`'s matcher registry (which transitively pulls in the
 * versioning subsystem, JSONata, etc.). The whole batch is evaluated in ONE
 * worker round-trip, so `annotate_dry_run` with N updates pays at most one cold
 * start.
 *
 * Same worker-isolation invariant as `migrate_config` / the merge worker: the
 * main process never imports `renovate`. See ADR-0006.
 *
 * The worker REPLICATES `applyPackageRules`' loop (rather than calling it as a
 * black box) so it can return per-rule / per-matcher provenance Renovate exposes
 * nowhere; see `packageRulesWorkerImpl.ts`.
 */

export type MatcherResultValue = "null" | "true" | "false" | "threw";

export interface MatcherResult {
  /** The matcher's class name, e.g. `DepNameMatcher`. */
  name: string;
  result: MatcherResultValue;
  /** Present only when `result === "threw"`. */
  error?: string;
}

export interface PerRuleResult {
  /** True iff no applicable matcher returned false and none threw. */
  matched: boolean;
  matchers: MatcherResult[];
  /** The rule's contribution (match/exclude keys stripped, overrides applied). Present only when matched. */
  contributedConfig?: Record<string, unknown>;
}

export interface PerContextResult {
  /** Faithful merged config — bit-identical to applyPackageRules for matchConfidence-free configs. */
  mergedConfig: Record<string, unknown>;
  rules: PerRuleResult[];
}

/**
 * Worker entry, resolved per call. Overridable via
 * `RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY` so the test suite — which loads this
 * module as TS source under `src/`, where the sibling compiled `.js` does not
 * exist — can point at `dist/lib/packageRulesWorkerImpl.js` (built by `pretest`),
 * and so a test can point it at a bogus path to exercise the fallback. In
 * production, `import.meta.url` already resolves to `dist/lib/`.
 */
function workerEntry(): string | URL {
  return (
    process.env.RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY ??
    new URL("./packageRulesWorkerImpl.js", import.meta.url)
  );
}

export interface RunPackageRulesOptions {
  timeoutMs?: number;
}

/**
 * Evaluate `packageRules` against each of `contexts`, returning one result per
 * context (faithful merged config + per-rule provenance). Throws
 * `WorkerTimeoutError` on timeout or a plain Error on worker failure — the
 * caller (packageRulesAnalysis) catches and degrades to a preview fallback.
 */
export async function runApplyPackageRules(
  packageRules: Record<string, unknown>[],
  contexts: Record<string, unknown>[],
  options: RunPackageRulesOptions = {},
): Promise<PerContextResult[]> {
  // Nothing to evaluate: skip the worker cold start entirely. With no rules,
  // every context's merged config is itself and no rule matched.
  if (contexts.length === 0) return [];
  if (packageRules.length === 0) {
    return contexts.map((ctx) => ({
      mergedConfig: { ...ctx, packageRules: [] },
      rules: [],
    }));
  }

  const { results } = await runRenovateWorker<{ results: PerContextResult[] }>(
    workerEntry(),
    { packageRules, contexts },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      label: "packageRules evaluation",
    },
  );
  return results;
}
