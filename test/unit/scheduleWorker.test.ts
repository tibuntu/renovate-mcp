import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { isScheduledNow } from "renovate/dist/workers/repository/update/branch/schedule.js";
import {
  runScheduleExplain,
  SCHEDULE_HORIZON_DAYS,
  type ScheduleExplainInput,
} from "../../src/lib/scheduleWorker.js";
import { WorkerTimeoutError } from "../../src/lib/renovateWorker.js";

/**
 * The worker entry (dist/lib/scheduleWorkerImpl.js) is pointed at via
 * RENOVATE_MCP_SCHEDULE_WORKER_ENTRY in vitest.config.ts, because in the vitest
 * runtime `import.meta.url` resolves to the TS source under src/ where no
 * compiled sibling .js exists. `pretest` builds dist/ before the suite runs.
 */

// Thursday 2026-10-29 12:00 UTC. The next Monday is 2026-11-02; Europe/Berlin
// is back on CET (+01:00) by then, so "Monday 00:00 Berlin" is Sunday 23:00Z.
const FROM = Date.UTC(2026, 9, 29, 12, 0);

function explain(schedule: string[], overrides: Partial<ScheduleExplainInput> = {}) {
  return runScheduleExplain({ schedule, timezone: "UTC", fromMillis: FROM, count: 5, ...overrides });
}

describe("runScheduleExplain (worker-isolated faithful schedule windows)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("treats 'at any time' as always active with no windows to enumerate", async () => {
    const res = await explain(["at any time"]);
    expect(res).toMatchObject({ valid: true, alwaysActive: true, activeNow: true, windows: [], truncated: false });
  });

  it("enumerates weekly windows for a later-text schedule in the given timezone", async () => {
    const res = await explain(["before 4am on Monday"], { timezone: "Europe/Berlin" });
    expect(res.valid).toBe(true);
    expect(res.alwaysActive).toBe(false);
    expect(res.activeNow).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.windows).toHaveLength(5);
    expect(res.windows[0]).toEqual({
      start: { utc: "2026-11-01T23:00:00.000Z", local: "2026-11-02T00:00:00.000+01:00" },
      end: { utc: "2026-11-02T03:00:00.000Z", local: "2026-11-02T04:00:00.000+01:00" },
      hours: 4,
    });
    expect(res.windows[1]!.start.local).toBe("2026-11-09T00:00:00.000+01:00");
    expect(res.from).toEqual({ utc: "2026-10-29T12:00:00.000Z", local: "2026-10-29T13:00:00.000+01:00" });
  });

  it("yields identical windows for the cron and later-text spellings of one schedule", async () => {
    const text = await explain(["before 4am on Monday"], { timezone: "Europe/Berlin" });
    const cron = await explain(["* 0-3 * * 1"], { timezone: "Europe/Berlin" });
    expect(cron.windows).toEqual(text.windows);
  });

  it("applies Renovate's scheduleMappings table ('every month' → before 5am on the 1st)", async () => {
    const res = await explain(["every month"], { timezone: "Europe/Berlin" });
    expect(res.windows[0]).toEqual({
      start: { utc: "2026-10-31T23:00:00.000Z", local: "2026-11-01T00:00:00.000+01:00" },
      end: { utc: "2026-11-01T04:00:00.000Z", local: "2026-11-01T05:00:00.000+01:00" },
      hours: 5,
    });
  });

  it("reports activeNow + activeUntil when `from` falls inside a window, then lists the NEXT windows", async () => {
    // 10:00–15:00 UTC daily; FROM is Thu 12:00Z.
    const res = await explain(["after 10am and before 3pm"], { count: 2 });
    expect(res.activeNow).toBe(true);
    expect(res.activeUntil).toEqual({ utc: "2026-10-29T15:00:00.000Z", local: "2026-10-29T15:00:00.000Z" });
    expect(res.windows.map((w) => w.start.utc)).toEqual([
      "2026-10-30T10:00:00.000Z",
      "2026-10-31T10:00:00.000Z",
    ]);
  });

  it("surfaces a valid-but-never-firing schedule as zero windows (later ANDs 'after 10pm and before 5am')", async () => {
    const res = await explain(["after 10pm and before 5am every weekday"]);
    expect(res.valid).toBe(true);
    expect(res.activeNow).toBe(false);
    expect(res.windows).toEqual([]);
    expect(res.truncated).toBe(true);
  });

  it("stops after `count` windows and reports truncated when the horizon runs out first", async () => {
    const weekend = await explain(["every weekend"], { count: 2 });
    expect(weekend.windows).toHaveLength(2);
    expect(weekend.windows.every((w) => w.hours === 48)).toBe(true);
    expect(weekend.truncated).toBe(false);

    // Only one January 1st falls inside the horizon from late October.
    const annual = await explain(["on the first day of January"]);
    expect(annual.windows).toHaveLength(1);
    expect(annual.windows[0]!.start.utc).toBe("2027-01-01T00:00:00.000Z");
    expect(annual.truncated).toBe(true);
    expect(SCHEDULE_HORIZON_DAYS).toBe(366);
  });

  it("returns Renovate's own message for an invalid schedule instead of windows", async () => {
    const res = await explain(["0 3 * * *"]);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/has cron syntax, but doesn't have \* as minutes/);
    expect(res.windows).toEqual([]);
  });

  it("returns Renovate's own message for an unsupported timezone", async () => {
    const res = await explain(["before 4am"], { timezone: "Mars/Olympus" });
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/Unsupported timezone Mars\/Olympus/);
  });

  it("throws WorkerTimeoutError when the cold-load budget is exceeded", async () => {
    await expect(explain(["before 4am"], { timeoutMs: 1 })).rejects.toBeInstanceOf(WorkerTimeoutError);
  });

  it("rejects promptly when the worker exits non-zero without posting a result", async () => {
    vi.stubEnv(
      "RENOVATE_MCP_SCHEDULE_WORKER_ENTRY",
      resolve(process.cwd(), "test/fixtures/exit-one-worker.mjs"),
    );
    await expect(explain(["before 4am"], { timeoutMs: 2000 })).rejects.toThrow(/exited \(code 1\)/);
  });
});

