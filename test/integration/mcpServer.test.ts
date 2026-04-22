import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

describe("MCP server stdio handshake", () => {
  it("lists all five tools with expected names", async () => {
    session = await startServer();
    const res = await session.request<{ tools: Array<{ name: string }> }>("tools/list");
    const names = (res.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "check_setup",
      "dry_run",
      "read_config",
      "validate_config",
      "write_config",
    ]);
  });

  it("lists the presets resource", async () => {
    session = await startServer();
    const res = await session.request<{
      resources: Array<{ uri: string; name: string }>;
    }>("resources/list");
    const uris = (res.result?.resources ?? []).map((r) => r.uri);
    expect(uris).toContain("renovate://presets");
  });
});

describe("read_config end-to-end", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "rmcp-e2e-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns the parsed renovate.json from a fixture repo", async () => {
    await writeFile(
      path.join(repo, "renovate.json"),
      '{"extends":["config:recommended"],"schedule":["before 6am on monday"]}',
    );
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", { name: "read_config", arguments: { repoPath: repo } });
    const text = res.result?.content[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.path).toBe("renovate.json");
    expect(parsed.format).toBe("json");
    expect(parsed.config).toMatchObject({
      extends: ["config:recommended"],
      schedule: ["before 6am on monday"],
    });
  });

  it("reports a friendly message when no config is found", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", { name: "read_config", arguments: { repoPath: repo } });
    expect(res.result?.content[0]?.text).toContain("No Renovate configuration found");
  });
});
