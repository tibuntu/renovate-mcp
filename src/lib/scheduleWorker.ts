import { DEFAULT_WORKER_TIMEOUT_MS, runRenovateWorker } from "./renovateWorker.js";

/**
 * Enumerates the next run windows of a Renovate `schedule` with Renovate's own
 * validators and matchers (`hasValidSchedule`, `hasValidTimezone`, `cronMatches`
 * from `renovate/dist/workers/repository/update/branch/schedule.js`, plus the
 * `@breejs/later` text matcher it ships) in a worker thread. Renovate's
 * `isScheduledNow` reads the wall clock, so the worker replicates its per-entry
 * check with an injectable instant and probes every local hour over the
 * horizon — Renovate forbids minutes in both schedule forms, so hourly probes
 * are exact. See ADR-0007.
 *
 * Same worker-isolation invariant as the other carve-outs: the main process
 * never imports `renovate`. There is no preview fallback — without the worker
 * nothing can evaluate a later-text schedule — so callers surface worker
 * failures as errors.
 */

/** Probe horizon: one full year, so any annual recurrence appears at least once. */
export const SCHEDULE_HORIZON_DAYS = 366;

export interface Instant {
  utc: string;
  /** Same instant rendered in the requested timezone, with offset. */
  local: string;
}

export interface ScheduleWindow {
  start: Instant;
  /** Exclusive. */
  end: Instant;
  hours: number;
}

export interface ScheduleExplainInput {
  schedule: string[];
  /** IANA zone the schedule is evaluated and rendered in. */
  timezone: string;
  fromMillis: number;
  /** Maximum number of windows to return. */
  count: number;
  timeoutMs?: number;
}

export interface ScheduleExplanation {
  from: Instant;
  valid: boolean;
  /** Renovate's own message when `valid` is false. */
  error?: string;
  /** `at any time` / empty: Renovate never consults the clock. */
  alwaysActive: boolean;
  activeNow: boolean;
  /** When `activeNow`: end (exclusive) of the window containing `from`; absent if still active at the horizon. */
  activeUntil?: Instant;
  /** Windows that start after `from`, in order. */
  windows: ScheduleWindow[];
  /** Fewer than `count` windows were found before the horizon ran out. */
  truncated: boolean;
}

/**
 * Worker entry, resolved per call. Overridable via
 * `RENOVATE_MCP_SCHEDULE_WORKER_ENTRY` for the same reason as the other
 * workers: vitest loads this module as TS source under `src/`, where the
 * compiled sibling `.js` does not exist.
 */
function workerEntry(): string | URL {
  return (
    process.env.RENOVATE_MCP_SCHEDULE_WORKER_ENTRY ??
    new URL("./scheduleWorkerImpl.js", import.meta.url)
  );
}

/** Throws `WorkerTimeoutError` on timeout or a plain Error on worker failure. */
export async function runScheduleExplain(input: ScheduleExplainInput): Promise<ScheduleExplanation> {
  const { timeoutMs, ...data } = input;
  const { result } = await runRenovateWorker<{ result: ScheduleExplanation }>(
    workerEntry(),
    { ...data, horizonHours: SCHEDULE_HORIZON_DAYS * 24 },
    { timeoutMs: timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS, label: "schedule explain" },
  );
  return result;
}
