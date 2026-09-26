import { DEFAULT_WORKER_TIMEOUT_MS, runRenovateWorker } from "./renovateWorker.js";

/**
 * Runs Renovate's `migrateConfig()` in a worker thread, isolating the
 * ~20-30 MB main-process cost of importing `renovate/dist/config/migration.js`
 * (which transitively pulls in the entire manager registry via `getOptions()`).
 *
 * See `docs/adr/0001-worker-isolated-renovate-migration.md` for the rationale.
 * Uses a compiled sibling file (`migrationWorkerImpl.js`) instead of the
 * inline-eval source `customManagerPreview.ts` uses, because the worker needs
 * to resolve a bare module specifier (`renovate/...`), which data-URL workers
 * cannot do.
 */

export interface MigrationResult {
  isMigrated: boolean;
  migratedConfig: Record<string, unknown>;
}

/**
 * Worker entry, resolved per call. Overridable via
 * `RENOVATE_MCP_MIGRATION_WORKER_ENTRY` so a test can point it at a fixture. In
 * production, `import.meta.url` resolves to `dist/lib/migrationWorker.js`, so
 * the sibling `.js` is correct.
 */
function workerEntry(): string | URL {
  return (
    process.env.RENOVATE_MCP_MIGRATION_WORKER_ENTRY ??
    new URL("./migrationWorkerImpl.js", import.meta.url)
  );
}

export async function runMigration(
  config: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<MigrationResult> {
  const { isMigrated, migratedConfig } = await runRenovateWorker<MigrationResult>(
    workerEntry(),
    { config },
    { timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS, label: "migration" },
  );
  return { isMigrated, migratedConfig };
}
