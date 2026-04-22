#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCheckSetup } from "./tools/checkSetup.js";
import { registerReadConfig } from "./tools/readConfig.js";
import { registerValidateConfig } from "./tools/validateConfig.js";
import { registerResolveConfig } from "./tools/resolveConfig.js";
import { registerDryRun } from "./tools/dryRun.js";
import { registerWriteConfig } from "./tools/writeConfig.js";
import { registerPresetResources } from "./resources/presets.js";
import { checkSetup, describeSetup } from "./lib/setupCheck.js";

const BASE_INSTRUCTIONS = [
  "Design and debug Renovate configurations interactively.",
  "",
  "Workflow:",
  "  1. read_config     — inspect the current config in a repo",
  "  2. resolve_config  — expand built-in presets to see what a config actually becomes (offline)",
  "  3. validate_config — check a proposed config against Renovate's schema",
  "  4. dry_run         — preview what Renovate would actually do (no PRs)",
  "  5. write_config    — save the agreed-upon config (validates first)",
  "",
  "If any tool fails unexpectedly, call check_setup to diagnose CLI availability.",
  "Built-in preset reference is available at renovate://presets.",
].join("\n");

const setup = await checkSetup();

const instructions = setup.ok
  ? BASE_INSTRUCTIONS
  : [BASE_INSTRUCTIONS, "", "Startup setup check:", describeSetup(setup)].join("\n");

const server = new McpServer({ name: "renovate-mcp", version: "0.1.0" }, { instructions });

registerCheckSetup(server);
registerReadConfig(server);
registerResolveConfig(server);
registerValidateConfig(server);
registerDryRun(server);
registerWriteConfig(server);
registerPresetResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
