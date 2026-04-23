import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  previewCustomManager,
  type CustomManager,
} from "../lib/customManagerPreview.js";

const managerSchema = z
  .object({
    customType: z.string(),
    fileMatch: z.array(z.string()).min(1),
    matchStrings: z.array(z.string()).min(1),
    matchStringsStrategy: z.string().optional(),
    depNameTemplate: z.string().optional(),
    packageNameTemplate: z.string().optional(),
    currentValueTemplate: z.string().optional(),
    currentDigestTemplate: z.string().optional(),
    datasourceTemplate: z.string().optional(),
    versioningTemplate: z.string().optional(),
    registryUrlTemplate: z.string().optional(),
    depTypeTemplate: z.string().optional(),
    extractVersionTemplate: z.string().optional(),
    autoReplaceStringTemplate: z.string().optional(),
  })
  .passthrough();

export function registerPreviewCustomManager(server: McpServer): void {
  server.registerTool(
    "preview_custom_manager",
    {
      title: "Preview a Renovate custom manager (regex)",
      description: [
        "Preview a Renovate `customManagers` entry against a local repo — fast, offline, no `renovate` invocation. Designed for iterating on a regex: shows which files match `fileMatch`, which lines match each `matchStrings` regex (with named capture groups), and what dep info the template fields produce.",
        "",
        "Limitations vs. a real Renovate run:",
        "  - Only `customType: \"regex\"` is supported.",
        "  - `matchStringsStrategy` other than `any` (the default) is not implemented; a warning is emitted.",
        "  - Template substitution handles only `{{groupName}}` references, not full Handlebars helpers.",
        "  - `.gitignore` (and `.git/info/exclude`, plus nested `.gitignore`s) is honored like `git` does. `node_modules/` and `.git/` are always skipped as a safety net, even without a `.gitignore`.",
        "",
        "Run the `dry_run` tool afterwards for full-fidelity confirmation.",
      ].join("\n"),
      inputSchema: {
        repoPath: z.string().describe("Absolute path to the repository root"),
        manager: managerSchema.describe(
          "A single Renovate customManagers entry. NOTE: `fileMatch` is an array of REGEX strings matched against POSIX-style relative paths (not globs).",
        ),
        maxFilesScanned: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Safety cap on files walked (default 2000)"),
        maxHitsPerFile: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Safety cap on matches per file (default 100)"),
      },
    },
    async ({ repoPath, manager, maxFilesScanned, maxHitsPerFile }) => {
      if (manager.customType !== "regex") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `preview_custom_manager only supports customType=\"regex\" (got \"${manager.customType}\"). For other custom manager types, use dry_run.`,
            },
          ],
        };
      }

      try {
        const result = await previewCustomManager(repoPath, manager as CustomManager, {
          maxFilesScanned,
          maxHitsPerFile,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: "text", text: (err as Error).message },
          ],
        };
      }
    },
  );
}
