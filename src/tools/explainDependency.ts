import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  analyzePackageRules,
  resolvePackageRules,
  toMatchedRule,
} from "../lib/packageRulesAnalysis.js";
import { explainDependency, type DependencyHit } from "../lib/dependencyExplainer.js";
import { readReportPath } from "../lib/reportInput.js";
import { configRecord, pathString, reportRecord } from "../lib/inputLimits.js";
import { loadConfigSource } from "../lib/toolInputs.js";

const PREVIEW_NOTE =
  "The faithful matcher worker was unavailable, so matchedRules come from an approximate glob-only preview (matchPackageNames / matchDepNames / matchManagers / matchDatasources / matchFileNames / matchCategories only). Run dry_run for authoritative output.";

/** Matcher-relevant facts a hit carries, in the shape the packageRules worker expects. */
function contextOf(hit: DependencyHit): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  const fields = ["repository", "manager", "packageFile", "depName", "packageName", "datasource", "depType", "currentVersion"] as const;
  for (const f of fields) if (hit[f] !== undefined) ctx[f] = hit[f];
  if (typeof hit.currentValue === "string") ctx.currentValue = hit.currentValue;
  return ctx;
}

export function registerExplainDependency(server: McpServer): void {
  server.registerTool(
    "explain_dependency",
    {
      title: "Explain why a dependency was or wasn't updated",
      description:
        "Answer \"why was/wasn't dependency X updated?\" from an existing `dry_run` report — offline, no CLI. Finds every extracted occurrence of the dependency under `packageFiles` (matched case-insensitively against `depName` and `packageName`; exact by default, `partial: true` for substring) and returns per hit its `skipReason` / `skipStage`, proposed `updates`, and `warnings`, plus a one-line `verdict` (`not found in report`, `skipped: <reason>`, `up to date`, or `N update(s) available`), remedy `hints`, and `relatedProblems` (report/repo `problems` entries mentioning the dep). Pass the report inline (`report`, raw or a full `dry_run` summary) or via `reportPath` (pair with `dry_run`'s reportOutputPath). Optionally add a config source (`repoPath` or `configContent`) to attach `matchedRules` — the packageRules that matched each hit, evaluated with Renovate's real matchers in a worker thread.",
      inputSchema: {
        report: reportRecord(
          "A Renovate dry-run report — the raw report (`{ repositories }`) or a full `dry_run` summary (`{ report }`); the tool unwraps `report` automatically. Use instead of reportPath.",
        ).optional(),
        reportPath: pathString(
          "Absolute path to a JSON file containing the report (pair with `dry_run`'s reportOutputPath). Use instead of report.",
        ).optional(),
        depName: z
          .string()
          .min(1)
          .max(2048)
          .describe("Dependency to explain; compared case-insensitively against each dep's `depName` and `packageName`."),
        partial: z.boolean().optional().describe("When true, substring match instead of exact. Default false."),
        manager: z.string().max(256).optional().describe("Only consider deps extracted by this manager (e.g. `npm`, `dockerfile`)."),
        repoPath: pathString(
          "Absolute path to the repository root; the tool locates and expands its renovate config to attach matchedRules. Use instead of configContent.",
        ).optional(),
        configContent: configRecord(
          "Inline config object whose packageRules to attribute against. Use instead of repoPath.",
        ).optional(),
      },
    },
    async ({ report, reportPath, depName, partial, manager, repoPath, configContent }) => {
      if (!report && !reportPath) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide either report or reportPath (run dry_run first)." }],
        };
      }
      if (report && reportPath) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pass either report or reportPath, not both." }],
        };
      }

      let reportValue: unknown = report;
      let reportSource: "inline" | "reportPath" = "inline";
      if (reportPath) {
        const res = await readReportPath(reportPath);
        if (!res.ok) return { isError: true, content: [{ type: "text", text: res.error }] };
        reportValue = res.value;
        reportSource = "reportPath";
      }

      const explanation = explainDependency(reportValue, { depName, partial, manager });
      const warnings: string[] = [];
      let hits: Array<DependencyHit & { matchedRules?: unknown[] }> = explanation.hits;
      let matchQuality: string | undefined;
      let configPath: string | undefined;
      let source: Record<string, unknown> | undefined;

      if (repoPath || configContent) {
        const src = await loadConfigSource({ repoPath, configContent });
        if ("error" in src) return { isError: true, content: [{ type: "text", text: src.error }] };
        source = src.config;
        configPath = src.path;
      }

      if (source && hits.length > 0) {
        const { packageRules, warnings: presetWarnings } = await resolvePackageRules(source, {
          fetchExternal: false,
        });
        const analysis = await analyzePackageRules(packageRules, hits.map(contextOf));
        matchQuality = analysis.matchQuality;
        hits = hits.map((hit, i) => ({
          ...hit,
          matchedRules: (analysis.contexts[i]?.rules ?? []).filter((r) => r.matched).map(toMatchedRule),
        }));
        warnings.push(...analysis.warnings, ...presetWarnings);
        if (packageRules.length === 0) warnings.push("The resolved config has no packageRules.");
        if (analysis.matchQuality === "preview") warnings.push(PREVIEW_NOTE);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                depName: explanation.depName,
                reportSource,
                ...(configPath ? { configPath } : {}),
                ...(matchQuality ? { matchQuality } : {}),
                verdict: explanation.verdict,
                hits,
                hints: explanation.hints,
                relatedProblems: explanation.relatedProblems,
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
