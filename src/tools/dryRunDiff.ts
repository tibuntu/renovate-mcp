import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { diffDryRunReports } from "../lib/dryRunDiff.js";
import { pathString, reportRecord } from "../lib/inputLimits.js";

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

const reportInputSchema = z.union([reportShape, reportPathShape]);

async function resolveReport(
  side: "before" | "after",
  input: z.infer<typeof reportInputSchema>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (input && typeof input === "object" && "reportPath" in input && typeof input.reportPath === "string") {
    const reportPath = input.reportPath;
    let raw: string;
    try {
      raw = await fs.readFile(reportPath, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `Could not read \`${side}.reportPath\` (\`${reportPath}\`): ${(err as Error).message}.`,
      };
    }
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
      return {
        ok: false,
        error: `\`${side}.reportPath\` (\`${reportPath}\`) is not valid JSON: ${(err as Error).message}.`,
      };
    }
  }
  return { ok: true, value: input };
}

export function registerDryRunDiff(server: McpServer): void {
  server.registerTool(
    "dry_run_diff",
    {
      title: "Diff two Renovate dry-run reports",
      description:
        "Compute a semantic diff between two `dry_run` reports — the proposed updates that were added, removed, or changed. Stateless: pass both reports as inputs. Each side accepts either the inline report (raw `{ repositories }` or a full `dry_run` summary with a `report` key) or `{ reportPath: \"<absolute path>\" }` pointing at a file produced by `dry_run`'s `reportOutputPath`. Mix and match freely. Updates are keyed by `(manager, packageFile, depName)`, so a version bump on the same dep shows up under `changed` rather than as `removed + added`. Compared fields per identity: `newValue`, `newVersion`, `updateType`, `branchName`, `groupName`, `schedule`. Returns a structured summary object plus a compact human-readable text rendering.",
      inputSchema: {
        before: reportInputSchema,
        after: reportInputSchema,
      },
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
