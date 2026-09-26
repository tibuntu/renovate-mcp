import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explainConfig } from "../lib/configExplainer.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";
import {
  loadConfigSource,
  MERGE_PREVIEW_DISCLAIMER,
  EXPLAIN_CONFIG_FAITHFUL_DISCLAIMER,
} from "../lib/toolInputs.js";

export function registerExplainConfig(server: McpServer): void {
  server.registerTool(
    "explain_config",
    {
      title: "Explain which preset set each field",
      description:
        "Inverse of resolve_config: walk the same preset tree, but annotate every leaf field with the chain of presets that touched it. Each leaf in `explanation` carries `{ value, setBy }` where `setBy` lists every contribution in merge order — last entry wins for scalars and overwritten (non-mergeable) arrays; for mergeable arrays each entry adds its own slice. The `<own>` source means the value came from the user's input config (siblings of `extends`); other sources are preset references as written in `extends`. Use this to trace surprises like \"why is `prCreation` set to 'not-pending'?\". Pure analysis: same offline-by-default behaviour as resolve_config, plus the same `externalPresets` / `endpoint` / `platform` opt-ins. Pass `repoPath` (reads the repo's config) or `configContent` (an inline config). For full-fidelity output, run dry_run instead.",
      inputSchema: {
        repoPath: pathString(
          "Absolute path to the repository root. The tool will locate the repo's renovate config automatically.",
        ).optional(),
        configContent: configRecord(
          "Inline config object to explain — use instead of repoPath.",
        ).optional(),
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>) over HTTPS — same credentials and behaviour as resolve_config. Default false.",
          ),
        endpoint: endpointString(
          "API base URL for github>/gitlab> fetches. Use for GitHub Enterprise or self-hosted GitLab — same semantics as resolve_config.",
        ).optional(),
        platform: z
          .enum(["github", "gitlab"])
          .optional()
          .describe(
            "Platform flavour of `endpoint`. When set, `local>owner/repo` presets are routed through the same endpoint — same semantics as resolve_config.",
          ),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform }) => {
      const src = await loadConfigSource({ repoPath, configContent });
      if ("error" in src) return { isError: true, content: [{ type: "text", text: src.error }] };

      const {
        explanation,
        presetsResolved,
        presetsUnresolved,
        warnings,
        mergeQuality,
      } = await explainConfig(src.config, {
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
                ...(src.path ? { path: src.path } : {}),
                explanation,
                mergeQuality,
                disclaimer:
                  mergeQuality === "faithful"
                    ? EXPLAIN_CONFIG_FAITHFUL_DISCLAIMER
                    : MERGE_PREVIEW_DISCLAIMER,
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
