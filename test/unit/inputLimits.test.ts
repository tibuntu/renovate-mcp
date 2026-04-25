import { describe, expect, it } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  CONFIG_JSON_MAX_BYTES,
  ENDPOINT_MAX_BYTES,
  FILENAME_MAX_BYTES,
  HOST_RULES_MAX_ITEMS,
  HOST_RULE_JSON_MAX_BYTES,
  PATH_MAX_BYTES,
  REPORT_JSON_MAX_BYTES,
  REPOSITORY_MAX_BYTES,
  TOKEN_MAX_BYTES,
  configRecord,
  endpointString,
  filenameString,
  hostRuleRecord,
  pathString,
  repositoryString,
  reportRecord,
  tokenString,
} from "../../src/lib/inputLimits.js";

import { registerDryRun } from "../../src/tools/dryRun.js";
import { registerDryRunDiff } from "../../src/tools/dryRunDiff.js";
import { registerExplainConfig } from "../../src/tools/explainConfig.js";
import { registerLintConfig } from "../../src/tools/lintConfig.js";
import { registerPreviewCustomManager } from "../../src/tools/previewCustomManager.js";
import { registerReadConfig } from "../../src/tools/readConfig.js";
import { registerResolveConfig } from "../../src/tools/resolveConfig.js";
import { registerValidateConfig } from "../../src/tools/validateConfig.js";
import { registerWriteConfig } from "../../src/tools/writeConfig.js";

interface CapturedTool {
  name: string;
  inputSchema: z.ZodObject<ZodRawShape>;
}

function captureTool(register: (server: McpServer) => void): CapturedTool {
  let captured: CapturedTool | null = null;
  const fakeServer = {
    registerTool: (
      name: string,
      config: { inputSchema: ZodRawShape },
    ) => {
      captured = { name, inputSchema: z.object(config.inputSchema) };
    },
  } as unknown as McpServer;
  register(fakeServer);
  if (!captured) throw new Error("register did not call registerTool");
  return captured;
}

const oversizedString = (n: number) => "x".repeat(n + 1);
const fatRecord = (jsonSize: number) => ({
  blob: "y".repeat(jsonSize),
});

describe("inputLimits helpers", () => {
  it("pathString rejects strings over PATH_MAX_BYTES", () => {
    expect(pathString("p").safeParse(oversizedString(PATH_MAX_BYTES)).success).toBe(false);
    expect(pathString("p").safeParse("x".repeat(PATH_MAX_BYTES)).success).toBe(true);
  });

  it("tokenString rejects strings over TOKEN_MAX_BYTES", () => {
    expect(tokenString("t").safeParse(oversizedString(TOKEN_MAX_BYTES)).success).toBe(false);
    expect(tokenString("t").safeParse("x".repeat(TOKEN_MAX_BYTES)).success).toBe(true);
  });

  it("endpointString rejects strings over ENDPOINT_MAX_BYTES", () => {
    expect(endpointString("e").safeParse(oversizedString(ENDPOINT_MAX_BYTES)).success).toBe(false);
    expect(endpointString("e").safeParse("x".repeat(ENDPOINT_MAX_BYTES)).success).toBe(true);
  });

  it("repositoryString rejects strings over REPOSITORY_MAX_BYTES", () => {
    expect(
      repositoryString("r").safeParse(oversizedString(REPOSITORY_MAX_BYTES)).success,
    ).toBe(false);
    expect(repositoryString("r").safeParse("x".repeat(REPOSITORY_MAX_BYTES)).success).toBe(true);
  });

  it("filenameString rejects strings over FILENAME_MAX_BYTES", () => {
    expect(
      filenameString("f").safeParse(oversizedString(FILENAME_MAX_BYTES)).success,
    ).toBe(false);
    expect(filenameString("f").safeParse("x".repeat(FILENAME_MAX_BYTES)).success).toBe(true);
  });

  it("configRecord rejects records whose JSON size exceeds CONFIG_JSON_MAX_BYTES", () => {
    const reject = configRecord("c").safeParse(fatRecord(CONFIG_JSON_MAX_BYTES + 1));
    expect(reject.success).toBe(false);
    const accept = configRecord("c").safeParse({ extends: ["config:recommended"] });
    expect(accept.success).toBe(true);
  });

  it("reportRecord rejects records whose JSON size exceeds REPORT_JSON_MAX_BYTES", () => {
    const reject = reportRecord("r").safeParse(fatRecord(REPORT_JSON_MAX_BYTES + 1));
    expect(reject.success).toBe(false);
    const accept = reportRecord("r").safeParse({ repositories: [] });
    expect(accept.success).toBe(true);
  });

  it("hostRuleRecord rejects records whose JSON size exceeds HOST_RULE_JSON_MAX_BYTES", () => {
    const reject = hostRuleRecord("h").safeParse(fatRecord(HOST_RULE_JSON_MAX_BYTES + 1));
    expect(reject.success).toBe(false);
    const accept = hostRuleRecord("h").safeParse({
      matchHost: "example.com",
      token: "t",
    });
    expect(accept.success).toBe(true);
  });
});

