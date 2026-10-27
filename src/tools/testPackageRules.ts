import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  analyzePackageRules,
  resolvePackageRules,
  toMatchedRule,
} from "../lib/packageRulesAnalysis.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";
import { FETCH_PLATFORMS } from "../lib/presetResolver.js";
import {
  loadConfigSource,
  MATCH_PREVIEW_DISCLAIMER,
  RENDER_PREVIEW_DISCLAIMER,
  TEST_PACKAGE_RULES_FAITHFUL_DISCLAIMER,
  NETWORK_READ_ONLY_ANNOTATIONS,
} from "../lib/toolInputs.js";

const optString = (description: string) => z.string().max(2048).optional().describe(description);
const optStringArray = (description: string) =>
  z.array(z.string().max(2048)).max(256).optional().describe(description);

export function registerTestPackageRules(server: McpServer): void {
  server.registerTool(
    "test_package_rules",
    {
      title: "Test which packageRules match a dependency",
      annotations: NETWORK_READ_ONLY_ANNOTATIONS,
      description:
        "Offline \"what-if\": given a hypothetical dependency context and a config, report which `packageRules` match (in order), which matcher decided each, and what each matched rule contributes. Answers \"why didn't my rule match?\". Rules are evaluated with Renovate's REAL matchers in a worker thread (faithful), classified against the fields you actually supplied — a matcher that needs a field you didn't pass is reported as `unevaluatable`, never silently treated as a non-match. Matchers needing post-lookup data (matchUpdateTypes, matchCurrentVersion, matchNewValue, matchCurrentAge) or the merge-confidence API (matchConfidence) are unevaluatable offline; matchJsonata is advisory. Pass either `repoPath` (reads + expands the repo's config) or `configContent` (an inline config); `externalPresets`/`endpoint`/`platform` opt into external preset expansion so `extends`-provided rules are included (same semantics as resolve_config). Deprecated matcher keys (matchPackagePatterns, …) are warned about — run migrate_config first. Also renders the effective branchName / commitMessage / prTitle (and groupName) for the synthetic dependency under `rendered` — a preview built from the fields you supplied, which lists the post-lookup template variables it could not fill. Run dry_run for full-fidelity confirmation.",
      inputSchema: {
        repoPath: pathString(
          "Absolute path to the repository root. The tool locates and expands the repo's renovate config automatically.",
        ).optional(),
        configContent: configRecord(
          "Inline config object whose packageRules to test — use instead of repoPath.",
        ).optional(),
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>, gitea>, forgejo>) over HTTPS so their packageRules are included — same credentials/behaviour as resolve_config. Default false.",
          ),
        endpoint: endpointString(
          "API base URL for external preset fetches — same semantics as resolve_config.",
        ).optional(),
        platform: z
          .enum(FETCH_PLATFORMS)
          .optional()
          .describe("Platform flavour of `endpoint` — same semantics as resolve_config."),
        // Synthetic dependency context. All optional; supply what you're testing.
        depName: optString("Dependency name (matchDepNames; static)."),
        packageName: optString("Fully-qualified package name (matchPackageNames; static)."),
        datasource: optString("Datasource, e.g. npm/docker/github-releases (matchDatasources; static)."),
        manager: optString("Manager, e.g. npm/dockerfile (matchManagers; static)."),
        depType: optString("Dependency type, e.g. dependencies/devDependencies (matchDepTypes; static)."),
        depTypes: optStringArray("Multiple dependency types (matchDepTypes; static)."),
        currentValue: optString("Current version constraint from the file, e.g. ^1.2.0 (matchCurrentValue; static)."),
        currentVersion: optString("Resolved current version, e.g. 1.2.3 (matchCurrentVersion; normally known only after a datasource lookup)."),
        lockedVersion: optString("Locked version from a lockfile (matchCurrentVersion; post-lookup)."),
        versioning: optString("Versioning scheme, e.g. npm/semver/docker (affects matchCurrentVersion)."),
        packageFile: optString("Package file path (matchFileNames; static)."),
        lockFiles: optStringArray("Lock file paths (matchFileNames; static)."),
        categories: optStringArray("Manager categories, e.g. js/docker (matchCategories; static)."),
        repository: optString("Repository slug, e.g. owner/repo (matchRepositories; static)."),
        baseBranch: optString("Base branch name (matchBaseBranches; static)."),
        registryUrls: optStringArray("Registry URLs (matchRegistryUrls; static)."),
        sourceUrl: optString("Source repository URL (matchSourceUrls; static)."),
        newValue: optString("Proposed new version constraint (matchNewValue; post-lookup)."),
        newVersion: optString("Resolved new version, e.g. 5.0.0 (templates only: fills newMajor/newMinor/newPatch in the rendered names; defaults to newValue when that is a single version)."),
        updateType: optString("Update type: major/minor/patch/pin/digest/… (matchUpdateTypes; post-lookup)."),
        isBump: z.boolean().optional().describe("Whether this is a range bump (matchUpdateTypes; post-lookup)."),
        isBreaking: z.boolean().optional().describe("Whether the update is breaking per its versioning (matchIsBreaking; post-lookup)."),
        currentVersionTimestamp: optString("Release timestamp of the current version (matchCurrentAge; post-lookup)."),
        mergeConfidenceLevel: optString("Merge-confidence level (matchConfidence; needs the merge-confidence API — unevaluatable offline)."),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform, ...ctx }) => {
      const src = await loadConfigSource({ repoPath, configContent });
      if ("error" in src) return { isError: true, content: [{ type: "text", text: src.error }] };

      // Expand `extends` so preset-provided packageRules are included, then test
      // against the effective set.
      const { packageRules, resolved, warnings: presetWarnings } = await resolvePackageRules(
        src.config,
        { fetchExternal: externalPresets ?? false, endpoint, platform },
      );

      // Build the synthetic dependency context from supplied fields only.
      const context: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ctx)) {
        if (v !== undefined) context[k] = v;
      }

      // The top-level config (branchPrefix, semanticCommits, …) is what the
      // rendered names are layered on; the rules are applied by the worker.
      const { packageRules: _rules, ...renderBase } = resolved;
      const analysis = await analyzePackageRules(packageRules, [context], { renderBase });
      const result = analysis.contexts[0] ?? { mergedConfig: {}, rules: [] };

      const matchedRules = result.rules.filter((r) => r.matched).map(toMatchedRule);
      const unmatchedRules = result.rules
        .filter((r) => !r.matched)
        .map((r) => ({ index: r.index, rule: r.rule, decidedBy: r.decidedBy }));
      const unevaluatable = result.rules.flatMap((r) =>
        r.unevaluatable.map((u) => ({ ruleIndex: r.index, ...u })),
      );

      const effectiveConfig = { ...result.mergedConfig };
      delete effectiveConfig.packageRules;

      const warnings = [...analysis.warnings, ...presetWarnings];
      if (packageRules.length === 0) {
        warnings.push("The resolved config has no packageRules to test.");
      }
      const { rendered, renderError } = result;
      // A semantic prefix is only ever applied when no explicit
      // commitMessagePrefix is set, so the "auto" caveat is noise otherwise.
      const effective = (key: string) => effectiveConfig[key] ?? renderBase[key];
      if (renderError) {
        warnings.push(`A template in this config does not render (${renderError}) — \`rendered\` is omitted.`);
      } else if (!rendered) {
        warnings.push(
          "Template rendering needs the packageRules worker, which was unavailable — `rendered` is omitted.",
        );
      } else if ((effective("semanticCommits") ?? "auto") === "auto" && !effective("commitMessagePrefix")) {
        warnings.push(
          'semanticCommits is "auto" (the default), so the names are rendered without a semantic prefix: Renovate decides that from the repo\'s git history at run time. Set semanticCommits to "enabled" to preview the prefix.',
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(src.path ? { path: src.path } : {}),
                matchQuality: analysis.matchQuality,
                disclaimer:
                  analysis.matchQuality === "faithful"
                    ? TEST_PACKAGE_RULES_FAITHFUL_DISCLAIMER
                    : MATCH_PREVIEW_DISCLAIMER,
                ruleCount: packageRules.length,
                matchedRuleCount: matchedRules.length,
                matchedRules,
                unmatchedRules,
                unevaluatable,
                effectiveConfig,
                ...(rendered
                  ? {
                      rendered: {
                        renderQuality: "preview",
                        disclaimer: RENDER_PREVIEW_DISCLAIMER,
                        ...rendered,
                      },
                    }
                  : {}),
                warnings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
