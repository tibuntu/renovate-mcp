#!/usr/bin/env node
/**
 * Snapshot Renovate's datasource registry into src/data/datasources.generated.ts.
 *
 * The resulting file is committed to git. Runtime code in src/ never imports
 * the renovate package; this script is the one exception (it's a build-time
 * step). Regenerate after bumping the `renovate` devDependency.
 *
 * Source of truth: renovate/dist/modules/datasource/index.js, which exports
 * `getDatasourceList()` (the sorted list of built-in datasource ids). User
 * custom datasources are referenced as `custom.<name>`; the linter accepts
 * that prefix on its own.
 */
import {
  generatedHeader,
  refuseIfSymlink,
  renovateVersion,
  snapshotPath,
  writeGenerated,
} from "./_lib.mjs";

const OUT_PATH = snapshotPath("datasources.generated.ts");
await refuseIfSymlink(OUT_PATH);

const datasourceModule = await import("renovate/dist/modules/datasource/index.js");

const datasources = [...datasourceModule.getDatasourceList()].sort();

// Datasources that declare `releaseTimestampSupport = false` but still emit a
// `releaseTimestamp`, so a `minimumReleaseAge` works on them. Excluded from the
// `release-age-without-timestamp` lint list. `test/unit/datasourceTimestampDrift.test.ts`
// re-checks this against Renovate's dist source on every bump.
const EMITS_TIMESTAMP_DESPITE_FLAG = [
  "custom", // custom/schema.js: MaybeTimestamp, user-supplied via the transform
  "nextcloud", // nextcloud/index.js: asTimestamp(release.created)
  "python-version", // python-version/schema.js: release_date
  "typst", // typst/schema.js: asTimestamp(updatedAt)
  "unity3d-packages", // unity3d-packages/index.js: asTimestamp(response.body.time[...])
];

const withoutTimestamp = [...datasourceModule.getDatasources()]
  .filter(([id, ds]) => ds.releaseTimestampSupport !== true && !EMITS_TIMESTAMP_DESPITE_FLAG.includes(id))
  .map(([id]) => id)
  .sort();

const body = `
export const RENOVATE_VERSION = ${JSON.stringify(renovateVersion())};

/**
 * All built-in datasource ids accepted by Renovate's \`matchDatasources\` and
 * \`customManagers[].datasourceTemplate\`. Custom datasources (\`custom.<name>\`)
 * are not listed.
 */
export const DATASOURCES: readonly string[] = Object.freeze(${JSON.stringify(datasources, null, 2)});

/**
 * Datasources that never report a release timestamp (\`releaseTimestampSupport\`
 * is \`false\` and none of their source emits one). Datasources with partial
 * support (docker, terraform-*) are deliberately absent: only a certain miss is listed.
 */
export const DATASOURCES_WITHOUT_RELEASE_TIMESTAMP: readonly string[] = Object.freeze(${JSON.stringify(withoutTimestamp, null, 2)});

/**
 * Ids flagged \`releaseTimestampSupport = false\` that nevertheless emit a
 * timestamp, so they are kept out of the list above. Drift-checked in tests.
 */
export const RELEASE_TIMESTAMP_EXCLUSIONS: readonly string[] = Object.freeze(${JSON.stringify(EMITS_TIMESTAMP_DESPITE_FLAG, null, 2)});
`;

await writeGenerated(
  OUT_PATH,
  generatedHeader("datasources") + body,
  `${datasources.length} datasources`,
);
