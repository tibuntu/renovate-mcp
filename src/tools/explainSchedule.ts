import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runScheduleExplain, SCHEDULE_HORIZON_DAYS } from "../lib/scheduleWorker.js";
import {
  EXPLAIN_SCHEDULE_FAITHFUL_DISCLAIMER,
  OFFLINE_READ_ONLY_ANNOTATIONS,
} from "../lib/toolInputs.js";

const scheduleEntry = z.string().max(256);

const RENOVATE_BEHAVIOR_ON_INVALID =
  "Renovate logs this as a warning and then ignores the schedule entirely — the branch is treated as `at any time` and updated on every run.";

export function registerExplainSchedule(server: McpServer): void {
  server.registerTool(
    "explain_schedule",
    {
      title: "Explain when a Renovate schedule runs",
      annotations: OFFLINE_READ_ONLY_ANNOTATIONS,
      description:
        "Offline: given a Renovate `schedule` (later-text like `before 4am on Monday` or cron with `*` minutes; a string or array, the same shape as the `schedule` / `automergeSchedule` options and a packageRules entry's `schedule`) and an optional `timezone`, report whether it is active at `from` (default: now) and the next `count` run windows (default 5) as ISO timestamps in both UTC and the timezone. Evaluated with Renovate's own parser and matcher in a worker thread by probing every hour over a 366-day horizon, so the windows match what Renovate's isScheduledNow decides. An invalid schedule or timezone returns `valid: false` with Renovate's own message plus the reminder that Renovate then runs at any time. Without `timezone` the schedule is evaluated in UTC — what Renovate does when the config has no `timezone` and its runner's clock is UTC. Renovate only starts work on a run that falls inside a window, so the real PR time also depends on how often it runs.",
      inputSchema: {
        schedule: z
          .union([scheduleEntry, z.array(scheduleEntry).max(32)])
          .describe("The schedule to explain — a string or an array of strings, exactly as written in the config."),
        timezone: z
          .string()
          .max(128)
          .optional()
          .describe("IANA timezone, e.g. Europe/Berlin — the config's `timezone`. Defaults to UTC (reported as timezoneAssumed: true)."),
        from: z
          .string()
          .max(64)
          .optional()
          .describe("ISO 8601 instant to evaluate from, e.g. 2026-10-29T12:00:00Z. Defaults to now."),
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many upcoming windows to return (1–50, default 5)."),
      },
    },
    async ({ schedule, timezone, from, count }) => {
      const fromMillis = from === undefined ? Date.now() : Date.parse(from);
      if (Number.isNaN(fromMillis)) {
        return {
          isError: true,
          content: [{ type: "text", text: `from must be an ISO 8601 timestamp (got: ${from})` }],
        };
      }
      const entries = Array.isArray(schedule) ? schedule : [schedule];
      const effectiveTimezone = timezone ?? "UTC";

      try {
        const r = await runScheduleExplain({
          schedule: entries,
          timezone: effectiveTimezone,
          fromMillis,
          count: count ?? 5,
        });

        const warnings: string[] = [];
        if (timezone === undefined) {
          warnings.push(
            "No timezone given: windows are evaluated in UTC, which is what Renovate does when the config sets no `timezone` and its runner's clock is UTC (the hosted app and most containers). Pass `timezone` to see local windows.",
          );
        }
        if (r.valid && !r.alwaysActive && !r.activeNow && r.windows.length === 0) {
          warnings.push(
            `The schedule never fires in the next ${SCHEDULE_HORIZON_DAYS} days. A single entry that combines \`after …\` and \`before …\` (e.g. \`after 10pm and before 5am\`) is ANDed by Renovate's parser and can never match — split it into two entries.`,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  schedule: entries,
                  timezone: effectiveTimezone,
                  timezoneAssumed: timezone === undefined,
                  from: r.from,
                  valid: r.valid,
                  ...(r.error ? { error: r.error, renovateBehavior: RENOVATE_BEHAVIOR_ON_INVALID } : {}),
                  alwaysActive: r.alwaysActive,
                  activeNow: r.activeNow,
                  ...(r.activeUntil ? { activeUntil: r.activeUntil } : {}),
                  windows: r.windows,
                  horizonDays: SCHEDULE_HORIZON_DAYS,
                  truncated: r.truncated,
                  warnings,
                  disclaimer: EXPLAIN_SCHEDULE_FAITHFUL_DISCLAIMER,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `explain_schedule failed: ${(err as Error).message}` }],
        };
      }
    },
  );
}
