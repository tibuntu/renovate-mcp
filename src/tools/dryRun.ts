import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";
import { detectLookupProblems } from "../lib/lookupProblems.js";

export function registerDryRun(server: McpServer): void {
  server.registerTool(
    "dry_run",
    {
      title: "Dry-run Renovate",
      description:
        "Run Renovate in dry-run mode against a local repository to preview what it would do — no PRs opened, no git pushes. Uses --platform=local so no host token is required. Emits a structured JSON report of the updates Renovate would create.\n\nCredentials for private registries (e.g. `COMPOSER_AUTH` for Packagist/Satis proxies, `NPM_TOKEN` / `.npmrc` for npm, Docker registry creds, `RENOVATE_HOST_RULES` for anything else) must be set on the MCP server process itself — via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Alternatively, encode credentials as `hostRules` in the Renovate config. If a lookup can't auth to a registry, Renovate often reports 0 updates without a loud error; when that happens this tool surfaces detected auth failures under `problems` in the output so callers can distinguish a genuine \"no updates\" from a silent registry-auth failure.",
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

        const problems = detectLookupProblems(`${result.stderr}\n${result.stdout}`);
        if (problems.length > 0) {
          summary.problems = problems;
        }

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
