import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), `rmcp-exd-${process.pid}-`));
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
    name: "explain_dependency",
    arguments: args,
  });
  return res.result!;
}

interface Body {
  depName: string;
  verdict: string;
  hints: string[];
  reportSource: string;
  matchQuality?: string;
  configPath?: string;
  hits: Array<{
    repository: string;
    manager: string;
    packageFile: string;
    depName: string;
    skipReason?: string;
    updates?: Array<{ newVersion?: string }>;
    matchedRules?: Array<{ index: number; matchedBy: string[] }>;
  }>;
  relatedProblems: unknown[];
  warnings: string[];
}

const LODASH = {
  depName: "lodash",
  packageName: "lodash",
  currentValue: "^4.0.0",
  currentVersion: "4.0.0",
  datasource: "npm",
  depType: "dependencies",
  updates: [{ newVersion: "4.17.21", newValue: "^4.17.21", updateType: "minor", branchName: "renovate/lodash-4.x" }],
  warnings: [],
};

function reportWith(...deps: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    problems: [],
    repositories: {
      "owner/repo": {
        problems: [],
        branches: [],
        packageFiles: { npm: [{ packageFile: "package.json", deps }] },
      },
    },
  };
}

describe("explain_dependency", () => {
  it("is listed by tools/list", async () => {
    session = await startServer({});
    const res = await session.request<{ tools: Array<{ name: string }> }>("tools/list", {});
    expect(res.result!.tools.map((t) => t.name)).toContain("explain_dependency");
  });

  it("explains an inline report hit with a verdict", async () => {
    session = await startServer({});
    const result = await call({ report: reportWith(LODASH), depName: "lodash" });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.depName).toBe("lodash");
    expect(body.reportSource).toBe("inline");
    expect(body.verdict).toBe("1 update available");
    expect(body.hits[0]).toMatchObject({ repository: "owner/repo", manager: "npm", packageFile: "package.json" });
    expect(body.hits[0]!.updates![0]!.newVersion).toBe("4.17.21");
    expect(body.hits[0]!.matchedRules).toBeUndefined();
    expect(body.matchQuality).toBeUndefined();
  });

  it("accepts the wrapped { report } form and reports skipped deps with a hint", async () => {
    session = await startServer({});
    const result = await call({
      report: { ok: true, report: reportWith({ depName: "lodash", skipReason: "ignored", updates: [] }) },
      depName: "lodash",
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.verdict).toBe("skipped: ignored");
    expect(body.hints.join("\n")).toMatch(/ignoreDeps/);
  });

  it("attaches matchedRules when a config source is given (reportPath + repoPath)", async () => {
    const reportPath = path.join(scratch, "report.json");
    await writeFile(reportPath, JSON.stringify(reportWith(LODASH)));
    await writeFile(
      path.join(scratch, "renovate.json"),
      JSON.stringify({ packageRules: [{ matchDatasources: ["npm"], automerge: true }, { matchManagers: ["docker"], enabled: false }] }),
    );
    session = await startServer({});
    const result = await call({ reportPath, repoPath: scratch, depName: "lodash" });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.reportSource).toBe("reportPath");
    expect(body.configPath).toBe("renovate.json");
    expect(body.matchQuality).toBe("faithful");
    expect(body.hits[0]!.matchedRules).toEqual([
      expect.objectContaining({ index: 0, matchedBy: ["matchDatasources"] }),
    ]);
  });

  it("returns not found with coverage hints", async () => {
    session = await startServer({});
    const result = await call({ report: reportWith(LODASH), depName: "left-pad" });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.hits).toEqual([]);
    expect(body.verdict).toBe("not found in report");
    expect(body.hints.join("\n")).toMatch(/enabledManagers/);
  });

  it("returns isError when neither report nor reportPath is provided", async () => {
    session = await startServer({});
    const result = await call({ depName: "lodash" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Provide either report or reportPath/);
  });

  it("advertises the tool in the server instructions", async () => {
    session = await startServer({});
    expect(session.instructions).toContain("explain_dependency");
  });
});
