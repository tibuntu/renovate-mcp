// Renovate doesn't ship .d.ts for its individual subpath exports. We only
// reach into `dist/config/migration.js` from a worker thread (see
// `docs/adr/0001-worker-isolated-renovate-migration.md`); this shim gives
// `tsc` a typed signature for that one entry point.
declare module "renovate/dist/config/migration.js" {
  export function migrateConfig(
    config: Record<string, unknown>,
    parentKey?: string,
  ): {
    isMigrated: boolean;
    migratedConfig: Record<string, unknown>;
  };
}
