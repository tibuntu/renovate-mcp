#!/usr/bin/env node
/**
 * Snapshot Renovate's config option registry into src/data/options.generated.ts.
 *
 * The resulting file is committed to git. Runtime code in src/ never imports
 * the renovate package; this script is the one exception (it's a build-time
 * step). Regenerate after bumping the `renovate` devDependency.
 *
 * Source of truth: renovate/dist/config/options/index.js, which exports
 * `getOptions()` — an array of option definition objects. We snapshot only a
 * fixed subset of fields (see ALLOWED_KEYS below); unlisted fields (e.g.
 * `mergeable`, `patternMatch`, `additionalProperties`, `freeChoice`) are
 * intentionally dropped as not needed by the `renovate://option/{name}`
 * resource.
 */
import {
  generatedHeader,
  refuseIfSymlink,
  renovateVersion,
  snapshotPath,
  writeGenerated,
} from "./_lib.mjs";

const OUT_PATH = snapshotPath("options.generated.ts");
await refuseIfSymlink(OUT_PATH);

const optionsModule = await import("renovate/dist/config/options/index.js");
const allOptions = optionsModule.getOptions();

// Fields to keep, in the order they'll appear in the generated object
// literal. `name` is handled separately — it becomes the record key.
const ALLOWED_KEYS = [
  "description",
  "type",
  "subType",
  "default",
  "allowedValues",
  "globalOnly",
  "supportedManagers",
  "supportedPlatforms",
  "experimental",
  "experimentalDescription",
  "deprecationMsg",
  "parents",
  "stage",
  "advancedUse",
  "cli",
  "env",
];

const entries = {};
for (const opt of allOptions) {
  const snapshot = {};
  for (const key of ALLOWED_KEYS) {
    if (opt[key] !== undefined) snapshot[key] = opt[key];
  }
  entries[opt.name] = snapshot;
}

const sorted = Object.fromEntries(
  Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
);

const body = `
export interface GeneratedOption {
  description?: string;
  type?: string;
  subType?: string;
  default?: unknown;
  allowedValues?: readonly unknown[];
  globalOnly?: boolean;
  supportedManagers?: readonly string[];
  supportedPlatforms?: readonly string[];
  experimental?: boolean;
  experimentalDescription?: string;
  deprecationMsg?: string;
  parents?: readonly string[];
  stage?: string;
  advancedUse?: boolean;
  cli?: boolean;
  env?: boolean;
}

export const RENOVATE_VERSION = ${JSON.stringify(renovateVersion())};

export const OPTIONS: Record<string, GeneratedOption> = ${JSON.stringify(sorted, null, 2)};

export const OPTION_NAMES: readonly string[] = Object.freeze(Object.keys(OPTIONS));
`;

await writeGenerated(
  OUT_PATH,
  generatedHeader("options") + body,
  `${Object.keys(sorted).length} options`,
);
