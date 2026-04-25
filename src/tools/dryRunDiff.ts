import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { diffDryRunReports } from "../lib/dryRunDiff.js";

const reportShape = z
  .record(z.string(), z.unknown())
  .describe(
    "A Renovate dry-run report. Pass either the raw report (an object with a `repositories` key) or the full `dry_run` tool summary (an object with a `report` key); the tool unwraps `report` automatically.",
  );

export function registerDryRunDiff(server: McpServer): void {
  server.registerTool(
    "dry_run_diff",
    {
      title: "Diff two Renovate dry-run reports",
      description:
        "Compute a semantic diff between two `dry_run` reports — the proposed updates that were added, removed, or changed. Stateless: pass both reports as inputs. Updates are keyed by `(manager, packageFile, depName)`, so a version bump on the same dep shows up under `changed` rather than as `removed + added`. Compared fields per identity: `newValue`, `newVersion`, `updateType`, `branchName`, `groupName`, `schedule`. Returns a structured summary object plus a compact human-readable text rendering. Useful when iterating on a Renovate config: capture a `dry_run`, tweak the config, run again, then feed both reports here to see exactly what your tweaks did.",
      inputSchema: {
        before: reportShape,
        after: reportShape,
      },
    },
    async ({ before, after }) => {
      const diff = diffDryRunReports(before, after);
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
