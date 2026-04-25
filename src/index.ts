#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckSetup } from "./tools/checkSetup.js";
import { registerReadConfig } from "./tools/readConfig.js";
import { registerValidateConfig } from "./tools/validateConfig.js";
import { registerLintConfig } from "./tools/lintConfig.js";
import { registerResolveConfig } from "./tools/resolveConfig.js";
import { registerPreviewCustomManager } from "./tools/previewCustomManager.js";
import { registerDryRun } from "./tools/dryRun.js";
import { registerDryRunDiff } from "./tools/dryRunDiff.js";
import { registerWriteConfig } from "./tools/writeConfig.js";
import { registerPresetResources } from "./resources/presets.js";
import { checkSetup, startupBanner } from "./lib/setupCheck.js";

const BASE_INSTRUCTIONS = [
  "Design and debug Renovate configurations interactively.",
  "",
  "Workflow:",
  "  1. read_config            — inspect the current config in a repo",
  "  2. resolve_config         — expand built-in presets to see what a config actually becomes (offline)",
  "  3. preview_custom_manager — iterate on a regex-based customManagers entry; shows file/line hits and extracted deps",
  "  4. validate_config        — check a proposed config against Renovate's schema",
  "  5. lint_config            — semantic lint pass: catches Renovate-specific footguns schema validation misses (e.g. malformed /…/ regex patterns)",
  "  6. dry_run                — preview what Renovate would actually do (no PRs)",
  "  7. dry_run_diff           — semantic diff between two dry_run reports (added/removed/changed updates)",
  "  8. write_config           — save the agreed-upon config (validates first)",
  "",
  "If any tool fails unexpectedly, call check_setup to diagnose CLI availability.",
  "Built-in preset reference: renovate://presets (namespace index), renovate://presets/{namespace} (one namespace), renovate://preset/{name} (one preset's expanded JSON).",
].join("\n");

const setup = await checkSetup();

// `RENOVATE_MCP_REQUIRE_CLI=false` is the opt-out for users who have
// consciously chosen the offline subset and don't want the startup notice.
const requireCliRaw = process.env.RENOVATE_MCP_REQUIRE_CLI?.trim().toLowerCase();
const suppressBanner = requireCliRaw === "false" || requireCliRaw === "0";

const banner = suppressBanner ? null : startupBanner(setup);
const instructions = banner ? [BASE_INSTRUCTIONS, "", banner].join("\n") : BASE_INSTRUCTIONS;

const SERVER_VERSION = "0.6.0"; // x-release-please-version

const server = new McpServer({ name: "renovate-mcp", version: SERVER_VERSION }, { instructions });

registerCheckSetup(server);
registerReadConfig(server);
registerResolveConfig(server);
registerPreviewCustomManager(server);
registerValidateConfig(server);
registerLintConfig(server);
registerDryRun(server);
registerDryRunDiff(server);
registerWriteConfig(server);
registerPresetResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
