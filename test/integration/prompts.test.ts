import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

interface PromptSummary {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

describe("MCP prompts", () => {
  it("advertises the prompts capability on initialize", async () => {
    session = await startServer();
    expect(session.capabilities).toHaveProperty("prompts");
  });

  it("lists exactly the four workflow prompts with the right required flags", async () => {
    session = await startServer();
    const res = await session.request<{ prompts: PromptSummary[] }>("prompts/list");
    const prompts = res.result?.prompts ?? [];
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([
      "author-custom-manager",
      "debug-package-rule",
      "design-renovate-config",
      "onboard-repo",
    ]);

    const byName = (name: string) => prompts.find((p) => p.name === name)!;
    const requiredFlag = (prompt: PromptSummary, argName: string) =>
      prompt.arguments?.find((a) => a.name === argName)?.required;

    const design = byName("design-renovate-config");
    expect(requiredFlag(design, "repoPath")).toBe(true);
    expect(requiredFlag(design, "intent")).toBeFalsy();

    const debug = byName("debug-package-rule");
    expect(requiredFlag(debug, "repoPath")).toBe(true);
    expect(requiredFlag(debug, "depName")).toBeFalsy();

    const author = byName("author-custom-manager");
    expect(requiredFlag(author, "repoPath")).toBe(true);
    expect(requiredFlag(author, "description")).toBe(true);

    const onboard = byName("onboard-repo");
    expect(requiredFlag(onboard, "repoPath")).toBe(true);
    expect(requiredFlag(onboard, "intent")).toBeFalsy();
  });

  it("returns a user message driving the onboarding sequence for onboard-repo", async () => {
    session = await startServer();
    const res = await session.request<{
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    }>("prompts/get", {
      name: "onboard-repo",
      arguments: { repoPath: "/tmp/new-repo" },
    });
    const messages = res.result?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    const text = messages[0]?.content.text ?? "";
    for (const needle of [
      "/tmp/new-repo",
      "check_setup",
      "read_config",
      "dry_run",
      "extract",
      "suggest_presets",
      "lint_config",
      "validate_config",
      "write_config",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("returns a user message naming check_setup and the given repoPath for design-renovate-config", async () => {
    session = await startServer();
    const res = await session.request<{
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    }>("prompts/get", {
      name: "design-renovate-config",
      arguments: { repoPath: "/tmp/example" },
    });
    const messages = res.result?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content.text).toContain("/tmp/example");
    expect(messages[0]?.content.text).toContain("check_setup");
  });

  it("errors when a required argument is missing", async () => {
    session = await startServer();
    const res = await session.request("prompts/get", {
      name: "design-renovate-config",
      arguments: {},
    });
    expect(res.error).toBeDefined();
  });
});
