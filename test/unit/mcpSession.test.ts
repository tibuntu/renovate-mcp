import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * Exercises mcpSession's crash/hang handling. We point `serverEntry` at small
 * fake server scripts generated on disk — no real Renovate or MCP SDK involved.
 */

let session: McpSession | undefined;
let workDir: string | undefined;

afterEach(async () => {
  if (session) {
    await session.close().catch(() => {});
    session = undefined;
  }
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

async function writeFakeServer(body: string): Promise<string> {
  workDir = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
  const file = path.join(workDir, "server.mjs");
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/**
 * A fake server that answers `initialize`, then takes an action before any
 * follow-up request can be answered. `action` is inlined into the script.
 */
async function makeFakeServerAfterInit(action: string): Promise<string> {
  return writeFakeServer(`
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } },
      }) + "\\n");
    } else if (msg.method === "notifications/initialized") {
      ${action}
    }
    // Any other request id is intentionally ignored so the client's request hangs
    // until its wall-clock timeout or an exit event fires.
  }
});
`);
}

describe("mcpSession request() failure modes", () => {
  it("rejects pending request when the server exits after initialize", async () => {
    const serverEntry = await makeFakeServerAfterInit(`
      process.stderr.write("fake server crashing for test\\n");
      process.exit(3);
    `);
    session = await startServer({}, { serverEntry, requestTimeoutMs: 5_000 });

    await expect(session.request("tools/list")).rejects.toThrow(/code 3/);
  });

  it("surfaces buffered stderr in the rejection message", async () => {
    const serverEntry = await makeFakeServerAfterInit(`
      process.stderr.write("boom: the thing went wrong\\n");
      process.exit(7);
    `);
    session = await startServer({}, { serverEntry, requestTimeoutMs: 5_000 });

    await expect(session.request("tools/list")).rejects.toThrow(/boom: the thing went wrong/);
  });

  it("rejects pending request when the server hangs past the wall-clock timeout", async () => {
    // Server accepts initialize but never responds to any follow-up request.
    const serverEntry = await makeFakeServerAfterInit(`
      /* keep the process alive but silent */
    `);
    session = await startServer({}, { serverEntry, requestTimeoutMs: 200 });

    await expect(session.request("tools/list")).rejects.toThrow(/timed out after 200ms/);
  });
});
