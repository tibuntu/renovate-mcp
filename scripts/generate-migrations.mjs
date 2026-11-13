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
 * Plus the flat Dependency Dashboard options (`dependencyDashboardTitle`, …),
 * emitted with their `dependencyDashboard.<field>` target. Rename chains are
 * followed to the final key.
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
// `DependencyDashboardMigration` matches a RegExp and isn't flagged
// `deprecated` (it keeps `dependencyDashboard` itself), but it moves each flat
// option into a field of the `dependencyDashboard` object. Its exported map
// names them; a missing export fails the generator instead of dropping them.
const { flatDependencyDashboardOptions } = await import(
  "renovate/dist/config/migrations/custom/dependency-dashboard-migration.js"
);
if (!flatDependencyDashboardOptions) {
  throw new Error("renovate no longer exports flatDependencyDashboardOptions");
}
for (const [oldKey, { field }] of Object.entries(flatDependencyDashboardOptions)) {
  byOldKey.set(oldKey, { oldKey, newKey: `dependencyDashboard.${field}` });
}
// Follow rename chains (masterIssueTitle → dependencyDashboardTitle →
// dependencyDashboard.title) so a finding never suggests another deprecated
// key. A chain ending in a custom migration keeps no `newKey`.
for (const entry of byOldKey.values()) {
  const seen = new Set([entry.oldKey]);
  while (entry.newKey !== undefined && byOldKey.has(entry.newKey) && !seen.has(entry.newKey)) {
    seen.add(entry.newKey);
    const next = byOldKey.get(entry.newKey).newKey;
    if (next === undefined) delete entry.newKey;
    else entry.newKey = next;
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
