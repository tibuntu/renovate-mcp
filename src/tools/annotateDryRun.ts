import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateConfig } from "../lib/configLocations.js";
import { resolveConfig } from "../lib/presetResolver.js";
import { identityKey } from "../lib/dryRunDiff.js";
import {
  analyzePackageRules,
  MATCHER_META,
} from "../lib/packageRulesAnalysis.js";
import { configRecord, endpointString, pathString, reportRecord } from "../lib/inputLimits.js";

const FAITHFUL_DISCLAIMER =
  "Each update is attributed using Renovate's real matchers (run in a worker thread) against the facts present in the dry_run report. Matchers needing data the report doesn't carry are reported under each update's `unevaluatable` and aggregated in `fieldGaps`, NOT as non-matches. matchConfidence needs the merge-confidence API (unevaluatable offline); matchJsonata is advisory. Run dry_run for full-fidelity resolution.";
const PREVIEW_DISCLAIMER =
  "The faithful matcher worker was unavailable, so this used an approximate glob-only preview (matchPackageNames / matchDepNames / matchManagers / matchDatasources / matchFileNames / matchCategories only); rules using any other matcher are reported as unevaluatable. Run dry_run for authoritative output.";

// Matcher-relevant fields we try to lift off each report upgrade entry.
const CONTEXT_FIELDS = [
  "depName", "packageName", "datasource", "manager", "depType", "depTypes",
  "currentValue", "currentVersion", "lockedVersion", "versioning", "packageFile",
  "lockFiles", "categories", "sourceUrl", "updateType", "newValue", "newVersion",
  "currentVersionTimestamp", "registryUrls", "baseBranch", "repository", "isBump",
] as const;

interface UpdateEntry {
  display: {
    manager: string;
    packageFile: string;
    depName: string;
    currentVersion?: unknown;
    newVersion?: unknown;
    updateType?: unknown;
  };
  context: Record<string, unknown>;
}

function extractReport(input: unknown): unknown {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if ("report" in obj && obj.report && typeof obj.report === "object") {
      return obj.report;
    }
  }
  return input;
}

