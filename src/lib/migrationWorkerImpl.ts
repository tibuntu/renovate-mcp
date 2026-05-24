import { parentPort, workerData } from "node:worker_threads";

/**
 * Worker entry point for `migrate_config`. Imports Renovate's migration
 * library inside the worker thread — see ADR
 * `docs/adr/0001-worker-isolated-renovate-migration.md`. Kept deliberately
 * narrow: no logger, no shared state, single request/response.
 *
 * `migrationWorker.ts` is the only caller; do not import this from anywhere
 * in the main process.
 */

interface WorkerData {
  config: Record<string, unknown>;
}

const { config } = workerData as WorkerData;

try {
  const { migrateConfig } = await import("renovate/dist/config/migration.js");
  const { isMigrated, migratedConfig } = migrateConfig(config) as {
    isMigrated: boolean;
    migratedConfig: Record<string, unknown>;
  };
  parentPort!.postMessage({ ok: true, isMigrated, migratedConfig });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error: message });
}
