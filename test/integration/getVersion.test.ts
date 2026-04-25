import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, copyFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../../src/lib/version.js";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_DIR = path.join(REPO_ROOT, "dist");

let session: McpSession;
let stagingRoot: string | null = null;

afterEach(async () => {
  if (session) await session.close();
  if (stagingRoot) {
    await rm(stagingRoot, { recursive: true, force: true });
    stagingRoot = null;
  }
});

interface VersionPayload {
  version: string;
  mode: "local" | "released";
  scriptPath: string;
}

function parseVersionResponse(text: string): VersionPayload {
  const idx = text.lastIndexOf("\n{");
  if (idx === -1) throw new Error(`no JSON payload in response:\n${text}`);
  return JSON.parse(text.slice(idx + 1)) as VersionPayload;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isFile()) await copyFile(s, d);
  }
}

describe("get_version", () => {
  it("reports the server version and flags the local/dev build when run from a checkout", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", { name: "get_version", arguments: {} });

    const text = res.result!.content[0]!.text;
    expect(text).toContain(`renovate-mcp ${SERVER_VERSION}`);
    expect(text).toContain("(local/dev build)");

    const payload = parseVersionResponse(text);
    expect(payload.version).toBe(SERVER_VERSION);
    expect(payload.mode).toBe("local");
    expect(payload.scriptPath).not.toMatch(/[\\/]node_modules[\\/]/);
  });

  it("reports a released build when invoked from inside node_modules", async () => {
    // Stage the built server under a fake `node_modules/renovate-mcp/` inside
    // the repo so the path-based detection sees the install marker AND Node's
    // module resolution can still walk up to the real `node_modules/` for
    // peer-deps like `@modelcontextprotocol/sdk`.
    stagingRoot = await mkdtemp(path.join(REPO_ROOT, ".tmp-getver-"));
    const installed = path.join(stagingRoot, "node_modules", "renovate-mcp");
    await copyDir(DIST_DIR, path.join(installed, "dist"));

    session = await startServer(
      {},
      { serverEntry: path.join(installed, "dist", "index.js") },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", { name: "get_version", arguments: {} });

    const text = res.result!.content[0]!.text;
    expect(text).not.toContain("(local/dev build)");
    const payload = parseVersionResponse(text);
    expect(payload.mode).toBe("released");
    expect(payload.scriptPath).toMatch(/[\\/]node_modules[\\/]renovate-mcp[\\/]/);
  });
});
