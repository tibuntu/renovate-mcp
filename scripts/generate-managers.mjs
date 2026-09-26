#!/usr/bin/env node
/**
 * Snapshot Renovate's manager registry into src/data/managers.generated.ts.
 *
 * The resulting file is committed to git. Runtime code in src/ never imports
 * the renovate package; this script is the one exception (it's a build-time
 * step). Regenerate after bumping the `renovate` devDependency.
 *
 * Source of truth: renovate/dist/modules/manager/index.js, which exports
 * `allManagersList` (regular + custom managers). `matchManagers` accepts both
 * a bare custom-manager name (e.g. `regex`) and the `custom.`-prefixed form
 * (e.g. `custom.regex`); we record the bare list and let the linter handle
 * the prefix.
 */
import {
  generatedHeader,
  refuseIfSymlink,
  renovateVersion,
  snapshotPath,
  writeGenerated,
} from "./_lib.mjs";

const OUT_PATH = snapshotPath("managers.generated.ts");
await refuseIfSymlink(OUT_PATH);

const managerModule = await import("renovate/dist/modules/manager/index.js");
const customModule = await import("renovate/dist/modules/manager/custom/index.js");

const allManagers = [...managerModule.allManagersList].sort();
const customManagers = [...customModule.customManagerList].sort();

const body = `
export const RENOVATE_VERSION = ${JSON.stringify(renovateVersion())};

/**
 * All manager names accepted by Renovate's \`matchManagers\` /
 * \`excludeManagers\` fields. Includes both regular managers and custom
 * managers (which may also be referenced with a \`custom.\` prefix).
 */
export const ALL_MANAGERS: readonly string[] = Object.freeze(${JSON.stringify(allManagers, null, 2)});

/**
 * Custom manager names. Each of these may also be referenced as
 * \`custom.<name>\` in \`matchManagers\` / \`excludeManagers\`.
 */
export const CUSTOM_MANAGERS: readonly string[] = Object.freeze(${JSON.stringify(customManagers, null, 2)});
`;

await writeGenerated(
  OUT_PATH,
  generatedHeader("managers") + body,
  `${allManagers.length} managers (${customManagers.length} custom)`,
);
