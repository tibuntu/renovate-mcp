import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ponytail: prompts return exactly one user-role text message each — the
// documented GetPromptResult shape, nothing fancier (no multi-turn scripting).
function userMessage(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

export function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(
    "design-renovate-config",
    {
      title: "Design a Renovate config",
      description:
        "Go from intent to a validated, saved Renovate config: check_setup, read_config, suggest_presets, resolve/explain the draft, validate + lint, dry_run, then write_config on confirmation.",
      argsSchema: {
        repoPath: z.string().max(4096).describe("Absolute path to the repository root."),
        intent: z
          .string()
          .max(2048)
          .optional()
          .describe('Free-text intent, e.g. "automerge patches, group dev deps".'),
      },
    },
    ({ repoPath, intent }) =>
      userMessage(
        [
          `Design a Renovate config for the repo at ${repoPath}.`,
          "",
          `1. Call check_setup with repoPath "${repoPath}" first to surface any token/CLI setup problems.`,
          `2. Call read_config with repoPath "${repoPath}" to see the current config, if any.`,
          intent
            ? `3. Call suggest_presets with repoPath and intent "${intent}" to get ranked presets and, if coverage is weak, an unvalidated draft config skeleton.`
            : '3. Ask the user what they want Renovate to do, then call suggest_presets with repoPath and that intent.',
          "4. Call resolve_config and explain_config on the resulting draft/config so you can show what it actually resolves to and which preset set each field.",
          "5. Call validate_config and lint_config against the draft to catch schema errors and Renovate-specific footguns.",
          "6. Call dry_run against the repo to preview the actual updates Renovate would propose.",
          "7. Summarize the plan (presets used, resolved effective config, dry-run results) and ask the user to confirm.",
          "8. Only after the user explicitly confirms, call write_config with repoPath to save. Never call write_config before that confirmation.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "debug-package-rule",
    {
      title: "Debug why a packageRule did or didn't match",
      description:
        "Trace a packageRules decision for a dependency: read_config, test_package_rules, dry_run with a report file, annotate_dry_run, then a verdict naming rule indices and matchers.",
      argsSchema: {
        repoPath: z.string().max(4096).describe("Absolute path to the repository root."),
        depName: z
          .string()
          .max(2048)
          .optional()
          .describe("The dependency name to investigate, if known."),
      },
    },
    ({ repoPath, depName }) =>
      userMessage(
        [
          `Debug packageRules behavior for the repo at ${repoPath}${depName ? ` and dependency "${depName}"` : ""}.`,
          "",
          `1. Call check_setup with repoPath "${repoPath}" first to surface any token/CLI setup problems.`,
          `2. Call read_config with repoPath "${repoPath}" to load the current config.`,
          depName
            ? `3. Call test_package_rules with repoPath and depName "${depName}" (plus any other known fields — datasource, manager, currentValue, …) to see which packageRules match this hypothetical dependency, which matcher decided each, and what each contributes.`
            : "3. Ask the user which dependency to investigate (and any known fields — datasource, manager, currentValue, …), then call test_package_rules with repoPath and those fields.",
          "4. Call dry_run against the repo with reportOutputPath set to a temp file path, to get the real Renovate report without a huge inline payload.",
          "5. Call annotate_dry_run with reportPath pointing at that same file (plus repoPath) to attribute each proposed update to the packageRules that caused it, and flag rules that never matched.",
          "6. State the verdict: name the exact packageRules index/indices and matcher(s) that decided the outcome for this dependency, and call out any rulesNeverMatched that look like dead rules.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "author-custom-manager",
    {
      title: "Author a custom manager",
      description:
        "Draft and iterate on a customManagers entry (regex or jsonata) with preview_custom_manager, then validate + lint + dry_run, and write_config on confirmation.",
      argsSchema: {
        repoPath: z.string().max(4096).describe("Absolute path to the repository root."),
        description: z
          .string()
          .max(2048)
          .describe("What to extract, and from which files, e.g. \"docker image tags from Dockerfiles\"."),
      },
    },
    ({ repoPath, description }) =>
      userMessage(
        [
          `Author a Renovate customManagers entry for the repo at ${repoPath}: ${description}`,
          "",
          `1. Call check_setup with repoPath "${repoPath}" first to surface any token/CLI setup problems.`,
          "2. Draft a customManagers entry (customType \"regex\" or \"jsonata\") matching the description above.",
          "3. Call preview_custom_manager with repoPath and the draft manager. Iterate on fileMatch/matchStrings until the file/line hits and extracted dep info look right.",
          "4. Call validate_config and lint_config against the full config (existing config plus the new customManagers entry).",
          "5. Call dry_run against the repo to confirm the manager behaves as expected end to end.",
          "6. Summarize the entry and the dry-run result, and ask the user to confirm.",
          "7. Only after the user explicitly confirms, call write_config with repoPath to save. Never call write_config before that confirmation.",
        ].join("\n"),
      ),
  );
}
