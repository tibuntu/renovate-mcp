#!/usr/bin/env node
/**
 * Snapshot Renovate's deprecated config keys into
 * src/data/migrations.generated.ts.
 *
 * The resulting file is committed to git. Runtime code in src/ never imports
 * the renovate package; this script is the one exception (it's a build-time
 * step). Regenerate after bumping the `renovate` devDependency.
 *
 * Sources of truth, both static members of `MigrationsService`:
 *   - `renamedProperties` — `Map<oldKey, newKey>` of plain renames; emitted
 *     with `newKey`.
 *   - `customMigrations` — the class list of value coercions and structural
 *     rewrites. Each is instantiated with empty configs and emitted (without
 *     `newKey`) when it is flagged `deprecated` and its `propertyName` is a
 *     string (two migrations match a RegExp of keys and are skipped).
 * lint_config flags every entry; migrate_config shows the replacement.
 */
import {
  generatedHeader,
  refuseIfSymlink,
  renovateVersion,
  snapshotPath,
  writeGenerated,
} from "./_lib.mjs";

const OUT_PATH = snapshotPath("migrations.generated.ts");
await refuseIfSymlink(OUT_PATH);

const { MigrationsService } = await import(
  "renovate/dist/config/migrations/migrations-service.js"
);

const byOldKey = new Map(
  [...MigrationsService.renamedProperties.entries()].map(([oldKey, newKey]) => [
    oldKey,
    { oldKey, newKey },
  ]),
);
for (const CustomMigration of MigrationsService.customMigrations) {
  const migration = new CustomMigration({}, {});
  if (migration.deprecated !== true || typeof migration.propertyName !== "string") continue;
  if (!byOldKey.has(migration.propertyName)) {
    byOldKey.set(migration.propertyName, { oldKey: migration.propertyName });
  }
}
const entries = [...byOldKey.values()].sort((a, b) =>
  a.oldKey.localeCompare(b.oldKey),
);

const body = `
export const RENOVATE_VERSION = ${JSON.stringify(renovateVersion())};

export interface DeprecatedKeyEntry {
  /** Key as it appeared in old configs. */
  readonly oldKey: string;
  /** Current key that replaces it — plain renames only; custom migrations omit it. */
  readonly newKey?: string;
}

/**
 * Deprecated config keys. Sourced from Renovate's \`MigrationsService\`:
 * \`renamedProperties\` (plain renames, with \`newKey\`) plus every
 * \`customMigrations\` class flagged \`deprecated\` (value coercions such as
 * \`stabilityDays\` → \`minimumReleaseAge\`, structural rewrites such as
 * \`fileMatch\` → \`managerFilePatterns\`; no \`newKey\` — \`migrate_config\`
 * shows the replacement).
 */
export const DEPRECATED_KEYS: readonly DeprecatedKeyEntry[] = Object.freeze(${JSON.stringify(entries, null, 2)});
`;

await writeGenerated(
  OUT_PATH,
  generatedHeader("migrations") + body,
  `${entries.length} deprecated keys`,
);
