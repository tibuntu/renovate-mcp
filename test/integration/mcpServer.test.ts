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
  it("lists all eleven tools with expected names", async () => {
    session = await startServer();
    const res = await session.request<{ tools: Array<{ name: string }> }>("tools/list");
    const names = (res.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "check_setup",
      "dry_run",
      "dry_run_diff",
      "explain_config",
      "get_version",
      "lint_config",
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

describe("startup instructions banner", () => {
  it("embeds the partial-availability notice when the Renovate CLI is missing", async () => {
    session = await startServer({
      RENOVATE_BIN: "/nonexistent/path/to/renovate",
      RENOVATE_CONFIG_VALIDATOR_BIN: "/nonexistent/path/to/validator",
      RENOVATE_MCP_REQUIRE_CLI: "",
    });
    expect(session.instructions).toContain("Partial availability");
    expect(session.instructions).toContain("read_config");
    expect(session.instructions).toMatch(/do not flag this as a setup problem/i);
  });

  it("suppresses the banner when RENOVATE_MCP_REQUIRE_CLI=false", async () => {
    session = await startServer({
      RENOVATE_BIN: "/nonexistent/path/to/renovate",
      RENOVATE_CONFIG_VALIDATOR_BIN: "/nonexistent/path/to/validator",
      RENOVATE_MCP_REQUIRE_CLI: "false",
    });
    expect(session.instructions).not.toContain("Partial availability");
    // BASE_INSTRUCTIONS content should still be present
    expect(session.instructions).toContain("Design and debug Renovate configurations");
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

describe("lint_config end-to-end", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "rmcp-lint-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("flags a malformed regex in matchPackageNames via configContent", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "lint_config",
      arguments: {
        configContent: {
          packageRules: [{ matchPackageNames: ["/devops\\/pipelines\\/.+"] }],
        },
      },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.clean).toBe(false);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "dead-regex-missing-slash",
      path: "packageRules[0].matchPackageNames[0]",
    });
  });

  it("returns clean:true for a schema-valid config with well-formed patterns", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "lint_config",
      arguments: {
        configContent: {
          extends: ["config:recommended"],
          packageRules: [
            { matchPackageNames: ["lodash", "/^@acme\\//"] },
          ],
        },
      },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.clean).toBe(true);
    expect(parsed.findings).toEqual([]);
  });

  it("lints a config from configPath on disk", async () => {
    const configPath = path.join(repo, "renovate.json");
    await writeFile(
      configPath,
      JSON.stringify({
        packageRules: [{ matchDepNames: ["foo.+"] }],
      }),
    );
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "lint_config",
      arguments: { configPath },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.clean).toBe(false);
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "unwrapped-regex",
      path: "packageRules[0].matchDepNames[0]",
    });
  });

  it("lints a .renovaterc.json5 file with JSON5-only syntax via configPath", async () => {
    const configPath = path.join(repo, ".renovaterc.json5");
    await writeFile(
      configPath,
      [
        "// Renovate config authored in JSON5",
        "{",
        "  extends: ['config:recommended'],",
        "  packageRules: [",
        "    {",
        "      // unwrapped regex — should trip the linter",
        "      matchDepNames: ['foo.+'],",
        "    },",
        "  ],",
        "}",
        "",
      ].join("\n"),
    );
    session = await startServer();
    const res = await session.request<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "lint_config",
      arguments: { configPath },
    });
    expect(res.result?.isError).toBeFalsy();
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.clean).toBe(false);
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "unwrapped-regex",
      path: "packageRules[0].matchDepNames[0]",
    });
  });

  it("reports isError with a helpful message for malformed JSON5", async () => {
    const configPath = path.join(repo, ".renovaterc.json5");
    await writeFile(configPath, "{ extends: ['config:recommended', }");
    session = await startServer();
    const res = await session.request<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "lint_config",
      arguments: { configPath },
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0]?.text).toContain("Failed to read or parse config at");
    expect(res.result?.content[0]?.text).toContain(configPath);
    expect(res.result?.content[0]?.text).toContain("JSON5:");
  });

  it("reports isError when neither input is supplied", async () => {
    session = await startServer();
    const res = await session.request<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }>("tools/call", { name: "lint_config", arguments: {} });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0]?.text).toContain("Provide either configPath");
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
    // Every response must carry the preview-quality marker so callers don't
    // treat `resolved` as bit-identical to Renovate's own output.
    expect(parsed.mergeQuality).toBe("preview");
    expect(parsed.disclaimer).toMatch(/dry_run/);
    expect(parsed.warnings).toEqual([]);
  });

  it("surfaces a structured warning when a preset's {{argN}} is unfilled", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "resolve_config",
      arguments: {
        configContent: { extends: ["default:followTag(lodash)"] },
      },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].preset).toBe("default:followTag(lodash)");
    expect(parsed.warnings[0].message).toMatch(/\{\{arg1\}\}/);
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

