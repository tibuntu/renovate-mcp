#!/usr/bin/env node
/**
 * Snapshot Renovate's built-in presets into src/data/presets.generated.ts.
 *
 * The resulting file is committed to git. Runtime code in src/ never imports
 * the renovate package; this script is the one exception (it's a build-time
 * step). Regenerate after bumping the `renovate` devDependency.
 *
 * Source of truth: renovate/dist/config/presets/internal/index.js, which
 * assembles per-namespace preset maps into a `groups` object. We recreate the
 * same namespace → filename mapping here because Renovate doesn't export
 * `groups` publicly.
 */
import {
  generatedHeader,
  refuseIfSymlink,
  renovateVersion,
  snapshotPath,
  writeGenerated,
} from "./_lib.mjs";

const OUT_PATH = snapshotPath("presets.generated.ts");
await refuseIfSymlink(OUT_PATH);

const NAMESPACES = {
  abandonments: "abandonments.preset.js",
  config: "config.preset.js",
  customManagers: "custom-managers.preset.js",
  default: "default.preset.js",
  docker: "docker.preset.js",
  global: "global.preset.js",
  group: "group.preset.js",
  helpers: "helpers.preset.js",
  mergeConfidence: "merge-confidence.preset.js",
  monorepo: "monorepos.preset.js",
  packages: "packages.preset.js",
  preview: "preview.preset.js",
  replacements: "replacements.preset.js",
  schedule: "schedule.preset.js",
  security: "security.preset.js",
  workarounds: "workarounds.preset.js",
};

const entries = {};
for (const [namespace, filename] of Object.entries(NAMESPACES)) {
  const mod = await import(`renovate/dist/config/presets/internal/${filename}`);
  if (!mod.presets) {
    throw new Error(`${filename} has no \`presets\` export`);
  }
  for (const [name, preset] of Object.entries(mod.presets)) {
    const fullName = `${namespace}:${name}`;
    const { description, ...body } = preset;
    // Renovate lets description be `string | string[]` (arrays render as
    // multi-line bullet lists in the docs). Normalize to a single string so
    // consumers don't have to branch.
    const normalized =
      description == null
        ? null
        : Array.isArray(description)
          ? description.join(" ")
          : description;
    entries[fullName] = {
      namespace,
      description: normalized,
      body,
    };
  }
}

const sorted = Object.fromEntries(
  Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
);

const body = `
export interface GeneratedPreset {
  namespace: string;
  description: string | null;
  body: Record<string, unknown>;
}

export const RENOVATE_VERSION = ${JSON.stringify(renovateVersion())};

export const PRESETS: Record<string, GeneratedPreset> = ${JSON.stringify(sorted, null, 2)};

export const PRESET_NAMES: readonly string[] = Object.freeze(Object.keys(PRESETS));
`;

await writeGenerated(
  OUT_PATH,
  generatedHeader("presets") + body,
  `${Object.keys(sorted).length} presets`,
);
