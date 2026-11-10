import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FETCH_PLATFORMS, resolveConfig } from "../lib/presetResolver.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";
import {
  hostTokensError,
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
        "Expand every preset referenced by `extends` and return the fully resolved config. Built-in presets resolve offline against the committed catalogue. Pass `externalPresets: true` to fetch `github>`, `gitlab>`, `gitea>`, and `forgejo>` presets over HTTPS; like Renovate, each always goes to its public host (api.github.com, gitlab.com, gitea.com, code.forgejo.org). Presets on GitHub Enterprise, a self-hosted GitLab / Gitea / Forgejo, or Bitbucket Cloud are `local>` presets: pass `platform` (and `endpoint`, the API base URL, e.g. `https://gitlab.example.com/api/v4`), or set `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` on the server, and `local>owner/repo` is fetched from there. `endpoint` routes nothing else. Renovate has no `bitbucket>` prefix, so that spelling is refused with a pointer at `local>`. npm presets are structurally unsupported and remain in `presetsUnresolved` regardless. Tokens are host-scoped: `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` / `FORGEJO_TOKEN` / `BITBUCKET_TOKEN` each go only to their own platform's public host, `GITHUB_COM_TOKEN` to github.com, `RENOVATE_MCP_HOST_TOKENS` entries to their `matchHost`, and `RENOVATE_TOKEN` only to the home host named by the server env: `RENOVATE_PLATFORM`, at `RENOVATE_ENDPOINT` when set (there it wins over the platform's own token, which moves to that host as the fallback); without `RENOVATE_PLATFORM` `RENOVATE_TOKEN` is not sent. The `platform` / `endpoint` inputs route `local>` but never bind a token: a self-hosted endpoint passed only on the call gets one only from a `RENOVATE_MCP_HOST_TOKENS` entry. Where several tokens match a host, the longest matching host wins, as in Renovate's hostRules. A malformed `RENOVATE_MCP_HOST_TOKENS` is an error when fetching. Pass either `repoPath` (reads the repo's config) or `configContent` (an inline config object). The response includes `mergeQuality` (`\"faithful\"` — presets are merged with Renovate's own mergeChildConfig in a worker thread; `\"preview\"` only if that worker was unavailable and a simplified in-process merge was used) plus a `disclaimer` and a `warnings` array. Handlebars expressions other than `{{argN}}` are left verbatim; run `dry_run` for full config resolution.",
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
            "When true, fetch external presets (github>, gitlab>, gitea>, forgejo>, and local> routed via `platform`) over HTTPS. Each platform's token (GITHUB_TOKEN, GITLAB_TOKEN, GITEA_TOKEN, FORGEJO_TOKEN, BITBUCKET_TOKEN) is sent only to that platform's host; RENOVATE_TOKEN only to the RENOVATE_PLATFORM / RENOVATE_ENDPOINT host. Set them on the MCP server process — via the `env` key in claude_desktop_config.json / .mcp.json, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Default false.",
          ),
        endpoint: endpointString(
          "API base URL that `local>` presets are fetched from, together with `platform` — e.g. https://ghe.example.com/api/v3 (GitHub Enterprise), https://gitlab.example.com/api/v4 (self-hosted GitLab) or https://forgejo.example.com/api/v1. Like Renovate, it does not reroute github>, gitlab>, gitea> or forgejo> presets. Routes only: env tokens reach this host only when `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` name it or a `RENOVATE_MCP_HOST_TOKENS` entry covers it. Falls back to `RENOVATE_ENDPOINT` when `platform` is unset or equals `RENOVATE_PLATFORM`; otherwise `local>` uses the platform's public API.",
        ).optional(),
        platform: z
          .enum(FETCH_PLATFORMS)
          .optional()
          .describe(
            "The platform `local>` presets live on: `local>owner/repo` is fetched as `<platform>>owner/repo` against `endpoint` (or the platform's public API) — for presets on a private GitHub/GitLab/Gitea/Forgejo, and the only way to reach Bitbucket Cloud presets (`bitbucket`). Routes only; never moves a token. Falls back to `RENOVATE_PLATFORM`.",
          ),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform }) => {
      const src = await loadConfigSource({ repoPath, configContent });
      if ("error" in src) return { isError: true, content: [{ type: "text", text: src.error }] };
      const tokensError = hostTokensError(externalPresets);
      if (tokensError) return { isError: true, content: [{ type: "text", text: tokensError }] };

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
