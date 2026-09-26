import { promises as fs } from "node:fs";
import path from "node:path";
import { locateConfig } from "./configLocations.js";

// Input rules shared by every tool (documented under "Common input rules" in
// docs/tools.md). Each helper returns an error message rather than an MCP
// result so the tools keep one `{ isError, content }` shape at the call site.

/** Null when `repoPath` is an absolute path to an existing directory, else the error text. */
export async function assertRepoDir(repoPath: string): Promise<string | null> {
  const stat = path.isAbsolute(repoPath) ? await fs.stat(repoPath).catch(() => null) : null;
  return stat?.isDirectory()
    ? null
    : `repoPath must be an absolute path to an existing directory (got: ${repoPath})`;
}

export interface ConfigSource {
  config: Record<string, unknown>;
  /** Repo-relative path of the located file; absent for inline content. */
  path?: string;
}

/** A tool's config source: inline `configContent`, or the config located under `repoPath`. */
export async function loadConfigSource(input: {
  repoPath?: string;
  configContent?: Record<string, unknown>;
}): Promise<ConfigSource | { error: string }> {
  const { repoPath, configContent } = input;
  // Presence, not truthiness: an empty repoPath is a bad path, not a missing one.
  if (repoPath !== undefined && configContent !== undefined) {
    return { error: "Pass either repoPath or configContent, not both." };
  }
  if (configContent !== undefined) return { config: configContent };
  if (repoPath === undefined) return { error: "Provide either repoPath or configContent." };
  const repoError = await assertRepoDir(repoPath);
  if (repoError) return { error: repoError };
  const located = await locateConfig(repoPath);
  if (!located) return { error: `No Renovate configuration found in ${repoPath}.` };
  return { config: located.config, path: located.relPath };
}

// `disclaimer` texts. The preview ones are shared by every tool on the same
// worker (merge worker: resolve_config / explain_config; matcher worker:
// test_package_rules / annotate_dry_run); the faithful ones are per tool.

export const MERGE_PREVIEW_DISCLAIMER =
  "The faithful merge worker was unavailable, so this used a simplified in-process merge (arrays concat, objects merge, scalars overwrite) — see warnings. Run dry_run for authoritative output.";
export const MATCH_PREVIEW_DISCLAIMER =
  "The faithful matcher worker was unavailable, so this used an approximate glob-only preview (matchPackageNames / matchDepNames / matchManagers / matchDatasources / matchFileNames / matchCategories only); rules using any other matcher are reported as unevaluatable. Run dry_run for authoritative output.";

export const RESOLVE_CONFIG_FAITHFUL_DISCLAIMER =
  "Presets are merged with Renovate's own mergeChildConfig (run in a worker thread), so array/object merge semantics are faithful. Handlebars expressions other than positional {{argN}} are still left verbatim, and resolve_config does not run datasource lookups — run dry_run for full config resolution.";
export const EXPLAIN_CONFIG_FAITHFUL_DISCLAIMER =
  "Provenance is reconstructed from Renovate's own mergeChildConfig (run in a worker thread), so leaf values match resolve_config exactly. A preset that re-asserts an already-set value is not listed as a separate contributor — attribution credits whoever changed the value. Handlebars other than {{argN}} is left verbatim; run dry_run for full config resolution.";
export const TEST_PACKAGE_RULES_FAITHFUL_DISCLAIMER =
  "Rules are evaluated with Renovate's real matchers (run in a worker thread), so match decisions are faithful for the fields you supplied. Matchers needing post-lookup data you didn't supply (matchUpdateTypes, matchCurrentVersion, matchNewValue, matchCurrentAge) or the merge-confidence API (matchConfidence) are reported under `unevaluatable`, NOT as non-matches. matchJsonata results are advisory (the expression may read fields you didn't supply). Run dry_run for full-fidelity resolution.";
export const ANNOTATE_DRY_RUN_FAITHFUL_DISCLAIMER =
  "Each update is attributed using Renovate's real matchers (run in a worker thread) against the facts present in the dry_run report. Matchers needing data the report doesn't carry are reported under each update's `unevaluatable` and aggregated in `fieldGaps`, NOT as non-matches. matchConfidence needs the merge-confidence API (unevaluatable offline); matchJsonata is advisory. Run dry_run for full-fidelity resolution.";
