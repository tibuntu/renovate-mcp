import { Worker } from "node:worker_threads";

/**
 * Folds an ordered sequence of configs with Renovate's real `mergeChildConfig()`
 * in a worker thread, isolating the ~20-30 MB main-process cost of importing
 * `renovate/dist/config/utils.js` (which transitively pulls in the manager
 * registry via `getOptions()`). The whole sequence is folded in ONE worker
 * round-trip, so a single resolve_config / explain_config call pays at most one
 * cold start.
 *
 * Same worker-isolation invariant as `migrate_config`: the main process never
 * imports `renovate`. See
 * `docs/adrs/0004-worker-isolated-faithful-config-merge.md`.
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

type WorkerResponse =
  | {
      ok: true;
      merged: Record<string, unknown>;
      snapshots?: Record<string, unknown>[];
    }
  | { ok: false; error: string };

// First-call latency budget: ESM cold-load of renovate's module graph in the
// worker can take a couple of seconds on slow CI. Each call spawns a fresh
// worker today, so this budget covers the cold path.
const DEFAULT_TIMEOUT_MS = 30_000;

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

export class MergeTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Renovate config merge worker exceeded ${timeoutMs}ms`);
    this.name = "MergeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const withSteps = options.withSteps ?? false;
  const worker = new Worker(workerEntry(), {
    workerData: { configs, withSteps },
    // Isolate the worker's stdio. Importing renovate pulls in its logger, which
    // can emit "logger not initialized" notes. The MCP server speaks JSON-RPC
    // over stdout, so nothing from the worker may leak onto the parent's stdout
    // (and the stderr notes are just noise). Capturing both streams here keeps
    // them off the parent's descriptors; we never read them, so they're dropped.
    stdout: true,
    stderr: true,
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await new Promise<WorkerResponse | "timeout">(
      (resolve, reject) => {
        // First event wins. The `exit` handler must reject when it fires before
        // a message/error/timeout — a worker that crashes or exits before
        // posting (e.g. a load-time failure) would otherwise leave the promise
        // pending until the timeout instead of degrading promptly.
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        timer = setTimeout(() => settle(() => resolve("timeout")), timeoutMs);
        worker.once("message", (msg: WorkerResponse) =>
          settle(() => resolve(msg)),
        );
        worker.once("error", (err) => settle(() => reject(err)));
        worker.once("exit", (code) =>
          settle(() =>
            reject(
              new Error(
                `Merge worker exited (code ${code}) before returning a result`,
              ),
            ),
          ),
        );
      },
    );

    if (response === "timeout") {
      throw new MergeTimeoutError(timeoutMs);
    }
    if (!response.ok) {
      throw new Error(`Renovate config merge failed: ${response.error}`);
    }
    return response.snapshots
      ? { merged: response.merged, snapshots: response.snapshots }
      : { merged: response.merged };
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}
