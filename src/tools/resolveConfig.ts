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
        "Expand every preset referenced by `extends` and return the fully resolved config. Built-in presets resolve offline against the committed catalogue. Pass `externalPresets: true` to fetch `github>` and `gitlab>` presets over HTTPS (with optional `GITHUB_TOKEN` / `GITLAB_TOKEN` / `RENOVATE_TOKEN` for private repos). `local>`, `bitbucket>`, `gitea>`, and npm presets are structurally unsupported by this tool and remain in `presetsUnresolved` regardless of the flag. Pass either `repoPath` (reads the repo's config) or `configContent` (an inline config object).",
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
          .describe("Inline config object to resolve — use instead of repoPath."),
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>) over HTTPS. Credentials are read from GITHUB_TOKEN / GITLAB_TOKEN / RENOVATE_TOKEN env vars. Default false.",
          ),
      },
    },
    async ({ repoPath, configContent, externalPresets }) => {
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

      const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig(source, {
        fetchExternal: externalPresets ?? false,
      });

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
