import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, resolveRenovateTool, formatMissingBinaryError } from "../lib/renovateCli.js";
import { resolveCredential } from "../lib/credentialResolver.js";
import { locateConfig } from "../lib/configLocations.js";
import { detectLookupProblems } from "../lib/lookupProblems.js";
import {
  collectSecrets,
  scrubSecrets,
  writeHostRulesConfig,
  type HostRule,
} from "../lib/hostRulesConfig.js";
import {
  extractRenovateLogMsg,
  buildDryRunHeartbeatMessage,
} from "../lib/dryRunProgress.js";
import {
  HOST_RULES_MAX_ITEMS,
  endpointString,
  hostRuleRecord,
  pathString,
  repositoryString,
  tokenString,
} from "../lib/inputLimits.js";

const hostRuleSchema = hostRuleRecord(
  "A single Renovate hostRule (matchHost, hostType, username, password, token, …). Structure is not validated here — Renovate's own config loader checks it when the temp file is read.",
);

/**
 * Walk Renovate's JSON report looking for `problems` arrays and collect the
 * ones that represent failed runs — not informational notices. Criteria:
 *   - `level >= 40` (Renovate's bunyan-derived ERROR/FATAL bands), or
 *   - `message === "config-validation"` (Renovate's canonical config-failure
 *     marker — it can appear with lower levels but still means the run was
 *     effectively a no-op), or
 *   - the problem object has a `validationError` field (preset/extends
 *     resolution failures carry their explanation here).
 *
 * The report shape isn't a stable Renovate API, so we walk defensively: any
 * nested `problems` array anywhere in the tree is inspected.
 */