describe("isScheduledNow parity oracle", () => {
  // Prove the worker's replication of isScheduledNow's per-entry check stays
  // faithful: at every window edge the worker reports, Renovate's real
  // isScheduledNow (clock pinned via vi.setSystemTime) must agree — active at
  // start and at the last hour, inactive one hour before start and at end.
  afterEach(() => vi.useRealTimers());

  const HOUR = 3_600_000;
  const cases: Array<{ schedule: string[]; timezone: string }> = [
    { schedule: ["before 4am on Monday"], timezone: "Europe/Berlin" },
    { schedule: ["* 0-3 * * 1"], timezone: "Europe/Berlin" },
    { schedule: ["after 10pm", "before 5am"], timezone: "America/New_York" },
    { schedule: ["every weekend"], timezone: "Asia/Kolkata" },
    { schedule: ["every month"], timezone: "UTC" },
  ];

  const oracle = (schedule: string[], timezone: string, millis: number): boolean => {
    vi.setSystemTime(millis);
    return isScheduledNow({ schedule, timezone });
  };

  for (const c of cases) {
    it(`agrees with isScheduledNow at every window edge: ${c.schedule.join(" | ")} (${c.timezone})`, async () => {
      const res = await runScheduleExplain({ ...c, fromMillis: FROM, count: 3 });
      expect(res.valid).toBe(true);
      expect(res.windows.length).toBeGreaterThan(0);
      for (const w of res.windows) {
        const start = Date.parse(w.start.utc);
        const end = Date.parse(w.end.utc);
        expect(oracle(c.schedule, c.timezone, start - HOUR), `${w.start.utc} - 1h`).toBe(false);
        expect(oracle(c.schedule, c.timezone, start), w.start.utc).toBe(true);
        expect(oracle(c.schedule, c.timezone, end - HOUR), `${w.end.utc} - 1h`).toBe(true);
        expect(oracle(c.schedule, c.timezone, end), w.end.utc).toBe(false);
      }
      expect(oracle(c.schedule, c.timezone, FROM)).toBe(res.activeNow);
    });
  }
});
