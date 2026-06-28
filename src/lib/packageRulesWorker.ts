import { Worker } from "node:worker_threads";

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

type WorkerResponse =
  | { ok: true; results: PerContextResult[] }
  | { ok: false; error: string };

// First-call latency budget: ESM cold-load of renovate's matcher registry (which
// pulls in the versioning subsystem) can take a couple of seconds on slow CI.
// Each call spawns a fresh worker, so this budget covers the cold path.
const DEFAULT_TIMEOUT_MS = 30_000;

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

export class PackageRulesTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Renovate packageRules worker exceeded ${timeoutMs}ms`);
    this.name = "PackageRulesTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface RunPackageRulesOptions {
  timeoutMs?: number;
}

/**
 * Evaluate `packageRules` against each of `contexts`, returning one result per
 * context (faithful merged config + per-rule provenance). Throws
 * `PackageRulesTimeoutError` on timeout or a plain Error on worker failure — the
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const worker = new Worker(workerEntry(), {
    workerData: { packageRules, contexts },
    // Isolate the worker's stdio — importing renovate pulls in its logger, and
    // nothing from the worker may leak onto the parent's stdout JSON-RPC channel.
    stdout: true,
    stderr: true,
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await new Promise<WorkerResponse | "timeout">(
      (resolve, reject) => {
        // First event wins. The `exit` handler must reject when it fires before
        // a message/error/timeout — a worker that crashes or exits before
        // posting would otherwise leave the promise pending until the timeout.
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
                `packageRules worker exited (code ${code}) before returning a result`,
              ),
            ),
          ),
        );
      },
    );

    if (response === "timeout") {
      throw new PackageRulesTimeoutError(timeoutMs);
    }
    if (!response.ok) {
      throw new Error(`Renovate packageRules evaluation failed: ${response.error}`);
    }
    return response.results;
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}
