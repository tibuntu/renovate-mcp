import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), `rmcp-rcd-${process.pid}-`));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(scratch, { recursive: true, force: true });
});

type CallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function diff(before: unknown, after: unknown): Promise<CallResult> {
  const res = await session.request<CallResult>("tools/call", {
    name: "resolve_config_diff",
    arguments: { before, after },
  });
  return res.result!;
}

describe("resolve_config_diff", () => {
  it("diffs two inline configs differing in a scalar", async () => {
    session = await startServer({});
    const result = await diff(
      { configContent: { prHourlyLimit: 2 } },
      { configContent: { prHourlyLimit: 0 } },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as {
      summary: { fieldsChanged: number };
      fieldChanges: Array<{ key: string }>;
    };
    expect(body.summary.fieldsChanged).toBe(1);
    expect(body.fieldChanges[0]!.key).toBe("prHourlyLimit");
  });

  it("set-diffs packageRules between two inline configs", async () => {
    session = await startServer({});
    const result = await diff(
      { configContent: { packageRules: [{ matchManagers: ["npm"], automerge: true }] } },
      {
        configContent: {
          packageRules: [
            { matchManagers: ["npm"], automerge: true },
            { matchManagers: ["docker"], automerge: false },
          ],
        },
      },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as {
      arrayChanges: { packageRules?: { added: unknown[]; removed: unknown[] } };
    };
    expect(body.arrayChanges.packageRules!.added).toHaveLength(1);
    expect(body.arrayChanges.packageRules!.removed).toHaveLength(0);
  });

  it("resolves built-in extends faithfully and reports per-side mergeQuality", async () => {
    session = await startServer({});
    const result = await diff(
      { configContent: { extends: ["config:recommended"] } },
      { configContent: { extends: ["config:recommended"], prHourlyLimit: 0 } },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as {
      summary: { fieldsChanged: number };
      resolution: { before: { mergeQuality: string }; after: { mergeQuality: string } };
    };
    expect(body.resolution.before.mergeQuality).toBe("faithful");
    expect(body.resolution.after.mergeQuality).toBe("faithful");
    // Only prHourlyLimit should differ; config:recommended is identical on both sides.
    expect(body.summary.fieldsChanged).toBe(1);
  });

  it("resolves a side from repoPath (locates renovate.json) and diffs against inline content", async () => {
    await writeFile(
      path.join(scratch, "renovate.json"),
      JSON.stringify({ prHourlyLimit: 2 }),
    );
    session = await startServer({});
    const result = await diff(
      { repoPath: scratch },
      { configContent: { prHourlyLimit: 0 } },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as {
      summary: { fieldsChanged: number };
      resolution: { before: { path?: string } };
    };
    expect(body.summary.fieldsChanged).toBe(1);
    expect(body.resolution.before.path).toBe("renovate.json");
  });

  it("prefixes the text with a ⚠ advisory when a side has unresolved presets", async () => {
    session = await startServer({});
    const result = await diff(
      { configContent: { extends: ["bitbucket>owner/repo"] } },
      { configContent: { prHourlyLimit: 0 } },
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as {
      text: string;
      resolution: { before: { presetsUnresolved: unknown[] } };
    };
    expect(body.resolution.before.presetsUnresolved.length).toBeGreaterThan(0);
    expect(body.text.startsWith("⚠")).toBe(true);
    expect(body.text).toMatch(/unresolved presets/);
  });

  it("returns isError when a side has neither repoPath nor configContent", async () => {
    session = await startServer({});
    const result = await diff({}, { configContent: { prHourlyLimit: 0 } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Provide either repoPath or configContent for before/);
  });

  it("advertises the tool in the server instructions", async () => {
    session = await startServer({});
    expect(session.instructions).toContain("resolve_config_diff");
  });
});
