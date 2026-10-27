import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FETCH_PLATFORMS, resolveConfig } from "../lib/presetResolver.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";
import {
  loadConfigSource,
  MERGE_PREVIEW_DISCLAIMER,
  RESOLVE_CONFIG_FAITHFUL_DISCLAIMER,
  NETWORK_READ_ONLY_ANNOTATIONS,
} from "../lib/toolInputs.js";

export function registerResolveConfig(server: McpServer): void {
  server.registerTool(
    "resolve_config",
    {
      title: "Resolve Renovate config (expand presets)",
      annotations: NETWORK_READ_ONLY_ANNOTATIONS,
      description:
        "Expand every preset referenced by `extends` and return the fully resolved config. Built-in presets resolve offline against the committed catalogue. Pass `externalPresets: true` to fetch `github>`, `gitlab>`, `gitea>`, and `forgejo>` presets over HTTPS (with optional `RENOVATE_TOKEN` — or `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` / `FORGEJO_TOKEN` / `BITBUCKET_TOKEN` as platform-specific fallbacks — for private repos). For GitHub Enterprise, self-hosted GitLab, or self-hosted Gitea/Forgejo, pass `endpoint` (API base URL, e.g. `https://ghe.example.com/api/v3`, `https://gitlab.example.com/api/v4`, or `https://forgejo.example.com/api/v1`); pass `platform` in addition to route `local>` presets through the same endpoint. That is also how Bitbucket Cloud presets resolve (`platform: \"bitbucket\"`) — Renovate has no `bitbucket>` prefix, so that spelling is refused with a pointer at `local>`. npm presets are structurally unsupported and remain in `presetsUnresolved` regardless. Endpoint and platform are **tool inputs only** — env vars like `RENOVATE_ENDPOINT` are not read, since the MCP server runs under Claude rather than in your shell. Pass either `repoPath` (reads the repo's config) or `configContent` (an inline config object). The response includes `mergeQuality` (`\"faithful\"` — presets are merged with Renovate's own mergeChildConfig in a worker thread; `\"preview\"` only if that worker was unavailable and a simplified in-process merge was used) plus a `disclaimer` and a `warnings` array. Handlebars expressions other than `{{argN}}` are left verbatim; run `dry_run` for full config resolution.",
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
            "When true, fetch external presets (github>, gitlab>, gitea>, forgejo>) over HTTPS. Credentials come from RENOVATE_TOKEN (preferred, matches Renovate's own convention) or GITHUB_TOKEN / GITLAB_TOKEN / GITEA_TOKEN / FORGEJO_TOKEN / BITBUCKET_TOKEN as platform-specific fallbacks, set on the MCP server process — via the `env` key in claude_desktop_config.json / .mcp.json, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Default false.",
          ),
        endpoint: endpointString(
          "API base URL for external preset fetches. Use for GitHub Enterprise (e.g. https://ghe.example.com/api/v3), self-hosted GitLab (e.g. https://gitlab.example.com/api/v4), or self-hosted Gitea/Forgejo (e.g. https://forgejo.example.com/api/v1). Defaults to https://api.github.com, https://gitlab.com/api/v4, https://gitea.com/api/v1, https://code.forgejo.org/api/v1, and https://api.bitbucket.org.",
        ).optional(),
        platform: z
          .enum(FETCH_PLATFORMS)
          .optional()
          .describe(
            "Platform flavour of `endpoint`. When set, `local>owner/repo` presets are fetched as if they were `<platform>>owner/repo` — useful for self-hosted setups where a config's `local>` presets actually live on your private GitHub/GitLab/Gitea/Forgejo, and the only way to reach Bitbucket Cloud presets (`bitbucket`).",
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
