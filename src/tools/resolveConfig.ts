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
        "Expand every preset referenced by `extends` and return the fully resolved config. Built-in presets resolve offline against the committed catalogue. Pass `externalPresets: true` to fetch `github>` and `gitlab>` presets over HTTPS (with optional `GITHUB_TOKEN` / `GITLAB_TOKEN` / `RENOVATE_TOKEN` for private repos). For GitHub Enterprise or self-hosted GitLab, pass `endpoint` (API base URL, e.g. `https://ghe.example.com/api/v3` or `https://gitlab.example.com/api/v4`); pass `platform` in addition to route `local>` presets through the same endpoint. `bitbucket>`, `gitea>`, and npm presets are structurally unsupported and remain in `presetsUnresolved` regardless. Endpoint and platform are **tool inputs only** — env vars like `RENOVATE_ENDPOINT` are not read, since the MCP server runs under Claude rather than in your shell. Pass either `repoPath` (reads the repo's config) or `configContent` (an inline config object).",
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
        endpoint: z
          .string()
          .optional()
          .describe(
            "API base URL for github>/gitlab> fetches. Use for GitHub Enterprise (e.g. https://ghe.example.com/api/v3) or self-hosted GitLab (e.g. https://gitlab.example.com/api/v4). Defaults to https://api.github.com and https://gitlab.com/api/v4.",
          ),
        platform: z
          .enum(["github", "gitlab"])
          .optional()
          .describe(
            "Platform flavour of `endpoint`. When set, `local>owner/repo` presets are fetched as if they were `<platform>>owner/repo` — useful for self-hosted setups where a config's `local>` presets actually live on your private GitHub/GitLab.",
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

      const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig(source, {
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
