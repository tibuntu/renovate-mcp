import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { diffDryRunReports } from "../lib/dryRunDiff.js";
import { pathString, reportRecord } from "../lib/inputLimits.js";
import { readLogPath, readReportPath, reportPointer } from "../lib/reportInput.js";
import { OFFLINE_READ_ONLY_ANNOTATIONS } from "../lib/toolInputs.js";

const reportShape = reportRecord(
  "A Renovate dry-run report. Pass either the raw report (an object with a `repositories` key) or the full `dry_run` tool summary (an object with a `report` key); the tool unwraps `report` automatically.",
);

const reportPathShape = z
  .object({
    reportPath: pathString(
      "Absolute path to a JSON file containing the report. Pair with `dry_run`'s `reportOutputPath` to round-trip large reports without hitting MCP response-content caps.",
    ),
  })
  .describe(
    "Pointer to a report on disk. The tool reads the file and JSON-parses it before diffing.",
  );

const logPathShape = z
  .object({
    logPath: pathString(
      "Absolute path to a Renovate JSON-lines debug log from a real run (`LOG_LEVEL=debug LOG_FORMAT=json`); the tool rebuilds the report from it.",
    ),
  })
  .describe("Pointer to a Renovate debug log on disk, read as a report.");

// Path shapes first: a bare record would also match `{ reportPath }` /
// `{ logPath }` and the path branch would never be taken.
const reportInputSchema = z.union([reportPathShape, logPathShape, reportShape]);

async function resolveReport(
  side: "before" | "after",
  input: z.infer<typeof reportInputSchema>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const logPath = (input as Record<string, unknown>).logPath;
  const reportPath = typeof logPath === "string" ? undefined : reportPointer(input);
  if (typeof logPath !== "string" && reportPath === undefined) return { ok: true, value: input };
  const res = typeof logPath === "string" ? await readLogPath(logPath) : await readReportPath(reportPath!);
  return res.ok ? res : { ok: false, error: `\`${side}\`: ${res.error}` };
}

export function registerDryRunDiff(server: McpServer): void {
  server.registerTool(
    "dry_run_diff",
    {
      title: "Diff two Renovate dry-run reports",
      annotations: OFFLINE_READ_ONLY_ANNOTATIONS,
      description:
        "Compute a semantic diff between two `dry_run` reports — the proposed updates that were added, removed, or changed. Stateless: pass both reports as inputs. Each side accepts either the inline report (raw `{ repositories }` or a full `dry_run` summary with a `report` key) or `{ reportPath: \"<absolute path>\" }` pointing at a file produced by `dry_run`'s `reportOutputPath`. Or `{ logPath: \"<absolute path>\" }` pointing at a Renovate JSON-lines debug log (`LOG_LEVEL=debug LOG_FORMAT=json`) from a real bot run, which the tool reads as a report. Mix and match freely. Updates pair on `(manager, packageFile, depName)`, so a version bump on the same dep shows up under `changed` rather than as `removed + added`; several updates for one dep (minor and major) pair on `updateType` too. Compared fields per identity: `newValue`, `newVersion`, `updateType`, `branchName`, `groupName`, `schedule`. Returns a structured summary object plus a compact human-readable text rendering.",
      inputSchema: z.object({
        before: reportInputSchema,
        after: reportInputSchema,
      }),
    },
    async ({ before, after }) => {
      const [beforeRes, afterRes] = await Promise.all([
        resolveReport("before", before),
        resolveReport("after", after),
      ]);
      if (!beforeRes.ok) {
        return { isError: true, content: [{ type: "text", text: beforeRes.error }] };
      }
      if (!afterRes.ok) {
        return { isError: true, content: [{ type: "text", text: afterRes.error }] };
      }
      const diff = diffDryRunReports(beforeRes.value, afterRes.value);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(diff, null, 2),
          },
        ],
      };
    },
  );
}
