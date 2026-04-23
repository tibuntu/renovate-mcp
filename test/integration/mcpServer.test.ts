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
  it("lists all seven tools with expected names", async () => {
    session = await startServer();
    const res = await session.request<{ tools: Array<{ name: string }> }>("tools/list");
    const names = (res.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "check_setup",
      "dry_run",
      "preview_custom_manager",
      "read_config",
      "resolve_config",
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

describe("preview_custom_manager end-to-end", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "rmcp-pcm-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("extracts deps from a Dockerfile via a regex custom manager", async () => {
    await writeFile(path.join(repo, "Dockerfile"), "FROM alpine:3.19\n");
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "preview_custom_manager",
      arguments: {
        repoPath: repo,
        manager: {
          customType: "regex",
          fileMatch: ["(^|/)Dockerfile$"],
          matchStrings: ["FROM (?<depName>[^:\\s]+):(?<currentValue>\\S+)"],
          datasourceTemplate: "docker",
        },
      },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.filesMatched).toEqual(["Dockerfile"]);
    expect(parsed.extractedDeps).toHaveLength(1);
    expect(parsed.extractedDeps[0]).toMatchObject({
      depName: "alpine",
      currentValue: "3.19",
      datasource: "docker",
    });
  });

  it("rejects non-regex customType with isError", async () => {
    session = await startServer();
    const res = await session.request<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "preview_custom_manager",
      arguments: {
        repoPath: repo,
        manager: {
          customType: "jsonata",
          fileMatch: ["x"],
          matchStrings: ["x"],
        },
      },
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0]?.text).toMatch(/customType="regex"/);
  });
});

describe("resolve_config end-to-end", () => {
  it("expands built-in presets from inline configContent", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "resolve_config",
      arguments: {
        configContent: { extends: ["default:automergeAll"], schedule: ["weekly"] },
      },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.resolved).toMatchObject({ automerge: true, schedule: ["weekly"] });
    expect(parsed.resolved).not.toHaveProperty("extends");
    expect(parsed.presetsResolved).toContain("default:automergeAll");
    expect(parsed.presetsUnresolved).toEqual([]);
  });

  it("flags external presets without failing the call", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "resolve_config",
      arguments: { configContent: { extends: ["github>some/repo"] } },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.presetsUnresolved).toHaveLength(1);
    expect(parsed.presetsUnresolved[0].preset).toBe("github>some/repo");
    expect(res.result).not.toHaveProperty("isError", true);
  });
});
