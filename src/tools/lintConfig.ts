import { promises as fs } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lintConfig } from "../lib/configLinter.js";
import { configRecord, pathString } from "../lib/inputLimits.js";

export function registerLintConfig(server: McpServer): void {
  server.registerTool(
    "lint_config",
    {
      title: "Lint Renovate config for semantic footguns",
      description:
        "Run a semantic lint pass over a Renovate config. Complements validate_config: schema validation catches structural bugs, this catches Renovate-specific footguns schema validation misses — malformed '/…/' regex patterns in fields like matchPackageNames, matchDepNames, matchSourceUrls, matchCurrentVersion, plus unknown manager names in matchManagers / excludeManagers (typos that Renovate silently ignores). Offline; does not shell out. Pass either configPath (file on disk, JSON or JSON5) or configContent (inline object).",
      inputSchema: {
        configPath: pathString(
          "Absolute path to a config file to lint (JSON or JSON5)",
        ).optional(),
        configContent: configRecord("Inline config object to lint").optional(),
      },
    },
    async ({ configPath, configContent }) => {
      if (!configPath && !configContent) {
        return {
          isError: true,
          content: [
            { type: "text", text: "Provide either configPath or configContent." },
          ],
        };
      }

      let config: unknown;
      if (configContent) {
        config = configContent;
      } else {
        try {
          const raw = await fs.readFile(configPath!, "utf8");
          config = path.extname(configPath!).toLowerCase() === ".json5"
            ? JSON5.parse(raw)
            : JSON.parse(raw);
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to read or parse config at ${configPath}: ${(err as Error).message}`,
              },
            ],
          };
        }
      }

      const findings = lintConfig(config);

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
