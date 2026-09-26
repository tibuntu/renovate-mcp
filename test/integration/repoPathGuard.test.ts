import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * The shared input rules from src/lib/toolInputs.ts, exercised end-to-end over
 * stdio for every tool they apply to.
 */

// Built synchronously: the case tables below are evaluated at collection time.
const tmp = mkdtempSync(
  path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
);
const file = path.join(tmp, "file");
writeFileSync(file, "x");

let session: McpSession;

beforeAll(async () => {
  session = await startServer({}, { requestTimeoutMs: 30_000 });
});

afterAll(async () => {
  await session.close();
  await rm(tmp, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await session.request<ToolResult>("tools/call", { name, arguments: args });
  return res.result!;
}

const report = { repositories: {} };
const manager = { customType: "regex", managerFilePatterns: ["/x/"], matchStrings: ["x"] };

// Every tool that takes a repoPath, with the minimum of other inputs it needs
// to reach the guard. check_setup is deliberately absent: a diagnostic never
// returns isError.
const repoTools: Array<[string, (repoPath: string) => Record<string, unknown>]> = [
  ["read_config", (repoPath) => ({ repoPath })],
  ["resolve_config", (repoPath) => ({ repoPath })],
  ["explain_config", (repoPath) => ({ repoPath })],
  ["resolve_config_diff", (repoPath) => ({ before: { repoPath }, after: { configContent: {} } })],
  ["test_package_rules", (repoPath) => ({ repoPath })],
  ["annotate_dry_run", (repoPath) => ({ repoPath, report })],
  ["explain_dependency", (repoPath) => ({ repoPath, report, depName: "x" })],
  ["preview_custom_manager", (repoPath) => ({ repoPath, manager })],
  ["dry_run", (repoPath) => ({ repoPath })],
  ["write_config", (repoPath) => ({ repoPath, config: {} })],
];

describe("repoPath guard", () => {
  const badPaths: Array<[string, string]> = [
    ["relative path", "relative/repo"],
    ["nonexistent path", path.join(tmp, "missing")],
    ["file", file],
  ];

  for (const [name, args] of repoTools) {
    for (const [label, value] of badPaths) {
      it(`${name} rejects a ${label}`, async () => {
        const res = await call(name, args(value));
        expect(res.isError).toBe(true);
        expect(res.content[0]!.text).toContain(
          `repoPath must be an absolute path to an existing directory (got: ${value})`,
        );
      });
    }
  }
});

describe("config source not found", () => {
  const configTools: Array<[string, Record<string, unknown>]> = [
    ["resolve_config", {}],
    ["explain_config", {}],
    ["test_package_rules", {}],
    ["annotate_dry_run", { report }],
    ["explain_dependency", { report, depName: "x" }],
  ];

  for (const [name, extra] of configTools) {
    it(`${name} returns isError for a repo without config`, async () => {
      const res = await call(name, { ...extra, repoPath: tmp });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toBe(`No Renovate configuration found in ${tmp}.`);
    });
  }

  it("resolve_config_diff names the side", async () => {
    const res = await call("resolve_config_diff", {
      before: { configContent: {} },
      after: { repoPath: tmp },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(`after: No Renovate configuration found in ${tmp}.`);
  });
});

describe("path and inline inputs passed together", () => {
  const bothCases: Array<[string, Record<string, unknown>, string]> = [
    ["resolve_config", { repoPath: tmp, configContent: {} }, "repoPath or configContent"],
    ["explain_config", { repoPath: tmp, configContent: {} }, "repoPath or configContent"],
    ["test_package_rules", { repoPath: tmp, configContent: {} }, "repoPath or configContent"],
    ["annotate_dry_run", { report, repoPath: tmp, configContent: {} }, "repoPath or configContent"],
    ["explain_dependency", { report, depName: "x", repoPath: tmp, configContent: {} }, "repoPath or configContent"],
  ];

  for (const [name, args, pair] of bothCases) {
    it(`${name} rejects ${pair} together`, async () => {
      const res = await call(name, args);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain(`Pass either ${pair}, not both.`);
    });
  }

  it("resolve_config_diff rejects both inputs on one side and names it", async () => {
    const res = await call("resolve_config_diff", {
      before: { repoPath: tmp, configContent: {} },
      after: { configContent: {} },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe("before: Pass either repoPath or configContent, not both.");
  });
});
