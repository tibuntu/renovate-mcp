import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * `explain_schedule` runs Renovate's schedule parser/matcher inside a worker
 * thread (ADR-0007). These tests drive the real worker; cold-load of renovate's
 * module graph can take a few seconds, hence the generous request timeout.
 */

const REQUEST_TIMEOUT_MS = 60_000;

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

type CallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function call(args: Record<string, unknown>): Promise<CallResult> {
  const res = await session.request<CallResult>("tools/call", {
    name: "explain_schedule",
    arguments: args,
  });
  return res.result!;
}

interface Body {
  schedule: string[];
  timezone: string;
  timezoneAssumed: boolean;
  from: { utc: string; local: string };
  valid: boolean;
  error?: string;
  renovateBehavior?: string;
  alwaysActive: boolean;
  activeNow: boolean;
  activeUntil?: { utc: string; local: string };
  windows: Array<{ start: { utc: string; local: string }; end: { utc: string; local: string }; hours: number }>;
  horizonDays: number;
  truncated: boolean;
  warnings: string[];
  disclaimer: string;
}

describe("explain_schedule", () => {
  it("returns the next windows in UTC and the given timezone", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const result = await call({
      schedule: "before 4am on Monday",
      timezone: "Europe/Berlin",
      from: "2026-10-29T12:00:00Z",
      count: 2,
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.schedule).toEqual(["before 4am on Monday"]);
    expect(body.timezone).toBe("Europe/Berlin");
    expect(body.timezoneAssumed).toBe(false);
    expect(body.valid).toBe(true);
    expect(body.activeNow).toBe(false);
    expect(body.windows).toHaveLength(2);
    expect(body.windows[0]).toEqual({
      start: { utc: "2026-11-01T23:00:00.000Z", local: "2026-11-02T00:00:00.000+01:00" },
      end: { utc: "2026-11-02T03:00:00.000Z", local: "2026-11-02T04:00:00.000+01:00" },
      hours: 4,
    });
    expect(body.horizonDays).toBe(366);
    expect(body.truncated).toBe(false);
    expect(body.warnings).toEqual([]);
    expect(body.disclaimer).toMatch(/worker thread/);
  });

  it("assumes UTC when no timezone is given and says so", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const body = JSON.parse(
      (await call({ schedule: ["after 10pm", "before 5am"], from: "2026-10-29T12:00:00Z" })).content[0]!.text,
    ) as Body;
    expect(body.timezone).toBe("UTC");
    expect(body.timezoneAssumed).toBe(true);
    expect(body.warnings.some((w) => /timezone/.test(w))).toBe(true);
    expect(body.windows[0]!.start.utc).toBe("2026-10-29T22:00:00.000Z");
    expect(body.windows[0]!.hours).toBe(7);
  });

  it("reports an invalid schedule as valid:false with Renovate's message and its run-anyway behavior, not isError", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const result = await call({ schedule: "0 3 * * *" });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]!.text) as Body;
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/Invalid schedule/);
    expect(body.renovateBehavior).toMatch(/at any time/);
    expect(body.windows).toEqual([]);
  });

  it("returns isError for an unparseable `from`", async () => {
    session = await startServer({}, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const result = await call({ schedule: "before 4am", from: "yesterday-ish" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/from/);
  });

  it("returns isError when the worker is unavailable (no preview fallback)", async () => {
    session = await startServer(
      { RENOVATE_MCP_SCHEDULE_WORKER_ENTRY: "/nonexistent/scheduleWorkerImpl.js" },
      { requestTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    const result = await call({ schedule: "before 4am" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/explain_schedule failed/);
  });

  it("advertises the tool in the server instructions", async () => {
    session = await startServer();
    expect(session.instructions).toContain("explain_schedule");
  });
});
