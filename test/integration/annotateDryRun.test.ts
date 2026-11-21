import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { syntheticLog } from "../helpers/botLog.js";

let session: McpSession;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), `rmcp-adr-${process.pid}-`));
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
    name: "annotate_dry_run",
    arguments: args,
  });
  return res.result!;
}

// A minimal dry_run report with one npm upgrade carrying datasource.
function reportWith(upgrade: Record<string, unknown>): Record<string, unknown> {
  return {
    repositories: {
      "owner/repo": { branches: [{ upgrades: [upgrade] }] },
    },
  };
}

interface Body {
  matchQuality: string;
  reportSource: string;
  ruleCount: number;
  updateCount: number;
  annotations: Array<{
    depName: string;
    matchedRules: Array<{ index: number; matchedBy: string[] }>;
    unevaluatable: Array<{ ruleIndex: number; matcher: string; reason: string }>;
  }>;
  rulesNeverMatched: number[];
  fieldGaps: string[];
  warnings: string[];
  configPath?: string;
}

const LODASH = {
  manager: "npm",
  depName: "lodash",
  packageName: "lodash",
  packageFile: "package.json",
  datasource: "npm",
  currentVersion: "4.0.0",
  newVersion: "4.17.0",
  updateType: "minor",
};

describe("annotate_dry_run", () => {
  it("attributes each update to the packageRules that matched it", async () => {
    session = await startServer({});
    const result = await call({
      report: reportWith(LODASH),
      configContent: { packageRules: [{ matchDatasources: ["npm"], automerge: true }] },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.matchQuality).toBe("faithful");
    expect(body.reportSource).toBe("inline");
    expect(body.updateCount).toBe(1);
    expect(body.annotations[0]!.depName).toBe("lodash");
    expect(body.annotations[0]!.matchedRules[0]!.matchedBy).toContain("matchDatasources");
    expect(body.rulesNeverMatched).toEqual([]);
  });

  it("accepts a full dry_run summary (outer { report: … } wrapper)", async () => {
    session = await startServer({});
    const result = await call({
      report: { report: reportWith(LODASH) }, // wrapped form, as dry_run emits
      configContent: { packageRules: [{ matchDatasources: ["npm"], automerge: true }] },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.updateCount).toBe(1);
    expect(body.annotations[0]!.matchedRules[0]!.matchedBy).toContain("matchDatasources");
  });

  it("flags rules that never match and gaps in report-supplied fields", async () => {
    session = await startServer({});
    // Upgrade has no datasource; the rule needs it → unevaluatable + fieldGap.
    const upgradeNoDatasource = { manager: "npm", depName: "left-pad", packageFile: "package.json" };
    const result = await call({
      report: reportWith(upgradeNoDatasource),
      configContent: { packageRules: [{ matchDatasources: ["npm"], automerge: true }] },
    });
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.rulesNeverMatched).toEqual([0]);
    expect(body.fieldGaps).toContain("datasource");
    expect(body.annotations[0]!.unevaluatable[0]).toMatchObject({
      ruleIndex: 0,
      matcher: "matchDatasources",
      reason: "missing-input-field",
    });
  });

  it("reads the report from reportPath and the config from repoPath", async () => {
    const reportPath = path.join(scratch, "report.json");
    await writeFile(reportPath, JSON.stringify(reportWith(LODASH)));
    await writeFile(
      path.join(scratch, "renovate.json"),
      JSON.stringify({ packageRules: [{ matchManagers: ["npm"], automerge: true }] }),
    );
    session = await startServer({});
    const result = await call({ reportPath, repoPath: scratch });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.reportSource).toBe("reportPath");
    expect(body.configPath).toBe("renovate.json");
    expect(body.annotations[0]!.matchedRules[0]!.matchedBy).toContain("matchManagers");
  });

  it("reads a Renovate debug log from logPath as the report", async () => {
    const logPath = path.join(scratch, "bot.log");
    await writeFile(logPath, syntheticLog());
    session = await startServer({});
    const result = await call({
      logPath,
      configContent: { packageRules: [{ matchManagers: ["npm"], automerge: true }] },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.reportSource).toBe("logPath");
    // The log's branch upgrades carry no manager; it is recovered from packageFiles.
    expect(body.updateCount).toBe(4);
    expect(body.annotations[0]!.matchedRules[0]!.matchedBy).toContain("matchManagers");
    // The branch verdicts Renovate recorded ride along on each annotation.
    expect(body.annotations[0]).toMatchObject({ depName: "lodash", branchResult: "pending", prBlockedBy: "AwaitingTests" });
    expect(body.annotations[3]).toMatchObject({ depName: "chalk", branchResult: "pr-created" });
  });

  it("rejects logPath together with report, and a log without the debug lines", async () => {
    const logPath = path.join(scratch, "empty.log");
    await writeFile(logPath, "nothing useful\n");
    session = await startServer({});
    const both = await call({ report: reportWith(LODASH), logPath, configContent: {} });
    expect(both.isError).toBe(true);
    expect(both.content[0]!.text).toBe("Pass either report or logPath, not both.");
    const empty = await call({ logPath, configContent: {} });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]!.text).toMatch(/LOG_LEVEL=debug.*LOG_FORMAT=json/);
  });

  it("returns isError when no report is provided", async () => {
    session = await startServer({});
    const result = await call({ configContent: { packageRules: [] } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Provide either report or reportPath/);
  });

  it("returns isError when no config source is provided", async () => {
    session = await startServer({});
    const result = await call({ report: reportWith(LODASH) });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Provide either repoPath or configContent/);
  });

  it("advertises the tool in the server instructions", async () => {
    session = await startServer({});
    expect(session.instructions).toContain("annotate_dry_run");
  });
});
