import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveConfig } from "../lib/presetResolver.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";
import {
  loadConfigSource,
  MERGE_PREVIEW_DISCLAIMER,
  RESOLVE_CONFIG_FAITHFUL_DISCLAIMER,
} from "../lib/toolInputs.js";

export function registerResolveConfig(server: McpServer): void {
  server.registerTool(
    "resolve_config",
    {
      title: "Resolve Renovate config (expand presets)",
      description:
        "Expand every preset referenced by `extends` and return the fully resolved config. Built-in presets resolve offline against the committed catalogue. Pass `externalPresets: true` to fetch `github>` and `gitlab>` presets over HTTPS (with optional `RENOVATE_TOKEN` — or `GITHUB_TOKEN` / `GITLAB_TOKEN` as platform-specific fallbacks — for private repos). For GitHub Enterprise or self-hosted GitLab, pass `endpoint` (API base URL, e.g. `https://ghe.example.com/api/v3` or `https://gitlab.example.com/api/v4`); pass `platform` in addition to route `local>` presets through the same endpoint. `bitbucket>`, `gitea>`, and npm presets are structurally unsupported and remain in `presetsUnresolved` regardless. Endpoint and platform are **tool inputs only** — env vars like `RENOVATE_ENDPOINT` are not read, since the MCP server runs under Claude rather than in your shell. Pass either `repoPath` (reads the repo's config) or `configContent` (an inline config object). The response includes `mergeQuality` (`\"faithful\"` — presets are merged with Renovate's own mergeChildConfig in a worker thread; `\"preview\"` only if that worker was unavailable and a simplified in-process merge was used) plus a `disclaimer` and a `warnings` array. Handlebars expressions other than `{{argN}}` are left verbatim; run `dry_run` for full config resolution.",
      inputSchema: {
        repoPath: pathString(
          "Absolute path to the repository root. The tool will locate the repo's renovate config automatically.",
        ).optional(),
        configContent: configRecord(
          "Inline config object to resolve — use instead of repoPath.",
        ).optional(),
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>) over HTTPS. Credentials come from RENOVATE_TOKEN (preferred, matches Renovate's own convention) or GITHUB_TOKEN / GITLAB_TOKEN as platform-specific fallbacks, set on the MCP server process — via the `env` key in claude_desktop_config.json / .mcp.json, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Default false.",
          ),
        endpoint: endpointString(
          "API base URL for github>/gitlab> fetches. Use for GitHub Enterprise (e.g. https://ghe.example.com/api/v3) or self-hosted GitLab (e.g. https://gitlab.example.com/api/v4). Defaults to https://api.github.com and https://gitlab.com/api/v4.",
        ).optional(),
        platform: z
          .enum(["github", "gitlab"])
          .optional()
          .describe(
            "Platform flavour of `endpoint`. When set, `local>owner/repo` presets are fetched as if they were `<platform>>owner/repo` — useful for self-hosted setups where a config's `local>` presets actually live on your private GitHub/GitLab.",
          ),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform }) => {
      const src = await loadConfigSource({ repoPath, configContent });
      if ("error" in src) return { isError: true, content: [{ type: "text", text: src.error }] };

      const {
        resolved,
        presetsResolved,
        presetsUnresolved,
        warnings,
        mergeQuality,
      } = await resolveConfig(src.config, {
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
                resolved,
                mergeQuality,
                disclaimer:
                  mergeQuality === "faithful"
                    ? RESOLVE_CONFIG_FAITHFUL_DISCLAIMER
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
