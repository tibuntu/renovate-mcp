import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { suggestPresets } from "../lib/presetSuggester.js";
import { pathString, queryString } from "../lib/inputLimits.js";

export function registerSuggestPresets(server: McpServer): void {
  server.registerTool(
    "suggest_presets",
    {
      title: "Suggest Renovate presets from a natural-language intent",
      description: [
        "Search Renovate presets by intent — fast, offline, no `renovate` invocation, no network. Given a free-text goal (e.g. \"automerge patch and minor updates and group my dev dependencies\"), it ranks matching presets from the committed built-in catalogue and, optionally, a local presets repo you point at. When no strong match exists it also sketches an unvalidated draft config from recognized intent.",
        "",
        "Returns:",
        "  - `builtIn` / `local`: ranked matches `{ name, namespace, description, score, matchedOn, body? }`. Scoring is lexical (field-weighted name>namespace>description>body, with IDF rarity weighting so ubiquitous tokens like \"group\" don't drown specific matches) — a recall aid, not a stemmed search engine.",
        "  - `coverage` (strong | partial | weak) + `bestScore`: how well the best existing preset covers the intent.",
        "  - `draft` (only when coverage is not strong, unless `includeDraft:false`): `{ config, unvalidated:true, hint, facets, notes }`. `config` is a pasteable Renovate config assembled from a small curated facet taxonomy.",
        "",
        "This tool never validates the draft (that would require the Renovate CLI). Pass `draft.config` to `validate_config`, then `lint_config`, before adopting it — and fetch `renovate://preset/{name}` for a matched preset's full expanded body.",
      ].join("\n"),
      inputSchema: {
        query: queryString(
          "The intent to search for, in natural language (e.g. \"automerge patch updates and group dev dependencies\").",
        ),
        presetsPath: pathString(
          "Absolute path to a local presets repo to index alongside the built-in catalogue (flat *.json / *.json5 files, one preset per file). Optional.",
        ).optional(),
        namespace: z
          .string()
          .max(128)
          .optional()
          .describe(
            "Restrict matches to a single namespace (e.g. \"config\", \"group\", \"schedule\"; \"local\" for local-repo presets).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max number of matches returned per corpus (default 10)."),
        minScore: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Drop matches scoring below this 0..1 threshold (default 0.12)."),
        includeBody: z
          .boolean()
          .optional()
          .describe(
            "Inline each matched preset's full body (default false). When false, fetch renovate://preset/{name} for a body.",
          ),
        includeDraft: z
          .boolean()
          .optional()
          .describe(
            "Emit a draft skeleton when coverage is not strong (default true). Set false for discovery-only results.",
          ),
        maxFilesIndexed: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Safety cap on preset files scanned in presetsPath (default 2000)."),
        maxPresetsIndexed: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Safety cap on presets indexed from presetsPath (default 500)."),
      },
    },
    async ({
      query,
      presetsPath,
      namespace,
      limit,
      minScore,
      includeBody,
      includeDraft,
      maxFilesIndexed,
      maxPresetsIndexed,
    }) => {
      try {
        const result = await suggestPresets(query, {
          presetsPath,
          namespace,
          limit,
          minScore,
          includeBody,
          includeDraft,
          maxFilesIndexed,
          maxPresetsIndexed,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `suggest_presets failed: ${(err as Error).message}`,
            },
          ],
        };
      }
    },
  );
}