describe("tool input schemas — DoS caps", () => {
  it("read_config: rejects oversized repoPath", () => {
    const tool = captureTool(registerReadConfig);
    const res = tool.inputSchema.safeParse({ repoPath: oversizedString(PATH_MAX_BYTES) });
    expect(res.success).toBe(false);
  });

  it("validate_config: rejects oversized configPath and oversized configContent", () => {
    const tool = captureTool(registerValidateConfig);
    expect(
      tool.inputSchema.safeParse({ configPath: oversizedString(PATH_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ configContent: fatRecord(CONFIG_JSON_MAX_BYTES + 1) }).success,
    ).toBe(false);
  });

  it("lint_config: rejects oversized configPath and oversized configContent", () => {
    const tool = captureTool(registerLintConfig);
    expect(
      tool.inputSchema.safeParse({ configPath: oversizedString(PATH_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ configContent: fatRecord(CONFIG_JSON_MAX_BYTES + 1) }).success,
    ).toBe(false);
  });

  it("resolve_config: rejects oversized repoPath, endpoint, and configContent", () => {
    const tool = captureTool(registerResolveConfig);
    expect(
      tool.inputSchema.safeParse({ repoPath: oversizedString(PATH_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ endpoint: oversizedString(ENDPOINT_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ configContent: fatRecord(CONFIG_JSON_MAX_BYTES + 1) }).success,
    ).toBe(false);
  });

  it("explain_config: rejects oversized repoPath, endpoint, and configContent", () => {
    const tool = captureTool(registerExplainConfig);
    expect(
      tool.inputSchema.safeParse({ repoPath: oversizedString(PATH_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ endpoint: oversizedString(ENDPOINT_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ configContent: fatRecord(CONFIG_JSON_MAX_BYTES + 1) }).success,
    ).toBe(false);
  });

  it("preview_custom_manager: rejects oversized repoPath", () => {
    const tool = captureTool(registerPreviewCustomManager);
    const res = tool.inputSchema.safeParse({
      repoPath: oversizedString(PATH_MAX_BYTES),
      manager: {
        customType: "regex",
        fileMatch: ["foo"],
        matchStrings: ["bar"],
      },
    });
    expect(res.success).toBe(false);
  });

  it("write_config: rejects oversized repoPath, filename, and config", () => {
    const tool = captureTool(registerWriteConfig);
    expect(
      tool.inputSchema.safeParse({
        repoPath: oversizedString(PATH_MAX_BYTES),
        config: {},
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        config: {},
        filename: oversizedString(FILENAME_MAX_BYTES),
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        config: fatRecord(CONFIG_JSON_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  it("dry_run: rejects oversized repoPath, endpoint, token, repository, and overlong hostRules", () => {
    const tool = captureTool(registerDryRun);
    expect(
      tool.inputSchema.safeParse({ repoPath: oversizedString(PATH_MAX_BYTES) }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        endpoint: oversizedString(ENDPOINT_MAX_BYTES),
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        token: oversizedString(TOKEN_MAX_BYTES),
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        repository: oversizedString(REPOSITORY_MAX_BYTES),
      }).success,
    ).toBe(false);

    const tooManyRules = Array.from({ length: HOST_RULES_MAX_ITEMS + 1 }, () => ({
      matchHost: "example.com",
    }));
    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        hostRules: tooManyRules,
      }).success,
    ).toBe(false);

    expect(
      tool.inputSchema.safeParse({
        repoPath: "/tmp/repo",
        hostRules: [fatRecord(HOST_RULE_JSON_MAX_BYTES + 1)],
      }).success,
    ).toBe(false);
  });

  it("dry_run_diff: rejects oversized before / after reports", () => {
    const tool = captureTool(registerDryRunDiff);
    expect(
      tool.inputSchema.safeParse({
        before: fatRecord(REPORT_JSON_MAX_BYTES + 1),
        after: { repositories: [] },
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        before: { repositories: [] },
        after: fatRecord(REPORT_JSON_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
  });
});
