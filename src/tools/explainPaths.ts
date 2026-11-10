import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";
import { DEFAULT_MAX_FILES, explainPaths } from "../lib/pathSelection.js";
import { FETCH_PLATFORMS } from "../lib/presetResolver.js";
import {
  assertRepoDir,
  hostTokensError,
  loadConfigSource,
  MERGE_PREVIEW_DISCLAIMER,
  NETWORK_READ_ONLY_ANNOTATIONS,
} from "../lib/toolInputs.js";

const EXPLAIN_PATHS_DISCLAIMER =
  "Files are listed the way Renovate's local platform does (`git ls-files`, else a full walk) and filtered with a mirror of Renovate's own getIncludedFiles / filterIgnoredFiles; the config is resolved with Renovate's mergeChildConfig. Remote platforms list the base branch's committed tree, so uncommitted files may differ. Built-in managers' own managerFilePatterns are not applied — run dry_run with dryRunMode \"extract\" for the files each manager actually extracts.";

export function registerExplainPaths(server: McpServer): void {
  server.registerTool(
    "explain_paths",
    {
      title: "Explain which files Renovate scans",
      annotations: NETWORK_READ_ONLY_ANNOTATIONS,
      description:
        "Offline: resolve the repo's config (presets included, so hidden ignorePaths like `:ignoreModulesAndTests` from config:recommended show up), list the repo's files the way Renovate does (`git ls-files`), and apply Renovate's includePaths → ignorePaths filter. Returns every pattern with the preset or `<own>` config that set it, how many files it matched and a sample; `deadPatterns` (user-owned patterns matching no file, including packageRules[].matchFileNames entries); `substringOnlyHits` (files dropped only because an ignorePaths entry is a substring of the path, e.g. `test` dropping `src/latest/package.json`, with the glob that was probably meant); per-rule matchFileNames counts against the kept files; and a summary. Pass `configContent` to try a config other than the repo's own. Same `externalPresets` / `endpoint` / `platform` opt-ins as resolve_config.",
      inputSchema: {
        repoPath: pathString("Absolute path to the repository root whose files are evaluated."),
        configContent: configRecord(
          "Inline config to evaluate instead of the repo's own config file.",
        ).optional(),
        externalPresets: z
          .boolean()
          .optional()
          .describe("When true, fetch external presets (github>, gitlab>, gitea>, forgejo>) over HTTPS — same as resolve_config. Default false."),
        endpoint: endpointString("API base URL that `local>` presets are fetched from (with `platform`) — same semantics as resolve_config.").optional(),
        platform: z
          .enum(FETCH_PLATFORMS)
          .optional()
          .describe("The platform `local>` presets live on — same semantics as resolve_config (routes only; never moves a token)."),
        maxFiles: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .optional()
          .describe(`Cap on the number of listed files evaluated (default ${DEFAULT_MAX_FILES}); truncation is reported.`),
      },
    },
    async ({ repoPath, configContent, externalPresets, endpoint, platform, maxFiles }) => {
      const repoError = await assertRepoDir(repoPath);
      if (repoError) return { isError: true, content: [{ type: "text", text: repoError }] };
      const src = configContent !== undefined ? { config: configContent } : await loadConfigSource({ repoPath });
      if ("error" in src) return { isError: true, content: [{ type: "text", text: src.error }] };
      const tokensError = hostTokensError(externalPresets);
      if (tokensError) return { isError: true, content: [{ type: "text", text: tokensError }] };

      const result = await explainPaths(repoPath, src.config, {
        fetchExternal: externalPresets ?? false,
        endpoint,
        platform,
        maxFiles,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...("path" in src && src.path ? { path: src.path } : {}),
                ...result,
                disclaimer:
                  result.mergeQuality === "faithful" ? EXPLAIN_PATHS_DISCLAIMER : MERGE_PREVIEW_DISCLAIMER,
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
