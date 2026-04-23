import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";

export function registerDryRun(server: McpServer): void {
  server.registerTool(
    "dry_run",
    {
      title: "Dry-run Renovate",
      description:
        "Run Renovate in dry-run mode against a local repository to preview what it would do — no PRs opened, no git pushes. Uses --platform=local so no host token is required. Emits a structured JSON report of the updates Renovate would create.",
      inputSchema: {
        repoPath: z.string().describe("Absolute path to the repository root"),
        dryRunMode: z
          .enum(["extract", "lookup", "full"])
          .default("full")
          .describe(
            "extract = detect manifests only; lookup = resolve latest versions; full = full simulation including branches/PRs (default)",
          ),
        logLevel: z.enum(["info", "debug"]).default("info"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(15 * 60_000)
          .default(5 * 60_000)
          .describe("Max wait time in ms (default 5 minutes, capped at 15)"),
      },
    },
    async ({ repoPath, dryRunMode, logLevel, timeoutMs }) => {
      const reportPath = path.join(tmpdir(), `renovate-mcp-report-${randomUUID()}.json`);
      const bin = resolveRenovateTool("renovate");

      try {
        const result = await run(
          bin,
          [
            "--platform=local",
            `--dry-run=${dryRunMode}`,
            "--report-type=file",
            `--report-path=${reportPath}`,
          ],
          {
            cwd: repoPath,
            env: { LOG_LEVEL: logLevel, LOG_FORMAT: "json" },
            timeoutMs,
          },
        );

        let report: unknown = null;
        try {
          const raw = await fs.readFile(reportPath, "utf8");
          report = JSON.parse(raw);
        } catch {
          // no report produced (e.g., renovate errored before writing)
        }

        const summary: Record<string, unknown> = {
          exitCode: result.exitCode,
          hasReport: report !== null,
          report,
        };

        // If no structured report, surface the last bit of stderr so Claude can
        // debug without blowing up the context with Renovate's verbose logs.
        if (!report) {
          const tail = (result.stderr || result.stdout)
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-40)
            .join("\n");
          summary.logTail = tail;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2),
            },
          ],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: formatMissingBinaryError("renovate", err as Error),
            },
          ],
        };
      } finally {
        await fs.unlink(reportPath).catch(() => undefined);
      }
    },
  );
}
