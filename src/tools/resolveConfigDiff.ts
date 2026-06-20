import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { locateConfig } from "../lib/configLocations.js";
import { resolveConfig, type ResolveResult } from "../lib/presetResolver.js";
import { diffResolvedConfigs } from "../lib/resolveConfigDiff.js";
import { configRecord, endpointString, pathString } from "../lib/inputLimits.js";

const sideSchema = z
  .object({
    repoPath: pathString(
      "Absolute path to the repository root. The tool locates the repo's renovate config automatically.",
    ).optional(),
    configContent: configRecord(
      "Inline config object to resolve — use instead of repoPath.",
    ).optional(),
  })
  .describe("One side of the diff: pass repoPath OR configContent.");

type Side = z.infer<typeof sideSchema>;

async function resolveSide(
  label: "before" | "after",
  input: Side,
  options: Parameters<typeof resolveConfig>[1],
): Promise<
  | { ok: true; result: ResolveResult; path?: string }
  | { ok: false; error: string }
> {
  if (!input.repoPath && !input.configContent) {
    return { ok: false, error: `Provide either repoPath or configContent for ${label}.` };
  }

  let source: Record<string, unknown>;
  let sourcePath: string | undefined;
  if (input.configContent) {
    source = input.configContent;
  } else {
    const located = await locateConfig(input.repoPath!);
    if (!located) {
      return { ok: false, error: `No Renovate configuration found in ${input.repoPath} (${label}).` };
    }
    source = located.config;
    sourcePath = located.relPath;
  }

  const result = await resolveConfig(source, options);
  return { ok: true, result, path: sourcePath };
}

export function registerResolveConfigDiff(server: McpServer): void {
  server.registerTool(
    "resolve_config_diff",
    {
      title: "Diff two resolved Renovate configs",
      description:
        "Compute a structural diff between two *fully-resolved* Renovate configs — the `before` and `after` of a config refactor — entirely offline. This is the resolve-level counterpart to `dry_run_diff`: where `dry_run_diff` shows how the *proposed PRs* change (and collapses to a vacuous 0-vs-0 when the environment can't reach registries), this answers \"does the new config produce the same effective settings as the old one, modulo the intended changes?\". Each side accepts `repoPath` (locates the repo's config) OR `configContent` (an inline config object); both sides are resolved with `resolve_config`'s preset expansion + faithful merge. Non-array top-level keys are deep-compared and reported with before/after values; array-valued top-level keys (`packageRules`, `customManagers`, `matchManagers`, …) get an order-insensitive set diff (members only in `before` are `removed`, only in `after` are `added` — a tweaked rule shows as one of each). Shared `externalPresets` / `endpoint` / `platform` knobs apply to both sides. Returns a structured diff (`summary`, `fieldChanges`, `arrayChanges`) plus a human-readable `text` rendering and per-side `resolution` metadata (`mergeQuality`, `presetsUnresolved`, `warnings`).",
      inputSchema: {
        before: sideSchema,
        after: sideSchema,
        externalPresets: z
          .boolean()
          .optional()
          .describe(
            "When true, fetch external presets (github>, gitlab>) over HTTPS for BOTH sides. Credentials come from RENOVATE_TOKEN (preferred) or GITHUB_TOKEN / GITLAB_TOKEN as platform-specific fallbacks, set on the MCP server process. Default false (fully offline).",
          ),
        endpoint: endpointString(
          "API base URL for github>/gitlab> fetches, applied to both sides. Use for GitHub Enterprise (e.g. https://ghe.example.com/api/v3) or self-hosted GitLab (e.g. https://gitlab.example.com/api/v4).",
        ).optional(),
        platform: z
          .enum(["github", "gitlab"])
          .optional()
          .describe(
            "Platform flavour of `endpoint`, applied to both sides. When set, `local>owner/repo` presets are fetched as if they were `<platform>>owner/repo`.",
          ),
      },
    },
    async ({ before, after, externalPresets, endpoint, platform }) => {
      const options = { fetchExternal: externalPresets ?? false, endpoint, platform };
      const [beforeRes, afterRes] = await Promise.all([
        resolveSide("before", before, options),
        resolveSide("after", after, options),
      ]);

      if (!beforeRes.ok) {
        return { isError: true, content: [{ type: "text", text: beforeRes.error }] };
      }
      if (!afterRes.ok) {
        return { isError: true, content: [{ type: "text", text: afterRes.error }] };
      }

      const diff = diffResolvedConfigs(beforeRes.result.resolved, afterRes.result.resolved);

      const resolution = {
        before: sideMeta(beforeRes.result, beforeRes.path),
        after: sideMeta(afterRes.result, afterRes.path),
      };

      const advisory = degradedAdvisory(beforeRes.result, afterRes.result);
      const text = advisory ? `${advisory}\n\n${diff.text}` : diff.text;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...diff, text, resolution }, null, 2),
          },
        ],
      };
    },
  );
}

function sideMeta(result: ResolveResult, path?: string) {
  return {
    ...(path ? { path } : {}),
    mergeQuality: result.mergeQuality,
    presetsUnresolved: result.presetsUnresolved,
    warnings: result.warnings,
  };
}

function degradedAdvisory(before: ResolveResult, after: ResolveResult): string | null {
  const notes: string[] = [];
  if (before.mergeQuality === "preview" || after.mergeQuality === "preview") {
    notes.push(
      "one or both sides used the approximate in-process merge (mergeQuality: \"preview\") — the diff may not be authoritative",
    );
  }
  if (before.presetsUnresolved.length > 0 || after.presetsUnresolved.length > 0) {
    notes.push(
      "one or both sides have unresolved presets — fields they would contribute are absent from this diff (see resolution.presetsUnresolved)",
    );
  }
  return notes.length > 0 ? `⚠ ${notes.join("; ")}.` : null;
}
