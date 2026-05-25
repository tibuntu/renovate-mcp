import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  previewCustomManager,
  type CustomManager,
} from "../lib/customManagerPreview.js";
import { pathString } from "../lib/inputLimits.js";

const managerSchema = z
  .object({
    customType: z.string(),
    fileMatch: z.array(z.string()).min(1),
    matchStrings: z.array(z.string()).min(1),
    matchStringsStrategy: z.string().optional(),
    fileFormat: z.enum(["json", "yaml", "toml"]).optional(),
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
      title: "Preview a Renovate custom manager (regex or jsonata)",
      description: [
        "Preview a Renovate `customManagers` entry against a local repo — fast, offline, no `renovate` invocation. Designed for iterating on a regex or JSONata customManager: shows which files match `fileMatch`, what each `matchStrings` entry extracts, and what dep info the template fields produce.",
        "",
        "Limitations vs. a real Renovate run:",
        "  - Supports `customType: \"regex\"` and `customType: \"jsonata\"` (the latter requires `fileFormat` to be \"json\", \"yaml\", or \"toml\").",
        "  - For `customType: \"jsonata\"`: each `matchStrings` entry is a JSONata expression that may return EITHER an array of objects OR a single object (the single object is auto-wrapped to a one-element array, mirroring Renovate's own schema). Object keys map to dep fields (`depName`, `currentValue`, `datasource`, etc.).",
        "  - Template substitution stringifies non-string primitive values (e.g. numeric `currentValue: 1.2` becomes the string \"1.2\"); null/undefined and nested objects/arrays are dropped from the substitution bag. Same `{{groupName}}` template gap as regex — full Handlebars helpers are not implemented.",
        "  - `matchStringsStrategy` other than `any` (the default) is not implemented; a warning is emitted.",
        "  - `.gitignore` (and `.git/info/exclude`, plus nested `.gitignore`s) is honored like `git` does. `node_modules/` and `.git/` are always skipped as a safety net, even without a `.gitignore`.",
        "",
        "Run the `dry_run` tool afterwards for full-fidelity confirmation.",
      ].join("\n"),
      inputSchema: {
        repoPath: pathString("Absolute path to the repository root"),
        manager: managerSchema.describe(
          "A single Renovate customManagers entry. NOTE: `fileMatch` is an array of REGEX strings matched against POSIX-style relative paths (not globs).",
        ),
        maxFilesWalked: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe(
            "Safety cap on files visited during the directory walk before any fileMatch testing (default 2000). Raise this when the repo is large; prefer narrowing via `.gitignore` first.",
          ),
        maxFilesMatched: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe(
            "Safety cap on the number of files included in the result after fileMatch is applied (default 500). Raise this only if the fileMatch regex is intentionally broad.",
          ),
        maxHitsPerFile: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .optional()
          .describe("Safety cap on matches per file (default 100)"),
        matchTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(60_000)
          .optional()
          .describe(
            "Wall-clock budget per regex operation, in milliseconds (default 2000). User-supplied patterns run in a worker thread so catastrophic backtracking can't pin the server; this cap decides how long we wait before aborting a single pattern and emitting a warning.",
          ),
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024 * 1024)
          .optional()
          .describe(
            "Per-file size cap in bytes (default 5242880 = 5 MiB). Files whose size exceeds this are skipped with a warning instead of being read into memory — protects against OOM when fileMatch catches a lockfile, generated artifact, or other oversized file.",
          ),
      },
    },
    async ({
      repoPath,
      manager,
      maxFilesWalked,
      maxFilesMatched,
      maxHitsPerFile,
      matchTimeoutMs,
      maxFileBytes,
    }) => {
      if (manager.customType !== "regex" && manager.customType !== "jsonata") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `preview_custom_manager only supports customType=\"regex\" or customType=\"jsonata\" (got \"${manager.customType}\"). For other custom manager types, use dry_run.`,
            },
          ],
        };
      }
      if (manager.customType === "jsonata" && !manager.fileFormat) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: 'customType="jsonata" requires "fileFormat" to be one of "json", "yaml", or "toml".',
            },
          ],
        };
      }

      try {
        const result = await previewCustomManager(repoPath, manager as CustomManager, {
          maxFilesWalked,
          maxFilesMatched,
          maxHitsPerFile,
          matchTimeoutMs,
          maxFileBytes,
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
