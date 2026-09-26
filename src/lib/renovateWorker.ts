import { Worker } from "node:worker_threads";

/**
 * Shared driver for the worker-isolated Renovate carve-outs (`migrationWorker`,
 * `mergeWorker`, `packageRulesWorker` — ADR-0001 / 0004 / 0006). Spawns
 * `entry` with `workerData`, resolves with the single `{ ok: true, ... }`
 * message the worker posts, and always terminates the worker afterwards. The
 * main process never imports `renovate`; only the `*WorkerImpl` entries do.
 *
 * The worker's stdio is captured (and never read): importing renovate pulls in
 * its logger, which can emit notes before init, and the MCP server speaks
 * JSON-RPC over stdout, so nothing from the worker may leak onto the parent's
 * descriptors.
 */

// First-call latency budget: ESM cold-load of renovate's module graph in the
// worker can take a couple of seconds on slow CI. Each call spawns a fresh
// worker, so this budget covers the cold path.
export const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

export class WorkerTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`Renovate ${label} worker exceeded ${timeoutMs}ms`);
    this.name = "WorkerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface RunWorkerOptions {
  timeoutMs: number;
  /** Human-readable name used in error messages, e.g. `config merge`. */
  label: string;
}

type WorkerReply<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Throws `WorkerTimeoutError` on timeout, and a plain Error when the worker
 * posts `{ ok: false }`, throws, or exits before posting — callers catch and
 * degrade to their preview fallback.
 */
export async function runRenovateWorker<T extends object>(
  entry: string | URL,
  workerData: unknown,
  { timeoutMs, label }: RunWorkerOptions,
): Promise<T> {
  const worker = new Worker(entry, { workerData, stdout: true, stderr: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await new Promise<WorkerReply<T>>((resolve, reject) => {
      // First event wins. `exit` must reject when it fires before a
      // message/error/timeout — a worker that crashes or exits before posting
      // (e.g. a load-time failure) would otherwise leave the promise pending
      // until the timeout instead of degrading promptly.
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      timer = setTimeout(
        () => settle(() => reject(new WorkerTimeoutError(label, timeoutMs))),
        timeoutMs,
      );
      worker.once("message", (msg: WorkerReply<T>) => settle(() => resolve(msg)));
      worker.once("error", (err) => settle(() => reject(err)));
      worker.once("exit", (code) =>
        settle(() =>
          reject(
            new Error(`Renovate ${label} worker exited (code ${code}) before returning a result`),
          ),
        ),
      );
    });
    if (!reply.ok) throw new Error(`Renovate ${label} failed: ${reply.error}`);
    return reply;
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}
