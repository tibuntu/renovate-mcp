#!/usr/bin/env node
// Spawn the installed `renovate-mcp` binary and verify it completes an MCP
// `initialize` handshake. Used by publish.yml to gate `npm publish` on the
// would-be-published tarball actually starting up — catches regressions in the
// `bin` shim, the `files` allowlist, the shebang, and runtime startup that the
// in-tree test suite can't see because it reads from the working tree.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const REQUEST_TIMEOUT_MS = 10_000;
const EXPECTED_SERVER_NAME = "renovate-mcp";
const BIN = process.env.RENOVATE_MCP_BIN ?? "renovate-mcp";

const child = spawn(BIN, { stdio: ["pipe", "pipe", "pipe"] });

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function fail(msg) {
  console.error(`smoke test failed: ${msg}`);
  if (stderr) console.error(`--- server stderr ---\n${stderr.trimEnd()}`);
  child.kill("SIGKILL");
  process.exit(1);
}

child.on("error", (err) => fail(`spawn ${BIN}: ${err.message}`));

const timeout = setTimeout(
  () => fail(`no initialize response after ${REQUEST_TIMEOUT_MS}ms`),
  REQUEST_TIMEOUT_MS,
);

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== 1 || !msg.result) return;
  clearTimeout(timeout);
  const serverName = msg.result?.serverInfo?.name;
  if (serverName !== EXPECTED_SERVER_NAME) {
    fail(`unexpected serverInfo.name: ${JSON.stringify(serverName)}`);
  }
  console.log(`smoke test passed: ${serverName} responded to initialize`);
  child.stdin.end();
  child.kill();
  process.exit(0);
});

const initRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
};
child.stdin.write(JSON.stringify(initRequest) + "\n");
