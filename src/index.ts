#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckSetup } from "./tools/checkSetup.js";
import { registerReadConfig } from "./tools/readConfig.js";
import { registerValidateConfig } from "./tools/validateConfig.js";
import { registerLintConfig } from "./tools/lintConfig.js";
import { registerResolveConfig } from "./tools/resolveConfig.js";
import { registerExplainConfig } from "./tools/explainConfig.js";
import { registerResolveConfigDiff } from "./tools/resolveConfigDiff.js";
import { registerSuggestPresets } from "./tools/suggestPresets.js";
import { registerPreviewCustomManager } from "./tools/previewCustomManager.js";
import { registerDryRun } from "./tools/dryRun.js";
import { registerDryRunDiff } from "./tools/dryRunDiff.js";
import { registerTestPackageRules } from "./tools/testPackageRules.js";
import { registerAnnotateDryRun } from "./tools/annotateDryRun.js";
import { registerWriteConfig } from "./tools/writeConfig.js";
import { registerMigrateConfig } from "./tools/migrateConfig.js";
import { registerGetVersion } from "./tools/getVersion.js";
import { registerPresetResources } from "./resources/presets.js";
import { checkSetup, startupBanner } from "./lib/setupCheck.js";
import { SERVER_VERSION } from "./lib/version.js";
import { logError } from "./lib/log.js";

// Register before any work: stdout carries JSON-RPC frames, so a stray Node-default
// log of an unhandled rejection / uncaught exception would corrupt MCP framing.
process.on("unhandledRejection", (reason) => {
  logError("unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  logError("uncaught exception", err);
  process.exit(1);
});

const BASE_INSTRUCTIONS = [
  "Design and debug Renovate configurations interactively.",
  "",
  "Workflow:",
  "  1. read_config            — inspect the current config in a repo",
  "  2. suggest_presets        — go from a natural-language intent to candidate built-in/local presets + an unvalidated draft skeleton (offline); then validate_config + lint_config",
  "  3. resolve_config         — expand built-in presets to see what a config actually becomes (offline)",
  "  4. explain_config         — inverse of resolve_config: trace which preset set each field (offline)",
  "  5. resolve_config_diff    — offline structural diff of two resolved configs (changed fields + array/packageRules set diffs); use this over dry_run_diff for config refactors, especially when registries are unreachable",
  "  6. test_package_rules     — offline what-if: which packageRules match a hypothetical dependency, which matcher decided each, and what each contributes (debug \"why didn't my rule match?\")",
  "  7. preview_custom_manager — iterate on a regex-based customManagers entry; shows file/line hits and extracted deps",
  "  8. validate_config        — check a proposed config against Renovate's schema",
  "  9. lint_config            — semantic lint pass: catches Renovate-specific footguns schema validation misses (e.g. malformed /…/ regex patterns)",
  " 10. dry_run                — preview what Renovate would actually do (no PRs)",
  " 11. dry_run_diff           — semantic diff between two dry_run reports (added/removed/changed updates)",
  " 12. annotate_dry_run       — attribute each proposed update in a dry_run report to the packageRules that caused it (and flag rules that never matched)",
  " 13. migrate_config         — apply Renovate's built-in migrations (deprecated keys → current schema) and return the migrated config",
  " 14. write_config           — save the agreed-upon config (validates first)",
  "",
  "Before the first repo-touching tool call in a session (read_config, resolve_config, dry_run, write_config, …), call check_setup with the same repoPath. It surfaces token / endpoint / connectivity problems up front (e.g. \"set GITHUB_TOKEN or github-actions deps will be skipped\") instead of waiting for dry_run to fail. Skip if the user has already confirmed setup or is doing offline-only work that doesn't depend on git origin or registries.",
  "If any tool fails unexpectedly, call check_setup to diagnose CLI availability.",
  "Built-in preset reference: renovate://presets (namespace index), renovate://presets/{namespace} (one namespace), renovate://preset/{name} (one preset's expanded JSON).",
].join("\n");

if (process.platform === "win32") {
  process.stderr.write(
    "renovate-mcp does not support Windows. Supported platforms are Linux and macOS — see the `os` field in package.json. Run on WSL2 or a Linux/macOS host instead.\n",
  );
  process.exit(1);
}

const setup = await checkSetup();

// `RENOVATE_MCP_REQUIRE_CLI=false` is the opt-out for users who have
// consciously chosen the offline subset and don't want the startup notice.
const requireCliRaw = process.env.RENOVATE_MCP_REQUIRE_CLI?.trim().toLowerCase();
const suppressBanner = requireCliRaw === "false" || requireCliRaw === "0";

const banner = suppressBanner ? null : startupBanner(setup);
const instructions = banner ? [BASE_INSTRUCTIONS, "", banner].join("\n") : BASE_INSTRUCTIONS;

const server = new McpServer({ name: "renovate-mcp", version: SERVER_VERSION }, { instructions });

registerCheckSetup(server);
registerReadConfig(server);
registerResolveConfig(server);
registerExplainConfig(server);
registerResolveConfigDiff(server);
registerSuggestPresets(server);
registerPreviewCustomManager(server);
registerValidateConfig(server);
registerLintConfig(server);
registerDryRun(server);
registerDryRunDiff(server);
registerTestPackageRules(server);
registerAnnotateDryRun(server);
registerMigrateConfig(server);
registerWriteConfig(server);
registerGetVersion(server);
registerPresetResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
