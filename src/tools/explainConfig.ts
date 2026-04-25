import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateConfig } from "../lib/configLocations.js";
import { explainConfig } from "../lib/configExplainer.js";

const MERGE_QUALITY = "preview" as const;
const MERGE_DISCLAIMER =
  "Same simplified merge as resolve_config (arrays concat, objects merge, scalars overwrite). Renovate's rule-specific semantics for hostRules, regexManagers, and some boolean flags are not modelled — explanations of those keys are only as accurate as the merge.";

export function registerExplainConfig(server: McpServer): void {
  server.registerTool(
    "explain_config",
    {
      title: "Explain which preset set each field",
      description:
        "Inverse of resolve_config: walk the same preset tree, but annotate every leaf field with the chain of presets that touched it. Each leaf in `explanation` carries `{ value, setBy }` where `setBy` lists every contribution in merge order — last entry wins for scalars; for arrays each entry adds its own slice. The `<own>` source means the value came from the user's input config (siblings of `extends`); other sources are preset references as written in `extends`. Use this to trace surprises like \"why is `prCreation` set to 'not-pending'?\". Pure analysis: same offline-by-default behaviour as resolve_config, plus the same `externalPresets` / `endpoint` / `platform` opt-ins. Pass `repoPath` (reads the repo's config) or `configContent` (an inline config). For full-fidelity output, run dry_run instead.",
      inputSchema: {
        repoPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root. The tool will locate the repo's renovate config automatically.",
          ),
        configContent: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Inline config object to explain — use instead of repoPath."),
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>) over HTTPS — same credentials and behaviour as resolve_config. Default false.",
          ),
        endpoint: z
          .string()
          .optional()
          .describe(
            "API base URL for github>/gitlab> fetches. Use for GitHub Enterprise or self-hosted GitLab — same semantics as resolve_config.",
          ),
        platform: z
          .enum(["github", "gitlab"])
          .optional()
          .describe(
            "Platform flavour of `endpoint`. When set, `local>owner/repo` presets are routed through the same endpoint — same semantics as resolve_config.",
          ),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform }) => {
      if (!repoPath && !configContent) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Provide either repoPath or configContent." },
          ],
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
            content: [
              {
                type: "text",
                text: `No Renovate configuration found in ${repoPath}.`,
              },
            ],
          };
        }
        source = located.config;
        sourcePath = located.relPath;
      }

      const { explanation, presetsResolved, presetsUnresolved, warnings } =
        await explainConfig(source, {
          fetchExternal: externalPresets ?? false,
          endpoint,
          platform,
        });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(sourcePath ? { path: sourcePath } : {}),
                explanation,
                mergeQuality: MERGE_QUALITY,
                disclaimer: MERGE_DISCLAIMER,
                presetsResolved,
                presetsUnresolved,
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