function readRecord(node: unknown, key: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readArray(node: unknown, key: string): unknown[] | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

/** Walk repositories[*].branches[*].upgrades[] and lift matcher-relevant facts. */
function collectUpdateEntries(report: unknown): UpdateEntry[] {
  const out: UpdateEntry[] = [];
  const repositories = readRecord(report, "repositories");
  if (!repositories) return out;

  for (const repo of Object.values(repositories)) {
    const branches = readArray(repo, "branches");
    if (!branches) continue;
    for (const branch of branches) {
      const upgrades = readArray(branch, "upgrades");
      if (!upgrades) continue;
      for (const upgrade of upgrades) {
        if (!upgrade || typeof upgrade !== "object") continue;
        const u = upgrade as Record<string, unknown>;
        const manager = typeof u.manager === "string" ? u.manager : "";
        const depName = typeof u.depName === "string" ? u.depName : "";
        if (!manager || !depName) continue;
        const packageFile = typeof u.packageFile === "string" ? u.packageFile : "";

        const context: Record<string, unknown> = {};
        for (const field of CONTEXT_FIELDS) {
          if (u[field] !== undefined) context[field] = u[field];
        }

        out.push({
          display: {
            manager,
            packageFile,
            depName,
            currentVersion: u.currentVersion ?? u.currentValue,
            newVersion: u.newVersion ?? u.newValue,
            updateType: u.updateType,
          },
          context,
        });
      }
    }
  }
  return out;
}

async function readReportPath(
  reportPath: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(reportPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read reportPath (\`${reportPath}\`): ${msg}.` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `reportPath (\`${reportPath}\`) is not valid JSON: ${msg}.` };
  }
}

export function registerAnnotateDryRun(server: McpServer): void {
  server.registerTool(
    "annotate_dry_run",
    {
      title: "Attribute dry_run updates to packageRules",
      description:
        "Given a `dry_run` report and a config, attribute EACH proposed update to the `packageRules` that matched it — answering \"which of my rules produced these updates?\". Stateless and offline: run `dry_run` first, then pass its report here (inline `report` or `reportPath`, same shapes as `dry_run_diff`) plus a config source (`repoPath` or `configContent`). Each update is matched with Renovate's REAL matchers in a worker thread against the facts present in the report; fields the report doesn't carry (e.g. datasource, depType) are reported under each update's `unevaluatable` and aggregated in `fieldGaps` rather than silently treated as non-matches. `rulesNeverMatched` flags likely-dead rules. Deprecated matcher keys are warned about — run migrate_config first. Run dry_run for full-fidelity confirmation.",
      inputSchema: {
        report: reportRecord(
          "A Renovate dry-run report — the raw report (`{ repositories }`) or a full `dry_run` summary (`{ report }`); the tool unwraps `report` automatically. Use instead of reportPath.",
        ).optional(),
        reportPath: pathString(
          "Absolute path to a JSON file containing the report (pair with `dry_run`'s reportOutputPath). Use instead of report.",
        ).optional(),
        repoPath: pathString(
          "Absolute path to the repository root; the tool locates and expands its renovate config to get the packageRules. Use instead of configContent.",
        ).optional(),
        configContent: configRecord(
          "Inline config object whose packageRules to attribute against. Use instead of repoPath.",
        ).optional(),
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>) so their packageRules are included — same semantics as resolve_config. Default false.",
          ),
        endpoint: endpointString(
          "API base URL for github>/gitlab> fetches — same semantics as resolve_config.",
        ).optional(),
        platform: z
          .enum(["github", "gitlab"])
          .optional()
          .describe("Platform flavour of `endpoint` — same semantics as resolve_config."),
      },
    },
    async ({ report, reportPath, repoPath, configContent, externalPresets, endpoint, platform }) => {
      if (!report && !reportPath) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide either report or reportPath (run dry_run first)." }],
        };
      }
      if (!repoPath && !configContent) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide a config source: either repoPath or configContent." }],
        };
      }

      // Resolve the report.
      let reportValue: unknown;
      let reportSource: "inline" | "reportPath";
      if (reportPath) {
        const res = await readReportPath(reportPath);
        if (!res.ok) return { isError: true, content: [{ type: "text", text: res.error }] };
        reportValue = res.value;
        reportSource = "reportPath";
      } else {
        reportValue = report;
        reportSource = "inline";
      }

      // Resolve the config's effective packageRules.
      let source: Record<string, unknown>;
      let sourcePath: string | undefined;
      if (configContent) {
        source = configContent;
      } else {
        const located = await locateConfig(repoPath!);
        if (!located) {
          return { content: [{ type: "text", text: `No Renovate configuration found in ${repoPath}.` }] };
        }
        source = located.config;
        sourcePath = located.relPath;
      }
      const { resolved, warnings: presetWarnings, presetsUnresolved } = await resolveConfig(source, {
        fetchExternal: externalPresets ?? false,
        endpoint,
        platform,
      });
      const packageRules = Array.isArray(resolved.packageRules)
        ? (resolved.packageRules.filter(
            (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
          ) as Record<string, unknown>[])
        : [];

      // Collect + dedup updates (a dep can appear in multiple branches).
      const entriesRaw = collectUpdateEntries(extractReport(reportValue));
      const seen = new Set<string>();
      const entries: UpdateEntry[] = [];
      for (const e of entriesRaw) {
        const key = identityKey(e.display);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(e);
      }

      const analysis = await analyzePackageRules(
        packageRules,
        entries.map((e) => e.context),
      );

      const matchedIndices = new Set<number>();
      const annotations = entries.map((entry, i) => {
        const ruleAnalysis = analysis.contexts[i]?.rules ?? [];
        const matchedRules = ruleAnalysis
          .filter((r) => r.matched)
          .map((r) => {
            matchedIndices.add(r.index);
            return {
              index: r.index,
              rule: r.rule,
              matchedBy: r.matchedBy,
              ...(r.contributedConfig ? { contributedConfig: r.contributedConfig } : {}),
            };
          });
        const unevaluatable = ruleAnalysis.flatMap((r) =>
          r.unevaluatable.map((u) => ({ ruleIndex: r.index, ...u })),
        );
        return { ...entry.display, matchedRules, unevaluatable };
      });

      const rulesNeverMatched = packageRules
        .map((_, i) => i)
        .filter((i) => !matchedIndices.has(i));

      // fieldGaps: context fields referenced by the rules' matchers that no
      // update in the report carried — the report shape didn't supply them.
      const presentFields = new Set<string>();
      for (const e of entries) for (const f of Object.keys(e.context)) presentFields.add(f);
      const usedFields = new Set<string>();
      const metaByKey = new Map(Object.values(MATCHER_META).map((m) => [m.key, m]));
      for (const rule of packageRules) {
        for (const key of Object.keys(rule)) {
          const meta = metaByKey.get(key);
          if (meta) for (const f of meta.requiredAnyOf) usedFields.add(f);
        }
      }
      const fieldGaps = [...usedFields].filter((f) => !presentFields.has(f)).sort();

      const warnings = [...analysis.warnings, ...presetWarnings.map((w) => `${w.preset}: ${w.message}`)];
      if (presetsUnresolved.length > 0) {
        warnings.push(
          `${presetsUnresolved.length} preset(s) could not be expanded, so preset-provided packageRules may be missing: ${presetsUnresolved
            .map((p) => p.preset)
            .join(", ")}.`,
        );
      }
      if (packageRules.length === 0) warnings.push("The resolved config has no packageRules.");
      if (entries.length === 0) warnings.push("The report contained no proposed updates to annotate.");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(sourcePath ? { configPath: sourcePath } : {}),
                matchQuality: analysis.matchQuality,
                disclaimer:
                  analysis.matchQuality === "faithful" ? FAITHFUL_DISCLAIMER : PREVIEW_DISCLAIMER,
                reportSource,
                ruleCount: packageRules.length,
                updateCount: entries.length,
                annotations,
                rulesNeverMatched,
                fieldGaps,
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
