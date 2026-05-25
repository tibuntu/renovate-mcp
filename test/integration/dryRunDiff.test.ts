import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let scratch: string;
let session: McpSession;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), `rmcp-drd-${process.pid}-`));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(scratch, { recursive: true, force: true });
});

const REPORT_BEFORE = {
  repositories: {
    "owner/repo": {
      branches: [
        {
          branchName: "renovate/lodash",
          upgrades: [
            { manager: "npm", packageFile: "package.json", depName: "lodash", newVersion: "4.17.21" },
          ],
        },
      ],
    },
  },
};

const REPORT_AFTER = {
  repositories: {
    "owner/repo": {
      branches: [
        {
          branchName: "renovate/lodash",
          upgrades: [
            { manager: "npm", packageFile: "package.json", depName: "lodash", newVersion: "4.18.0" },
          ],
        },
      ],
    },
  },
};

describe("dry_run_diff path-based inputs", () => {
  it("accepts both sides as { reportPath }", async () => {
    const before = path.join(scratch, "before.json");
    const after = path.join(scratch, "after.json");
    await writeFile(before, JSON.stringify(REPORT_BEFORE));
    await writeFile(after, JSON.stringify(REPORT_AFTER));
    session = await startServer({});

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run_diff",
      arguments: { before: { reportPath: before }, after: { reportPath: after } },
    });

    expect(res.result?.isError).toBeFalsy();
    const body = JSON.parse(res.result!.content[0]!.text) as {
      summary: { changed: number };
      changed: Array<{ depName: string }>;
    };
    expect(body.summary.changed).toBe(1);
    expect(body.changed[0]?.depName).toBe("lodash");
  });

  it("accepts one side as path and one inline", async () => {
    const before = path.join(scratch, "before.json");
    await writeFile(before, JSON.stringify(REPORT_BEFORE));
    session = await startServer({});

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run_diff",
      arguments: { before: { reportPath: before }, after: REPORT_AFTER },
    });

    expect(res.result?.isError).toBeFalsy();
    const body = JSON.parse(res.result!.content[0]!.text) as { summary: { changed: number } };
    expect(body.summary.changed).toBe(1);
  });

  it("returns isError when a reportPath is unreadable", async () => {
    session = await startServer({});

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run_diff",
      arguments: {
        before: { reportPath: path.join(scratch, "missing.json") },
        after: REPORT_AFTER,
      },
    });

    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0]!.text).toMatch(/Could not read/);
  });

  it("returns isError when a reportPath file is not valid JSON", async () => {
    const bad = path.join(scratch, "bad.json");
    await writeFile(bad, "{not json");
    session = await startServer({});

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "dry_run_diff",
      arguments: { before: { reportPath: bad }, after: REPORT_AFTER },
    });

    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0]!.text).toMatch(/not valid JSON/);
  });
});
