#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckSetup } from "./tools/checkSetup.js";
import { registerReadConfig } from "./tools/readConfig.js";
import { registerValidateConfig } from "./tools/validateConfig.js";
import { registerLintConfig } from "./tools/lintConfig.js";
import { registerResolveConfig } from "./tools/resolveConfig.js";
import { registerExplainConfig } from "./tools/explainConfig.js";
import { registerPreviewCustomManager } from "./tools/previewCustomManager.js";
import { registerDryRun } from "./tools/dryRun.js";
import { registerDryRunDiff } from "./tools/dryRunDiff.js";
import { registerWriteConfig } from "./tools/writeConfig.js";
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
  "  2. resolve_config         — expand built-in presets to see what a config actually becomes (offline)",
  "  3. explain_config         — inverse of resolve_config: trace which preset set each field (offline)",
  "  4. preview_custom_manager — iterate on a regex-based customManagers entry; shows file/line hits and extracted deps",
  "  5. validate_config        — check a proposed config against Renovate's schema",
  "  6. lint_config            — semantic lint pass: catches Renovate-specific footguns schema validation misses (e.g. malformed /…/ regex patterns)",
  "  7. dry_run                — preview what Renovate would actually do (no PRs)",
  "  8. dry_run_diff           — semantic diff between two dry_run reports (added/removed/changed updates)",
  "  9. write_config           — save the agreed-upon config (validates first)",
  "",
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
registerPreviewCustomManager(server);
registerValidateConfig(server);
registerLintConfig(server);
registerDryRun(server);
registerDryRunDiff(server);
registerWriteConfig(server);
registerGetVersion(server);
registerPresetResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
