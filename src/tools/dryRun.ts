import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";
import { detectLookupProblems } from "../lib/lookupProblems.js";
import {
  collectSecrets,
  scrubSecrets,
  writeHostRulesConfig,
  type HostRule,
} from "../lib/hostRulesConfig.js";

const hostRuleSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "A single Renovate hostRule (matchHost, hostType, username, password, token, …). Structure is not validated here — Renovate's own config loader checks it when the temp file is read.",
  );

export function registerDryRun(server: McpServer): void {
  server.registerTool(
    "dry_run",
    {
      title: "Dry-run Renovate",
      description:
        "Run Renovate in dry-run mode against a local repository to preview what it would do — no PRs opened, no git pushes. Uses --platform=local so no host token is required. Emits a structured JSON report of the updates Renovate would create.\n\nCredentials for private registries (e.g. `COMPOSER_AUTH` for Packagist/Satis proxies, `NPM_TOKEN` / `.npmrc` for npm, Docker registry creds, `RENOVATE_HOST_RULES` for anything else) must be set on the MCP server process itself — via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Alternatively, encode credentials as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on this tool (written to a mode-0600 temp file that is cleaned up after the run; token/password values are scrubbed from `logTail` and `problems`). Per-call `hostRules` are appended to any the repo's own config already declares. If a lookup can't auth to a registry, Renovate often reports 0 updates without a loud error; when that happens this tool surfaces detected auth failures under `problems` in the output so callers can distinguish a genuine \"no updates\" from a silent registry-auth failure.",
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
        hostRules: z
          .array(hostRuleSchema)
          .optional()
          .describe(
            "Optional per-invocation Renovate hostRules for private registry auth. Written to a mode-0600 temp file that is passed via --config-file and deleted after the run. Token/password values are scrubbed from any log output this tool returns. Appended to (not replacing) any hostRules declared in the repo's own config.",
          ),
      },
    },
    async ({ repoPath, dryRunMode, logLevel, timeoutMs, hostRules }) => {
      const reportPath = path.join(tmpdir(), `renovate-mcp-report-${randomUUID()}.json`);
      const bin = resolveRenovateTool("renovate");
      const ruleList: HostRule[] = hostRules ?? [];
      const secrets = collectSecrets(ruleList);
      let hostRulesConfigPath: string | undefined;

      try {
        const args = [
          "--platform=local",
          `--dry-run=${dryRunMode}`,
          "--report-type=file",
          `--report-path=${reportPath}`,
        ];
        if (ruleList.length > 0) {
          hostRulesConfigPath = await writeHostRulesConfig(ruleList);
          args.push(`--config-file=${hostRulesConfigPath}`);
        }

        const result = await run(bin, args, {
          cwd: repoPath,
          env: { LOG_LEVEL: logLevel, LOG_FORMAT: "json" },
          timeoutMs,
        });

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

        const scrubbedStdout = scrubSecrets(result.stdout, secrets);
        const scrubbedStderr = scrubSecrets(result.stderr, secrets);

        const problems = detectLookupProblems(`${scrubbedStderr}\n${scrubbedStdout}`);
        if (problems.length > 0) {
          summary.problems = problems;
        }

        // If no structured report, surface the last bit of stderr so Claude can
        // debug without blowing up the context with Renovate's verbose logs.
        if (!report) {
          const tail = (scrubbedStderr || scrubbedStdout)
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
              text: scrubSecrets(
                formatMissingBinaryError("renovate", err),
                secrets,
              ),
            },
          ],
        };
      } finally {
        await fs.unlink(reportPath).catch(() => undefined);
        if (hostRulesConfigPath) {
          await fs.unlink(hostRulesConfigPath).catch(() => undefined);
        }
      }
    },
  );
}
