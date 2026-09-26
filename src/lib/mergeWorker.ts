import { DEFAULT_WORKER_TIMEOUT_MS, runRenovateWorker } from "./renovateWorker.js";

/**
 * Folds an ordered sequence of configs with Renovate's real `mergeChildConfig()`
 * in a worker thread, isolating the ~20-30 MB main-process cost of importing
 * `renovate/dist/config/utils.js` (which transitively pulls in the manager
 * registry via `getOptions()`). The whole sequence is folded in ONE worker
 * round-trip, so a single resolve_config / explain_config call pays at most one
 * cold start.
 *
 * Same worker-isolation invariant as `migrate_config`: the main process never
 * imports `renovate`.
 *
 * Sequences of length <= 1 are folded in-process (nothing to merge), so the
 * common no-extends / single-preset cases never spawn a worker.
 */

export interface MergeResult {
  merged: Record<string, unknown>;
  /**
   * Present only when `withSteps` is set. `snapshots[i]` is the accumulator
   * after folding `configs[0..i]` — so `snapshots[i-1]` is the state before
   * step `i`, and the last entry equals `merged`. Used by explain_config's
   * diff-based attribution.
   */
  snapshots?: Record<string, unknown>[];
}

/**
 * Worker entry, resolved per call. Overridable via
 * `RENOVATE_MCP_MERGE_WORKER_ENTRY` so the test suite — which loads this module
 * as TS source under `src/`, where the sibling compiled `.js` does not exist —
 * can point at `dist/lib/mergeWorkerImpl.js` (built by the `pretest` script),
 * and so a test can point it at a bogus path to exercise the fallback. In
 * production, `import.meta.url` already resolves to `dist/lib/mergeWorker.js`,
 * so the sibling `.js` is correct.
 */
function workerEntry(): string | URL {
  return (
    process.env.RENOVATE_MCP_MERGE_WORKER_ENTRY ??
    new URL("./mergeWorkerImpl.js", import.meta.url)
  );
}

export interface RunMergeOptions {
  /** Collect cumulative per-step snapshots for diff-based attribution. */
  withSteps?: boolean;
  timeoutMs?: number;
}

export async function runMerge(
  configs: Record<string, unknown>[],
  options: RunMergeOptions = {},
): Promise<MergeResult> {
  // Nothing to merge: fold in-process and skip the worker cold start entirely.
  if (configs.length === 0) {
    return options.withSteps ? { merged: {}, snapshots: [] } : { merged: {} };
  }
  if (configs.length === 1) {
    const only = structuredClone(configs[0]!);
    return options.withSteps
      ? { merged: only, snapshots: [structuredClone(only)] }
      : { merged: only };
  }

  const { merged, snapshots } = await runRenovateWorker<MergeResult>(
    workerEntry(),
    { configs, withSteps: options.withSteps ?? false },
    { timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS, label: "config merge" },
  );
  return snapshots ? { merged, snapshots } : { merged };
}
