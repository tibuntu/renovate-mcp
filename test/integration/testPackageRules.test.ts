import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), `rmcp-tpr-${process.pid}-`));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(scratch, { recursive: true, force: true });
});

type CallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function call(args: Record<string, unknown>): Promise<CallResult> {
  const res = await session.request<CallResult>("tools/call", {
    name: "test_package_rules",
    arguments: args,
  });
  return res.result!;
}

interface Body {
  matchQuality: string;
  ruleCount: number;
  matchedRuleCount: number;
  matchedRules: Array<{ index: number; matchedBy: string[]; contributedConfig?: Record<string, unknown> }>;
  unmatchedRules: Array<{ index: number; decidedBy: string[] }>;
  unevaluatable: Array<{ ruleIndex: number; matcher: string; reason: string }>;
  effectiveConfig: Record<string, unknown>;
  rendered?: {
    renderQuality: string;
    disclaimer: string;
    branchName: string;
    commitMessage: string;
    prTitle: string;
    groupName?: string;
    missingTemplateVariables: string[];
  };
  warnings: string[];
  path?: string;
}

describe("test_package_rules", () => {
  it("faithfully matches a rule against a synthetic dependency and reports its contribution", async () => {
    session = await startServer({});
    const result = await call({
      configContent: { packageRules: [{ matchPackageNames: ["lodash"], automerge: true }] },
      packageName: "lodash",
      depName: "lodash",
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.matchQuality).toBe("faithful");
    expect(body.ruleCount).toBe(1);
    expect(body.matchedRuleCount).toBe(1);
    expect(body.matchedRules[0]!.matchedBy).toContain("matchPackageNames");
    expect(body.matchedRules[0]!.contributedConfig).toEqual({ automerge: true });
  });

  it("distinguishes a real non-match from an unevaluatable matcher (missing field)", async () => {
    session = await startServer({});

    const decided = JSON.parse(
      (
        await call({
          configContent: { packageRules: [{ matchDatasources: ["docker"], automerge: true }] },
          datasource: "npm",
        })
      ).content[0]!.text,
    ) as Body;
    expect(decided.matchedRuleCount).toBe(0);
    expect(decided.unmatchedRules[0]!.decidedBy).toContain("matchDatasources");
    expect(decided.unevaluatable).toHaveLength(0);

    const missing = JSON.parse(
      (
        await call({
          configContent: { packageRules: [{ matchDatasources: ["docker"], automerge: true }] },
          depName: "lodash",
        })
      ).content[0]!.text,
    ) as Body;
    expect(missing.matchedRuleCount).toBe(0);
    expect(missing.unevaluatable[0]).toMatchObject({
      matcher: "matchDatasources",
      reason: "missing-input-field",
    });
  });

  it("expands extends so preset-provided packageRules are testable, and reads config from repoPath", async () => {
    await writeFile(
      path.join(scratch, "renovate.json"),
      JSON.stringify({ extends: [":automergeMinor"], packageRules: [{ matchManagers: ["npm"], automerge: true }] }),
    );
    session = await startServer({});
    const result = await call({ repoPath: scratch, manager: "npm", depName: "lodash" });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.path).toBe("renovate.json");
    // The user's own rule (matchManagers npm) must be present + matched.
    expect(body.matchedRules.some((r) => r.matchedBy.includes("matchManagers"))).toBe(true);
  });

  it("warns about deprecated matcher keys and points at migrate_config", async () => {
    session = await startServer({});
    const result = await call({
      configContent: { packageRules: [{ matchPackagePatterns: ["^@types/"], automerge: true }] },
      depName: "@types/node",
      packageName: "@types/node",
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.warnings.some((w) => /matchPackagePatterns/.test(w) && /migrate_config/.test(w))).toBe(true);
  });

  it("degrades to matchQuality preview when the worker is unavailable", async () => {
    session = await startServer({
      RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY: "/nonexistent/packageRulesWorkerImpl.js",
    });
    const result = await call({
      configContent: { packageRules: [{ matchPackageNames: ["lodash"], automerge: true }] },
      packageName: "lodash",
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.matchQuality).toBe("preview");
    expect(body.matchedRules[0]!.matchedBy).toContain("matchPackageNames");
  });

  it("returns isError when neither repoPath nor configContent is given", async () => {
    session = await startServer({});
    const result = await call({ depName: "lodash" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Provide either repoPath or configContent/);
  });

  it("renders the effective branch / commit / PR names from the repo's top-level config and matched rules", async () => {
    await writeFile(
      path.join(scratch, "renovate.json"),
      JSON.stringify({
        extends: [":semanticCommits"],
        branchPrefix: "deps/",
        packageRules: [{ matchPackageNames: ["lodash"], semanticCommitType: "fix" }],
      }),
    );
    session = await startServer({});
    const result = await call({
      repoPath: scratch,
      depName: "lodash",
      packageName: "lodash",
      datasource: "npm",
      manager: "npm",
      currentValue: "^4.0.0",
      newValue: "^5.0.0",
      newVersion: "5.0.0",
      updateType: "major",
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.rendered).toEqual({
      renderQuality: "preview",
      disclaimer: expect.stringMatching(/preview/i),
      branchName: "deps/lodash-5.x",
      commitMessage: "fix(deps): update dependency lodash to v5",
      prTitle: "fix(deps): update dependency lodash to v5",
      missingTemplateVariables: [],
    });
    expect(body.warnings.some((w) => /semanticCommits/.test(w))).toBe(false);
  });

  it("lists the post-lookup variables it could not fill and warns about semanticCommits auto", async () => {
    session = await startServer({});
    const result = await call({
      configContent: { packageRules: [] },
      depName: "lodash",
      newValue: "^5.0.0",
      updateType: "major",
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.rendered?.branchName).toBe("renovate/lodash-.x");
    expect(body.rendered?.missingTemplateVariables).toEqual(["newMajor"]);
    expect(body.warnings.some((w) => /semanticCommits/.test(w) && /"auto"/.test(w))).toBe(true);

    // An explicit commitMessagePrefix makes semanticCommits irrelevant to the
    // names, so the warning would be noise.
    const prefixed = JSON.parse(
      (
        await call({
          configContent: { commitMessagePrefix: "[deps]", packageRules: [] },
          depName: "lodash",
          newValue: "5.0.0",
          updateType: "major",
        })
      ).content[0]!.text,
    ) as Body;
    expect(prefixed.rendered?.commitMessage).toBe("[deps] Update dependency lodash to v5");
    expect(prefixed.warnings.some((w) => /semanticCommits/.test(w))).toBe(false);
  });

  it("keeps faithful matching and warns when a template cannot be rendered", async () => {
    session = await startServer({});
    const result = await call({
      configContent: {
        prTitle: "{{#if isMajor}}unclosed",
        packageRules: [{ matchPackageNames: ["lodash"], automerge: true }],
      },
      packageName: "lodash",
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.matchQuality).toBe("faithful");
    expect(body.matchedRuleCount).toBe(1);
    expect(body.rendered).toBeUndefined();
    expect(body.warnings.some((w) => /rendered/.test(w) && /Parse error/.test(w))).toBe(true);
  });

  it("omits rendered (and says so) when the worker is unavailable", async () => {
    session = await startServer({
      RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY: "/nonexistent/packageRulesWorkerImpl.js",
    });
    const result = await call({
      configContent: { packageRules: [{ matchPackageNames: ["lodash"], automerge: true }] },
      packageName: "lodash",
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.rendered).toBeUndefined();
    expect(body.warnings.some((w) => /rendered/.test(w))).toBe(true);
  });

  it("advertises the tool in the server instructions", async () => {
    session = await startServer({});
    expect(session.instructions).toContain("test_package_rules");
  });
});