function collectReportErrors(report: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const obj = node as Record<string, unknown>;
    const problems = obj.problems;
    if (Array.isArray(problems)) {
      for (const raw of problems) {
        if (!raw || typeof raw !== "object") continue;
        const p = raw as Record<string, unknown>;
        const level = typeof p.level === "number" ? p.level : 0;
        const isErrorLevel = level >= 40;
        const isConfigValidation = p.message === "config-validation";
        const hasValidationError =
          typeof p.validationError === "string" && p.validationError.length > 0;
        if (isErrorLevel || isConfigValidation || hasValidationError) {
          out.push(p);
        }
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(report);
  return out;
}

/**
 * Scan the repo's Renovate config for `extends` entries of the form
 * `local>owner/repo[:preset]` and return them along with the config-file path
 * they were found in. Returns `null` if no config is found (Renovate will
 * handle that case itself with its usual error). Silently returns `null` on
 * parse errors too — we don't want preflight to be stricter than Renovate's
 * own config loader; any real problems will surface when Renovate runs.
 */
async function detectUnresolvableLocalPresets(
  repoPath: string,
): Promise<{ relPath: string; presets: string[] } | null> {
  let located;
  try {
    located = await locateConfig(repoPath);
  } catch {
    return null;
  }
  if (!located) return null;

  const extendsRaw = (located.config as { extends?: unknown }).extends;
  if (!Array.isArray(extendsRaw)) return null;

  const presets = extendsRaw.filter(
    (entry): entry is string => typeof entry === "string" && entry.startsWith("local>"),
  );
  return { relPath: located.relPath, presets };
}

export function registerDryRun(server: McpServer): void {
  server.registerTool(
    "dry_run",
    {
      title: "Dry-run Renovate",
      description:
        "Run Renovate in dry-run mode to preview what it would do — no PRs opened, no git pushes. Returns a structured JSON report plus a top-level `ok` boolean (false when the CLI failed OR the report records a validation/error-level problem, even if the exit code was 0).\n\nDefault mode runs `--platform=local` against the filesystem at `repoPath`. If your config extends `local>…` presets, pass `platform` (`github` or `gitlab`), `endpoint` (API base URL), `token`, and `repository` to run as a real platform client that can actually fetch those presets — Renovate still runs with `--dry-run`, so no PRs are opened. If you only need `gitlab>…` / `github>…` presets resolved against a self-hosted host (not a full remote run), pass just `endpoint` (and `token` if needed) while leaving `platform` unset — both flow through to Renovate in local mode too, which is enough to redirect those preset shortcuts away from the public defaults. The tool preflight-checks for `local>` presets under `--platform=local` (in `lookup` and `full` modes) and fails fast with remediation guidance rather than spawning a Renovate run that would fail opaquely with `config-validation`. The preflight is skipped for `dryRunMode=extract` so manifest-only extraction can be attempted regardless.\n\nWhen the `token` input is omitted, the tool falls back to `RENOVATE_TOKEN` from the MCP server's env, then to `GITLAB_TOKEN` (when `platform=gitlab`) or `GITHUB_TOKEN` (when `platform=github`) — whichever is auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI. This matches the precedence `resolve_config` already uses, so a single `GITLAB_TOKEN` in `.mcp.json` works for both tools. For a remote-platform run, an actionable preflight error is returned before spawning Renovate when no token can be resolved at all.\n\nCredentials for private registries (e.g. `COMPOSER_AUTH` for Packagist/Satis proxies, `NPM_TOKEN` / `.npmrc` for npm, Docker registry creds, `RENOVATE_HOST_RULES` for anything else) must be set on the MCP server process itself — via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Alternatively, encode credentials as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on this tool (written to a mode-0600 temp file that is cleaned up after the run; token/password values — including the platform `token` input — are scrubbed from `logTail` and `problems`). Per-call `hostRules` are appended to any the repo's own config already declares. If a lookup can't auth to a registry, Renovate often reports 0 updates without a loud error; when that happens this tool surfaces detected auth failures under `problems` in the output so callers can distinguish a genuine \"no updates\" from a silent registry-auth failure.",
      inputSchema: {
        repoPath: pathString(
          "Absolute path to the repository root. Required for the default `platform=local` mode. When `platform` is overridden (e.g. `gitlab` / `github`), Renovate runs against the remote `repository` instead — `repoPath` is still used as the child's working directory but its manifest files are ignored.",
        ),
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
        platform: z
          .enum(["local", "github", "gitlab"])
          .optional()
          .describe(
            "Renovate platform to run as. When unset, falls back to `RENOVATE_PLATFORM` from the MCP server's env (if it's one of `local`/`github`/`gitlab`), then to `local`. Default `local` runs against the filesystem at `repoPath`. Set `github` or `gitlab` (with `endpoint` + `token` + `repository`) to run a full remote dry-run — this is what you need when your config extends `local>` presets that live on a private GitHub Enterprise / self-hosted GitLab. Still no PRs opened because `--dry-run` is always set.",
          ),
        endpoint: endpointString(
          "Custom API base URL (e.g. `https://gitlab.example.com/api/v4/` or `https://ghe.example.com/api/v3/`). Forwarded as `--endpoint` regardless of `platform`: required for non-default GitHub/GitLab hosts when `platform=github`/`gitlab`, and also useful in the default `platform=local` mode to point `gitlab>…` / `github>…` preset shortcuts at a self-hosted host instead of the public defaults.",
        ).optional(),
        token: tokenString(
          "Auth token, exported as `RENOVATE_TOKEN` to the child. Scrubbed from any log output this tool returns. Used both for the platform connection (when `platform` is `github`/`gitlab`) and for preset resolution against private repos (e.g. when fetching a `gitlab>…` preset from a private project while in local mode). When omitted, falls back to `RENOVATE_TOKEN` from MCP env, then to `GITLAB_TOKEN` (when `platform=gitlab`) or `GITHUB_TOKEN` (when `platform=github`) — same precedence as `resolve_config`. Platform-specific fallbacks only kick in when the matching remote platform is selected; in `platform=local` they're ignored.",
        ).optional(),
        repository: repositoryString(
          "Identifier of the repository Renovate should operate on, passed as a positional argument (Renovate has no `--repository` flag). For GitHub: `owner/repo`. For GitLab: `group/project` or a nested-group path like `group/subgroup/project` — both are accepted. Required when `platform` is `github`/`gitlab`. Ignored when `platform=local`.",
        ).optional(),
        hostRules: z
          .array(hostRuleSchema)
          .max(HOST_RULES_MAX_ITEMS)
          .optional()
          .describe(
            "Optional per-invocation Renovate hostRules for private registry auth. Written to a mode-0600 temp file that is passed via the RENOVATE_CONFIG_FILE env var and deleted after the run. Token/password values are scrubbed from any log output this tool returns. Appended to (not replacing) any hostRules declared in the repo's own config.",
          ),
      },
    },
    async (
      { repoPath, dryRunMode, logLevel, timeoutMs, platform, endpoint, token, repository, hostRules },
      extra,
    ) => {
      const reportPath = path.join(tmpdir(), `renovate-mcp-report-${randomUUID()}.json`);
      const bin = resolveRenovateTool("renovate");
      const ruleList: HostRule[] = hostRules ?? [];
      // When the caller doesn't pass `platform`, fall back to RENOVATE_PLATFORM
      // from the MCP server's env before defaulting to `local`. Without this,
      // the wrapper unconditionally appended `--platform=local` and that won
      // over a `RENOVATE_PLATFORM=gitlab` env var the user had set in their
      // mcp.json, silently downgrading correctly-configured self-hosted setups
      // to local mode. Only the platforms in this tool's schema are honored
      // from env; anything else (e.g. `bitbucket`) must be passed explicitly.
      const envPlatform = process.env.RENOVATE_PLATFORM;
      const envPlatformAllowed: "local" | "github" | "gitlab" | undefined =
        envPlatform === "local" || envPlatform === "github" || envPlatform === "gitlab"
          ? envPlatform
          : undefined;
      const effectivePlatform = platform ?? envPlatformAllowed ?? "local";
      const isRemotePlatform = effectivePlatform !== "local";

      // Renovate only reads `RENOVATE_TOKEN` (plus `GITHUB_COM_TOKEN`) — it
      // doesn't know about `GITLAB_TOKEN`/`GITHUB_TOKEN`. When the caller
      // doesn't pass `token`, fall back to MCP env in the same precedence
      // order `resolve_config` uses, then export the resolved value as
      // `RENOVATE_TOKEN` to the spawned child. The platform-specific
      // fallback only kicks in when the matching remote platform is selected
      // (in `local` mode we don't want a stray `GITLAB_TOKEN` in the user's
      // env to suddenly be promoted to a Renovate auth token).
      const platformFallbackVar: "GITLAB_TOKEN" | "GITHUB_TOKEN" | null =
        effectivePlatform === "gitlab"
          ? "GITLAB_TOKEN"
          : effectivePlatform === "github"
            ? "GITHUB_TOKEN"
            : null;
      const credentialEnvVars = platformFallbackVar
        ? ["RENOVATE_TOKEN", platformFallbackVar]
        : ["RENOVATE_TOKEN"];
      const envCredential = resolveCredential(credentialEnvVars);
      const resolvedToken = token ?? envCredential.token;

      const secrets = collectSecrets(ruleList);
      if (resolvedToken) secrets.push(resolvedToken);
      let hostRulesConfigPath: string | undefined;

      if (isRemotePlatform && !repository) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `\`repository\` is required when \`platform\` is \`${effectivePlatform}\`. Pass the target repo as \`owner/repo\` (GitHub) or \`group/project\` / \`group/subgroup/project\` (GitLab — nested groups are accepted), or unset \`platform\` to run against the local filesystem at \`repoPath\`.`,
            },
          ],
        };
      }

      if (isRemotePlatform && !resolvedToken) {
        const fallbackHint = platformFallbackVar
          ? `\`RENOVATE_TOKEN\` (preferred) or \`${platformFallbackVar}\``
          : "`RENOVATE_TOKEN`";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `No auth token found for \`platform=${effectivePlatform}\`. Set ${fallbackHint} in the MCP server's \`env\` ` +
                "(in `.mcp.json` / `claude_desktop_config.json` — not your shell, since the MCP server runs as a child of Claude and does not inherit shell env), " +
                "or pass `token` as a tool input. Run `check_setup` to see which env vars the server currently sees.",
            },
          ],
        };
      }

      // Preflight: if the repo's config extends any `local>…` preset and we're
      // about to run with `--platform=local`, Renovate will fail opaquely with
      // a generic "config-validation" error, because `local>` has no platform
      // context to resolve against in local mode. Detect this up front and
      // return an actionable message instead of spawning Renovate.
      // Skipped for `dryRunMode=extract` so manifest-only extraction can be
      // attempted regardless — Renovate may still fail config resolution, but
      // letting the spawn happen surfaces its real error rather than ours.
      if (!isRemotePlatform && dryRunMode !== "extract") {
        const unresolvable = await detectUnresolvableLocalPresets(repoPath);
        if (unresolvable && unresolvable.presets.length > 0) {
          const sample = unresolvable.presets.slice(0, 3).join(", ");
          const more = unresolvable.presets.length > 3
            ? ` (+${unresolvable.presets.length - 3} more)`
            : "";
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `\`${unresolvable.relPath}\` extends \`local>\` presets (${sample}${more}) that cannot be resolved under \`--platform=local\` — Renovate has no platform context to expand them against, so the run would fail with an opaque \`config-validation\` error.\n\n` +
                  `To fix: pass \`platform\` (e.g. \`gitlab\` or \`github\`), \`endpoint\`, \`token\`, and \`repository\` so Renovate runs as a real platform client and can fetch the preset. Alternatively, rewrite the \`extends\` entries from \`local>…\` to \`gitlab>…\` / \`github>…\` in your config.`,
              },
            ],
          };
        }
      }

      // Hybrid progress reporter: a heartbeat tick every HEARTBEAT_MS keeps
      // MCP clients informed during long runs, and each tick enriches its
      // message with the latest Renovate JSON-log `msg` we saw (best-effort —
      // we don't couple tightly to Renovate's log schema). Skips all work if
      // the caller didn't supply a progressToken.
      const progressToken = extra?._meta?.progressToken;
      const sendNotification = extra?.sendNotification;
      const progressEnabled = progressToken !== undefined && typeof sendNotification === "function";
      const HEARTBEAT_MS = 5_000;
      const startedAt = Date.now();
      let progressCounter = 0;
      let lastLogMsg: string | undefined;
      let heartbeat: NodeJS.Timeout | undefined;

      const emit = (message: string): void => {
        if (!progressEnabled) return;
        progressCounter += 1;
        void sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: progressCounter,
            message: scrubSecrets(message, secrets),
          },
        }).catch(() => undefined);
      };

      try {
        const args = [
          `--platform=${effectivePlatform}`,
          `--dry-run=${dryRunMode}`,
          "--report-type=file",
          `--report-path=${reportPath}`,
        ];
        const childEnv: NodeJS.ProcessEnv = {
          LOG_LEVEL: logLevel,
          LOG_FORMAT: "json",
        };
        // `endpoint` and the resolved token flow through regardless of
        // platform: in local mode they redirect `gitlab>…`/`github>…` preset
        // shortcuts to a self-hosted host (Renovate's preset shortcut hosts
        // are otherwise hardcoded to gitlab.com/github.com).
        if (endpoint) args.push(`--endpoint=${endpoint}`);
        if (resolvedToken) childEnv.RENOVATE_TOKEN = resolvedToken;
        // Renovate has no `--repository` flag — repos are positional args.
        if (isRemotePlatform && repository) {
          args.push(repository);
        }
        if (ruleList.length > 0) {
          hostRulesConfigPath = await writeHostRulesConfig(ruleList);
          // Renovate reads this config file via the RENOVATE_CONFIG_FILE env
          // var, not a CLI flag — `--config-file` is not a real Renovate flag
          // and passing it crashes the CLI with "unknown option".
          childEnv.RENOVATE_CONFIG_FILE = hostRulesConfigPath;
        }

        if (progressEnabled) {
          emit(`Starting Renovate dry-run (${dryRunMode})`);
          heartbeat = setInterval(
            () => emit(buildDryRunHeartbeatMessage(Date.now() - startedAt, lastLogMsg)),
            HEARTBEAT_MS,
          );
        }

        const result = await run(bin, args, {
          cwd: repoPath,
          env: childEnv,
          timeoutMs,
          onStdoutLine: progressEnabled
            ? (line) => {
                const msg = extractRenovateLogMsg(line);
                if (msg) lastLogMsg = msg;
              }
            : undefined,
        });

        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }

        let report: unknown = null;
        try {
          const raw = await fs.readFile(reportPath, "utf8");
          report = JSON.parse(raw);
        } catch {
          // no report produced (e.g., renovate errored before writing)
        }

        const reportErrors = collectReportErrors(report);

        const summary: Record<string, unknown> = {
          // `ok` collapses the three failure modes (spawn error, non-zero
          // exit, in-report validation/error-level problems) into a single
          // field so callers don't need to know which one fired. Renovate
          // frequently writes a report with exitCode=0 while its `problems`
          // array records a validation/config failure — judging only by
          // exitCode hides those runs.
          ok: result.exitCode === 0 && reportErrors.length === 0,
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

        if (reportErrors.length > 0) {
          summary.reportErrors = reportErrors;
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

        if (progressEnabled) {
          emit(
            report
              ? `Dry-run complete (exit ${result.exitCode})`
              : `Dry-run finished without a report (exit ${result.exitCode})`,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2),
            },
          ],
          isError: !summary.ok,
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: scrubSecrets(
                formatMissingBinaryError("renovate", err as Error),
                secrets,
              ),
            },
          ],
        };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await fs.unlink(reportPath).catch(() => undefined);
        if (hostRulesConfigPath) {
          await fs.unlink(hostRulesConfigPath).catch(() => undefined);
        }
      }
    },
  );
}
