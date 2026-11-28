import type { McpServer } from "@modelcontextprotocol/server";
import { lintConfig } from "../lib/configLinter.js";
import { configRecord, pathString } from "../lib/inputLimits.js";
import { loadConfigFile, OFFLINE_READ_ONLY_ANNOTATIONS } from "../lib/toolInputs.js";
import { z } from "zod";

export function registerLintConfig(server: McpServer): void {
  server.registerTool(
    "lint_config",
    {
      title: "Lint Renovate config for semantic footguns",
      annotations: OFFLINE_READ_ONLY_ANNOTATIONS,
      description:
        "Run a semantic lint pass over a Renovate config. Complements validate_config: schema validation catches structural bugs, this catches Renovate-specific footguns schema validation misses — 16 rules, e.g. malformed `/…/` regexes, unknown managers and datasources, deprecated keys, invalid schedules, inline secrets; see docs/tools.md#lint_config. Each finding includes a severity ('error' | 'warn'). Offline; does not shell out. Pass either configPath (file on disk, JSON, JSONC or JSON5) or configContent (inline object).",
      inputSchema: z.object({
        configPath: pathString(
          "Absolute path to a config file to lint (JSON, JSONC or JSON5)",
        ).optional(),
        configContent: configRecord("Inline config object to lint").optional(),
      }),
    },
    async ({ configPath, configContent }) => {
      const loaded = await loadConfigFile({ configPath, configContent });
      if (!loaded.ok) {
        return { isError: true, content: [{ type: "text", text: loaded.error }] };
      }

      const findings = lintConfig(loaded.config);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                clean: findings.length === 0,
                findings,
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
