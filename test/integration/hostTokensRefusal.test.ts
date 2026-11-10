import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const configContent = { extends: ["github>acme/widgets"] };
const report = { repositories: {} };

let session: McpSession;
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), `rmcp-hosttokens-${process.pid}-`));
  await writeFile(path.join(repo, "renovate.json"), JSON.stringify(configContent));
  session = await startServer({ RENOVATE_MCP_HOST_TOKENS: "[{\"matchHost\":\"x\"}]" });
});

afterAll(async () => {
  await session?.close();
  await rm(repo, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await session.request<CallResult>("tools/call", { name, arguments: args });
  return res.result!;
}

const cases: Array<[string, Record<string, unknown>]> = [
  ["resolve_config", { configContent }],
  ["explain_config", { configContent }],
  ["resolve_config_diff", { before: { configContent }, after: { configContent } }],
  ["test_package_rules", { configContent, depName: "lodash" }],
  ["explain_paths", { repoPath: "<repo>" }],
  ["annotate_dry_run", { report, configContent }],
];

describe("malformed RENOVATE_MCP_HOST_TOKENS", () => {
  it.each(cases)("%s refuses with isError when externalPresets is true", async (name, args) => {
    const withRepo = JSON.parse(JSON.stringify(args).replace('"<repo>"', JSON.stringify(repo)));
    const result = await call(name, { ...withRepo, externalPresets: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/RENOVATE_MCP_HOST_TOKENS\[0\] must be an object/);
  });

  it.each(cases)("%s ignores it when externalPresets is off", async (name, args) => {
    const withRepo = JSON.parse(JSON.stringify(args).replace('"<repo>"', JSON.stringify(repo)));
    const result = await call(name, withRepo);
    expect(result.isError).toBeFalsy();
  });
});
