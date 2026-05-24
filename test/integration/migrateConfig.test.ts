import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * `migrate_config` runs Renovate's migration library inside a worker thread —
 * see ADR docs/adr/0001-worker-isolated-renovate-migration.md. These tests
 * drive the real worker (no fakes); cold-load of renovate's module graph in
 * the worker can take a few seconds, hence the generous request timeout.
 */

const REQUEST_TIMEOUT_MS = 60_000;

let repo: string;
let session: McpSession;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), `rmcp-migrate-${process.pid}-`));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(repo, { recursive: true, force: true });
});

interface MigratePayload {
  isMigrated: boolean;
  migrated: Record<string, unknown>;
  diff: string;
}

describe("migrate_config", () => {
  it("migrates a deprecated key (masterIssue → dependencyDashboard) and reports isMigrated:true", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "migrate_config",
      arguments: { configContent: { masterIssue: true } },
    });

    if (res.result?.isError) {
      throw new Error(`tool returned isError: ${res.result.content[0]!.text}`);
    }
    const payload = JSON.parse(res.result!.content[0]!.text) as MigratePayload;
    expect(payload.isMigrated).toBe(true);
    expect(payload.migrated).toEqual({ dependencyDashboard: true });
    expect(payload.migrated).not.toHaveProperty("masterIssue");
    expect(payload.diff).toContain("dependencyDashboard");
  });

  it("returns isMigrated:false for a modern config", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "migrate_config",
      arguments: {
        configContent: { extends: ["config:recommended"], dependencyDashboard: true },
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text) as MigratePayload;
    expect(payload.isMigrated).toBe(false);
    expect(payload.migrated).toEqual({
      extends: ["config:recommended"],
      dependencyDashboard: true,
    });
    expect(payload.diff).toBe("");
  });

  it("reads from configPath when configContent is not supplied", async () => {
    const configPath = path.join(repo, "renovate.json");
    await writeFile(configPath, JSON.stringify({ stabilityDays: 7 }));
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "migrate_config",
      arguments: { configPath },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text) as MigratePayload;
    expect(payload.isMigrated).toBe(true);
    expect(payload.migrated).toEqual({ minimumReleaseAge: "7 days" });
  });

  it("returns isError when neither configPath nor configContent is supplied", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "migrate_config",
      arguments: {},
    });

    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0]!.text).toContain(
      "Provide either configPath or configContent",
    );
  });
});
