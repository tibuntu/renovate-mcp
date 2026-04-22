import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateConfig } from "../lib/configLocations.js";
import { resolveConfig } from "../lib/presetResolver.js";

export function registerResolveConfig(server: McpServer): void {
  server.registerTool(
    "resolve_config",
    {
      title: "Resolve Renovate config (expand presets)",
      description:
        "Expand every built-in preset referenced by `extends` against the committed preset catalogue (offline). Returns the fully resolved config plus which presets were expanded and which couldn't be resolved (external github>/gitlab>/local>/npm presets, unknown names, or cycles). Pass either repoPath (reads the repo's config) or configContent (an inline config object).",
      inputSchema: {
        repoPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root. The tool will locate the repo's renovate config automatically.",
          ),
        configContent: z
          .record(z.unknown())
          .optional()
          .describe("Inline config object to resolve — use instead of repoPath."),
      },
    },
    async ({ repoPath, configContent }) => {
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

      const { resolved, presetsResolved, presetsUnresolved } = resolveConfig(source);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...(sourcePath ? { path: sourcePath } : {}),
                resolved,
                presetsResolved,
                presetsUnresolved,
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
