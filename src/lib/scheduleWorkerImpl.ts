import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import type { Instant, ScheduleExplanation, ScheduleWindow } from "./scheduleWorker.js";

/**
 * Worker entry point for `explain_schedule`. Imports Renovate's real schedule
 * validators and matchers and REPLICATES the per-entry check inside
 * `isScheduledNow` (`renovate/dist/workers/repository/update/branch/schedule.js`)
 * with an injectable instant — `isScheduledNow` itself reads `DateTime.local()`
 * and cannot be asked "would this match at time T?". See ADR-0007; the parity
 * oracle test pins the replication against `isScheduledNow` with a pinned clock.
 *
 * `@breejs/later`, `luxon` and `croner` are resolved relative to Renovate's own
 * schedule module, so the worker evaluates with exactly the copies Renovate
 * would, without adding them as direct dependencies.
 *
 * Kept deliberately narrow: no logger, no shared state, single request/response.
 * `scheduleWorker.ts` is the only caller; do not import this from anywhere in
 * the main process.
 */

interface WorkerData {
  schedule: string[];
  timezone: string;
  fromMillis: number;
  count: number;
  horizonHours: number;
}

// Luxon's DateTime, typed to the members this worker touches (luxon ships no types here).
interface Dt {
  plus(d: { hours: number }): Dt;
  startOf(unit: "hour"): Dt;
  setZone(zone: string, opts?: { keepLocalTime?: boolean }): Dt;
  toUTC(): Dt;
  toISO(): string;
  toMillis(): number;
  toJSDate(): Date;
}

interface Later {
  parse: { text(text: string): unknown };
  schedule(parsed: unknown): { isValid(d: Date): boolean };
}

const SCHEDULE_MODULE = "renovate/dist/workers/repository/update/branch/schedule.js";

// Mirrors the private `scheduleMappings` table in Renovate's schedule.js
// (reconciled against renovate@44.181.5). `hasValidSchedule` applies it
// internally; the matcher loop below must apply it the same way.
const SCHEDULE_MAPPINGS: Record<string, string> = {
  "every month": "before 5am on the first day of the month",
  monthly: "before 5am on the first day of the month",
};

const HOUR_MS = 3_600_000;

const { schedule, timezone, fromMillis, count, horizonHours } = workerData as WorkerData;

try {
  const { cronMatches, hasValidSchedule, hasValidTimezone } = await import(
    "renovate/dist/workers/repository/update/branch/schedule.js"
  );
  const { fixShortHours } = await import("renovate/dist/config/migration.js");
  const renovateRequire = createRequire(createRequire(import.meta.url).resolve(SCHEDULE_MODULE));
  const later = renovateRequire("@breejs/later") as Later;
  const { DateTime } = renovateRequire("luxon") as {
    DateTime: { fromMillis(ms: number, opts: { zone: string }): Dt };
  };
  const { CronPattern } = renovateRequire("croner") as { CronPattern: new (pattern: string) => unknown };

  const explain = (): ScheduleExplanation => {
    const tzOk = hasValidTimezone(timezone);
    const instant = (dt: Dt): Instant => ({ utc: dt.toUTC().toISO(), local: dt.toISO() });
    const at = (millis: number): Dt => DateTime.fromMillis(millis, { zone: tzOk[0] ? timezone : "utc" });
    const fromDt = at(fromMillis);
    const base: ScheduleExplanation = {
      from: instant(fromDt),
      valid: true,
      alwaysActive: false,
      activeNow: false,
      windows: [],
      truncated: false,
    };

    // Same gate order as isScheduledNow: the "no schedule" short-circuit looks
    // at the FIRST entry only (as upstream) and precedes validation, so
    // `["at any time"]` is never parsed; then schedule validity, then timezone.
    if (schedule.length === 0 || schedule[0] === "" || schedule[0] === "at any time") {
      return { ...base, alwaysActive: true, activeNow: true };
    }
    const schedOk = hasValidSchedule(schedule);
    if (!schedOk[0]) return { ...base, valid: false, error: schedOk[1] };
    if (!tzOk[0]) return { ...base, valid: false, error: tzOk[1] };

    // One matcher per entry, parsed once — the per-entry body of isScheduledNow.
    const matchers = schedule.map((text): ((now: Dt) => boolean) => {
      let isCron = true;
      try {
        new CronPattern(text);
      } catch {
        isCron = false;
      }
      if (isCron) return (now) => cronMatches(text, now, timezone);
      const parsed = later.schedule(later.parse.text(fixShortHours(SCHEDULE_MAPPINGS[text] ?? text)));
      // isScheduledNow hands later the zone-local wall time re-labelled as UTC.
      return (now) => parsed.isValid(now.setZone("utc", { keepLocalTime: true }).toJSDate());
    });
    const matches = (now: Dt): boolean => matchers.some((m) => m(now));

    // Hourly probes from the local hour containing `from`. Renovate forbids
    // minutes in both schedule forms, so every edge lies on a local hour.
    const activeNow = matches(fromDt);
    const floor = fromDt.startOf("hour");
    const windows: ScheduleWindow[] = [];
    let active = activeNow;
    let open: Dt | undefined;
    let activeUntil: Instant | undefined;
    for (let i = 1; i <= horizonHours && windows.length < count; i++) {
      const probe = floor.plus({ hours: i });
      const m = matches(probe);
      if (m && !active) {
        open = probe;
      } else if (!m && active) {
        if (open) {
          windows.push({
            start: instant(open),
            end: instant(probe),
            hours: (probe.toMillis() - open.toMillis()) / HOUR_MS,
          });
          open = undefined;
        } else {
          activeUntil = instant(probe);
        }
      }
      active = m;
    }
    return {
      ...base,
      activeNow,
      ...(activeUntil ? { activeUntil } : {}),
      windows,
      truncated: windows.length < count,
    };
  };

  parentPort!.postMessage({ ok: true, result: explain() });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error: message });
}
