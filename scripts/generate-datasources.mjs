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

const body = `
export const RENOVATE_VERSION = ${JSON.stringify(renovateVersion())};

/**
 * All built-in datasource ids accepted by Renovate's \`matchDatasources\` and
 * \`customManagers[].datasourceTemplate\`. Custom datasources (\`custom.<name>\`)
 * are not listed.
 */
export const DATASOURCES: readonly string[] = Object.freeze(${JSON.stringify(datasources, null, 2)});
`;

await writeGenerated(
  OUT_PATH,
  generatedHeader("datasources") + body,
  `${datasources.length} datasources`,
);
