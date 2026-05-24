import { Worker } from "node:worker_threads";

/**
 * Runs Renovate's `migrateConfig()` in a worker thread, isolating the
 * ~20-30 MB main-process cost of importing `renovate/dist/config/migration.js`
 * (which transitively pulls in the entire manager registry via `getOptions()`).
 *
 * See `docs/adr/0001-worker-isolated-renovate-migration.md` for the rationale.
 * Mirrors the worker shape used by `customManagerPreview.ts`, but uses a
 * compiled sibling file (`migrationWorkerImpl.js`) instead of inline-eval
 * source because the worker needs to resolve a bare module specifier
 * (`renovate/...`), which data-URL workers cannot do.
 */

export interface MigrationResult {
  isMigrated: boolean;
  migratedConfig: Record<string, unknown>;
}

type WorkerResponse =
  | { ok: true; isMigrated: boolean; migratedConfig: Record<string, unknown> }
  | { ok: false; error: string };

// First-call latency budget: ESM cold-load of renovate's module graph in the
// worker can take a couple of seconds on slow CI. Subsequent calls (if we ever
// switch to a long-lived worker) would be much faster, but each call spawns a
// fresh worker today, so this budget covers the cold path.
const DEFAULT_TIMEOUT_MS = 30_000;

const WORKER_ENTRY = new URL("./migrationWorkerImpl.js", import.meta.url);

export class MigrationTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Renovate migration worker exceeded ${timeoutMs}ms`);
    this.name = "MigrationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function runMigration(
  config: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<MigrationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const worker = new Worker(WORKER_ENTRY, { workerData: { config } });

  let timer: NodeJS.Timeout | undefined;
  try {
    const response = await new Promise<WorkerResponse | "timeout">(
      (resolve, reject) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        worker.once("message", (msg: WorkerResponse) => resolve(msg));
        worker.once("error", (err) => reject(err));
        worker.once("exit", (code) => {
          if (code !== 0 && code !== 1) {
            reject(
              new Error(`Migration worker exited unexpectedly with code ${code}`),
            );
          }
        });
      },
    );

    if (response === "timeout") {
      throw new MigrationTimeoutError(timeoutMs);
    }
    if (!response.ok) {
      throw new Error(`Renovate migration failed: ${response.error}`);
    }
    return {
      isMigrated: response.isMigrated,
      migratedConfig: response.migratedConfig,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}
