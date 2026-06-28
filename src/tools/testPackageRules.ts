import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateConfig } from "../lib/configLocations.js";
import { resolveConfig } from "../lib/presetResolver.js";
import { analyzePackageRules } from "../lib/packageRulesAnalysis.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";

const FAITHFUL_DISCLAIMER =
  "Rules are evaluated with Renovate's real matchers (run in a worker thread), so match decisions are faithful for the fields you supplied. Matchers needing post-lookup data you didn't supply (matchUpdateTypes, matchCurrentVersion, matchNewValue, matchCurrentAge) or the merge-confidence API (matchConfidence) are reported under `unevaluatable`, NOT as non-matches. matchJsonata results are advisory (the expression may read fields you didn't supply). Run dry_run for full-fidelity resolution.";
const PREVIEW_DISCLAIMER =
  "The faithful matcher worker was unavailable, so this used an approximate glob-only preview (matchPackageNames / matchDepNames / matchManagers / matchDatasources / matchFileNames / matchCategories only); rules using any other matcher are reported as unevaluatable. Run dry_run for authoritative output.";

const optString = (description: string) => z.string().max(2048).optional().describe(description);
const optStringArray = (description: string) =>
  z.array(z.string().max(2048)).max(256).optional().describe(description);

export function registerTestPackageRules(server: McpServer): void {
  server.registerTool(
    "test_package_rules",
    {
      title: "Test which packageRules match a dependency",
      description:
        "Offline \"what-if\": given a hypothetical dependency context and a config, report which `packageRules` match (in order), which matcher decided each, and what each matched rule contributes. Answers \"why didn't my rule match?\". Rules are evaluated with Renovate's REAL matchers in a worker thread (faithful), classified against the fields you actually supplied — a matcher that needs a field you didn't pass is reported as `unevaluatable`, never silently treated as a non-match. Matchers needing post-lookup data (matchUpdateTypes, matchCurrentVersion, matchNewValue, matchCurrentAge) or the merge-confidence API (matchConfidence) are unevaluatable offline; matchJsonata is advisory. Pass either `repoPath` (reads + expands the repo's config) or `configContent` (an inline config); `externalPresets`/`endpoint`/`platform` opt into external preset expansion so `extends`-provided rules are included (same semantics as resolve_config). Deprecated matcher keys (matchPackagePatterns, …) are warned about — run migrate_config first. Run dry_run for full-fidelity confirmation.",
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
            "When true, fetch external presets (github>, gitlab>) over HTTPS so their packageRules are included — same credentials/behaviour as resolve_config. Default false.",
          ),
        endpoint: endpointString(
          "API base URL for github>/gitlab> fetches — same semantics as resolve_config.",
        ).optional(),
        platform: z
          .enum(["github", "gitlab"])
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
        updateType: optString("Update type: major/minor/patch/pin/digest/… (matchUpdateTypes; post-lookup)."),
        isBump: z.boolean().optional().describe("Whether this is a range bump (matchUpdateTypes; post-lookup)."),
        currentVersionTimestamp: optString("Release timestamp of the current version (matchCurrentAge; post-lookup)."),
        mergeConfidenceLevel: optString("Merge-confidence level (matchConfidence; needs the merge-confidence API — unevaluatable offline)."),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform, ...ctx }) => {
      if (!repoPath && !configContent) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide either repoPath or configContent." }],
        };
      }

      let source: Record<string, unknown>;
      let sourcePath: string | undefined;
      if (configContent) {
        source = configContent;
      } else {
        const located = await locateConfig(repoPath!);
        if (!located) {
          return {
            content: [{ type: "text", text: `No Renovate configuration found in ${repoPath}.` }],
          };
        }
        source = located.config;
        sourcePath = located.relPath;
      }

      // Expand `extends` so preset-provided packageRules are included, then test
      // against the effective set.
      const { resolved, warnings: presetWarnings, presetsUnresolved } =
        await resolveConfig(source, {
          fetchExternal: externalPresets ?? false,
          endpoint,
          platform,
        });
      const packageRules = Array.isArray(resolved.packageRules)
        ? (resolved.packageRules.filter(
            (r): r is Record<string, unknown> =>
              !!r && typeof r === "object" && !Array.isArray(r),
          ) as Record<string, unknown>[])
        : [];

      // Build the synthetic dependency context from supplied fields only.
      const context: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ctx)) {
        if (v !== undefined) context[k] = v;
      }

      const analysis = await analyzePackageRules(packageRules, [context]);
      const result = analysis.contexts[0] ?? { mergedConfig: {}, rules: [] };

      const matchedRules = result.rules
        .filter((r) => r.matched)
        .map((r) => ({
          index: r.index,
          rule: r.rule,
          matchedBy: r.matchedBy,
          ...(r.contributedConfig ? { contributedConfig: r.contributedConfig } : {}),
        }));
      const unmatchedRules = result.rules
        .filter((r) => !r.matched)
        .map((r) => ({ index: r.index, rule: r.rule, decidedBy: r.decidedBy }));
      const unevaluatable = result.rules.flatMap((r) =>
        r.unevaluatable.map((u) => ({ ruleIndex: r.index, ...u })),
      );

      const effectiveConfig = { ...result.mergedConfig };
      delete effectiveConfig.packageRules;

      const warnings = [...analysis.warnings, ...presetWarnings.map((w) => `${w.preset}: ${w.message}`)];
      if (presetsUnresolved.length > 0) {
        warnings.push(
          `${presetsUnresolved.length} preset(s) could not be expanded, so preset-provided packageRules may be missing: ${presetsUnresolved
            .map((p) => p.preset)
            .join(", ")}. See resolve_config for details.`,
        );
      }
      if (packageRules.length === 0) {
        warnings.push("The resolved config has no packageRules to test.");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(sourcePath ? { path: sourcePath } : {}),
                matchQuality: analysis.matchQuality,
                disclaimer:
                  analysis.matchQuality === "faithful"
                    ? FAITHFUL_DISCLAIMER
                    : PREVIEW_DISCLAIMER,
                ruleCount: packageRules.length,
                matchedRuleCount: matchedRules.length,
                matchedRules,
                unmatchedRules,
                unevaluatable,
                effectiveConfig,
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