describe("explain_config end-to-end", () => {
  it("annotates each leaf with a setBy chain identifying the preset that set it", async () => {
    session = await startServer();
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "explain_config",
      arguments: {
        configContent: { extends: ["default:automergeAll"], automerge: false },
      },
    });
    const parsed = JSON.parse(res.result?.content[0]?.text ?? "{}");
    expect(parsed.explanation.automerge).toEqual({
      value: false,
      setBy: [
        { source: "default:automergeAll", via: [], value: true },
        { source: "<own>", via: [], value: false },
      ],
    });
    expect(parsed.presetsResolved).toContain("default:automergeAll");
    expect(parsed.mergeQuality).toBe("preview");
  });

  it("rejects calls that pass neither repoPath nor configContent", async () => {
    session = await startServer();
    const res = await session.request<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "explain_config",
      arguments: {},
    });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0]?.text).toMatch(/repoPath or configContent/);
  });
});

describe("dry_run_diff end-to-end", () => {
  function makeReport(upgrades: Array<Record<string, unknown>>): unknown {
    return {
      repositories: {
        "owner/repo": {
          branches: [{ branchName: "renovate/all", upgrades }],
        },
      },
    };
  }

  it("returns a structured diff with added/removed/changed plus a text rendering", async () => {
    session = await startServer();
    const before = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        currentVersion: "4.17.20",
        newVersion: "4.17.21",
        updateType: "patch",
      },
      { manager: "npm", packageFile: "package.json", depName: "axios", newVersion: "1.5.0" },
    ]);
    const after = makeReport([
      {
        manager: "npm",
        packageFile: "package.json",
        depName: "lodash",
        currentVersion: "4.17.20",
        newVersion: "4.18.0",
        updateType: "minor",
      },
      { manager: "npm", packageFile: "package.json", depName: "react", newVersion: "18.2.0" },
    ]);

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run_diff",
      arguments: { before, after },
    });

    expect(res.result?.isError).toBeFalsy();
    const parsed = JSON.parse(res.result!.content[0]!.text);
    expect(parsed.summary).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 0 });
    expect(parsed.added.map((u: { depName: string }) => u.depName)).toEqual(["react"]);
    expect(parsed.removed.map((u: { depName: string }) => u.depName)).toEqual(["axios"]);
    expect(parsed.changed[0].depName).toBe("lodash");
    expect(parsed.text).toContain("Added:");
    expect(parsed.text).toContain("Removed:");
    expect(parsed.text).toContain("Changed:");
  });

  it("accepts the full dry_run summary form (with `report` key) on either side", async () => {
    session = await startServer();
    const wrap = (report: unknown): unknown => ({
      ok: true,
      exitCode: 0,
      hasReport: true,
      report,
    });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
    }>("tools/call", {
      name: "dry_run_diff",
      arguments: {
        before: wrap(
          makeReport([
            { manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "1" },
          ]),
        ),
        after: wrap(
          makeReport([
            { manager: "npm", packageFile: "p.json", depName: "lodash", newVersion: "2" },
          ]),
        ),
      },
    });

    const parsed = JSON.parse(res.result!.content[0]!.text);
    expect(parsed.summary.changed).toBe(1);
    expect(parsed.changed[0].changes[0].field).toBe("newVersion");
  });
});
