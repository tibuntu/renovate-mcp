import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  run,
  resolveRenovateTool,
  formatMissingBinaryError,
  formatTimeoutError,
  CommandTimeoutError,
} from "../lib/renovateCli.js";
import { buildHostTokenRules, homeScope, matchesHost, selectToken, tokenHost, type TokenScope } from "../lib/hostTokens.js";
import { HOSTED_PLATFORMS } from "../lib/gitRemote.js";
import {
  findLocalPresets,
  flattenLocalPresets,
  nestedLocalPresetHint,
  resolveLocalPresetRoute,
} from "../lib/presetFlattenWorker.js";
import { copyRepo, removeRepoCopy, writeFlattenedConfig } from "../lib/repoCopy.js";
import { validateEndpoint } from "../lib/endpointValidator.js";
import { locateConfig } from "../lib/configLocations.js";
import { assertRepoDir, NETWORK_READ_ONLY_ANNOTATIONS } from "../lib/toolInputs.js";
import { detectLookupProblems } from "../lib/lookupProblems.js";
import {
  collectSecrets,
  removeHostRulesConfig,
  scrubSecrets,
  writeHostRulesConfig,
  type HostRule,
} from "../lib/hostRulesConfig.js";
import {
  extractRenovateLogMsg,
  buildDryRunHeartbeatMessage,
} from "../lib/dryRunProgress.js";
import { classifyReportProblem } from "../lib/runtimeWarnings.js";
import { readArray, readRecord } from "../lib/dryRunDiff.js";
import {
  BASE_BRANCHES_MAX_ITEMS,
  BRANCH_NAME_MAX_BYTES,
  HOST_RULES_MAX_ITEMS,
  endpointString,
  hostRuleRecord,
  pathString,
  repositoryString,
  tokenString,
} from "../lib/inputLimits.js";

/**
 * Verbatim advisory warning emitted by `dry_run` when an inline secret is
 * detected on the tool input (the top-level `token` parameter or any non-empty
 * `hostRules[].token`). Exported so the integration tests can assert against
 * the source-of-truth string rather than duplicating the literal (which would
 * silently drift if the message ever changed).
 */
export const INLINE_SECRET_WARNING =
  "Secret supplied inline. Prefer setting the platform's own token (`GITHUB_TOKEN` / `GITLAB_TOKEN`, or `RENOVATE_TOKEN` for the `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` host) or a `RENOVATE_MCP_HOST_TOKENS` entry on the MCP server environment; inline secrets are stored in tool transcripts that may be shared, persisted by clients, or fed back into LLMs.";

/** Renovate's default API endpoint per remote platform; its host is where Renovate binds the platform token. */
const DEFAULT_API_URL = {
  github: "https://api.github.com/",
  gitlab: "https://gitlab.com/api/v4/",
} as const;

/**
 * Returns true when any rule in the list carries a non-empty string `token`
 * field. Deliberately only inspects `token` (NOT `password`): the locked
 * trigger for the inline-secret warning is `token`-only — `collectSecrets` in
 * `hostRulesConfig.ts` harvests both for scrubbing purposes, but the warning
 * must not fire on a `password`-only host rule.
 */
function hasInlineHostRuleToken(rules: HostRule[]): boolean {
  return rules.some((rule) => typeof rule?.token === "string" && rule.token.length > 0);
}

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
interface CollectedReportProblems {
  fatal: Array<Record<string, unknown>>;
  environment: Array<Record<string, unknown>>;
}

function collectReportProblems(report: unknown): CollectedReportProblems {
  const fatal: Array<Record<string, unknown>> = [];
  const environment: Array<Record<string, unknown>> = [];
  // The report is parsed JSON, so the walk cannot cycle.
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
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
        if (!(isErrorLevel || isConfigValidation || hasValidationError)) continue;
        // The RE2-fallback WARN sometimes lands here at fatal level even
        // though Renovate kept running on JS `RegExp`. The nodeEnv mismatch
        // similarly does not invalidate the report. Route both away from the
        // fatal bucket so `ok` reflects whether the run actually failed.
        const kind = classifyReportProblem(p);
        if (kind === "re2") continue;
        if (kind === "nodeEnv") {
          environment.push(p);
          continue;
        }
        fatal.push(p);
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(report);
  return { fatal, environment };
}

function countRepositories(report: unknown): number {
  return Object.keys(readRecord(report, "repositories") ?? {}).length;
}

/**
 * Every `repositories[*].branches[*].upgrades[]` entry. Not
 * `collectProposedUpdates(report).length`: that drops upgrades without a
 * `depName` (lockFileMaintenance), which this count includes.
 */
function countUpdates(report: unknown): number {
  return Object.values(readRecord(report, "repositories") ?? {})
    .flatMap((repo) => readArray(repo, "branches") ?? [])
    .reduce<number>((n, branch) => n + (readArray(branch, "upgrades")?.length ?? 0), 0);
}

export function registerDryRun(server: McpServer): void {
  server.registerTool(
    "dry_run",
    {
      title: "Dry-run Renovate",
      annotations: NETWORK_READ_ONLY_ANNOTATIONS,
      description:
        "Run Renovate in dry-run mode to preview what it would do — no PRs opened, no git pushes. Returns a structured JSON report plus a top-level `ok` boolean (false when the CLI failed OR the report records a validation/error-level problem, even if the exit code was 0). RE2 native-module fallback noise and Renovate's `Unsupported node environment` notice are filtered out of `reportErrors` — the former flows into `warnings` (still actionable, still surfaced), the latter into a separate `environmentWarnings[]` since the run still produced a usable report.\n\nEffective platform = `platform` input → `RENOVATE_PLATFORM` env → `local`. The `platformSource` field on the result echoes which step won; preflight errors and the env-overrides-default advisory both reference it so callers don't have to read the source to find where a surprising `gitlab`/`github` came from.\n\nThe full structured report ships inline by default. For large repos that is bigger than most MCP clients' response-content cap (≈75 KB on Claude Desktop) and the middle of the JSON is silently truncated. Pass `reportOutputPath` to redirect the structured report to a file (mode 0600), in which case `summary.report` collapses to `{ reportPath, repoCount, updateCount }` and `dry_run_diff` can pick it up via `{ reportPath: … }`. `warnings`, `problems`, `reportErrors`, and `environmentWarnings` always stay inline regardless — those are the actionable bits.\n\n**Custom base branches.** By default Renovate evaluates the repository's default branch. Pass `baseBranches` to evaluate other branches instead — this is how you dry-run a Renovate config change that lives on a feature branch before merging it. Entries are exact branch names; regex requires `/…/` wrapping (e.g. `/^renovate\\/.+/`, negate with `!/…/`) — bare `^foo` is matched literally, not as regex. `$default` expands to the default branch. With `readConfigFromBaseBranch` (default true) Renovate also reads its config FROM those branches (`useBaseBranchConfig=merge`), so the branch's edited config is what gets evaluated; set it false to scan the branches' manifests using the default branch's config. Base-branch selection only applies to remote-platform runs (`platform: 'github'`/`'gitlab'`) — it is ignored (with a warning) under `platform=local`.\n\n**Auth — prefer env vars, every token bound to its host.** Set tokens on the MCP server's env via `claude_desktop_config.json` / `.mcp.json`, with the same host scoping `resolve_config` uses: `GITHUB_TOKEN` / `GITLAB_TOKEN` (and the Gitea / Forgejo / Bitbucket ones) only for their platform's public host, `RENOVATE_TOKEN` only for the home host named by `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` (where it wins over the platform's own token, as in Renovate), `RENOVATE_MCP_HOST_TOKENS` entries for further hosts. The `platform`, `endpoint` and `presetPlatform` inputs and the repo's origin route requests but never bind an env token to another host: an endpoint passed only on the call gets a token from a `RENOVATE_MCP_HOST_TOKENS` entry or the `token` input. On a remote run (`github` / `gitlab`) the platform token — the `token` input, else the env token bound to the API host (`endpoint`, else `RENOVATE_ENDPOINT` when it belongs to that platform, else the public API) — is exported as `RENOVATE_TOKEN` to the spawned Renovate CLI; without one an actionable error is returned before spawning. Under `platform=local` no `RENOVATE_TOKEN` is exported and the `token` input is ignored with a warning. Every env token is also handed to Renovate as a host rule on its own host (`GITHUB_COM_TOKEN` excepted, Renovate reads it itself), so a `GITLAB_TOKEN` authenticates gitlab.com lookups in a local run. A malformed `RENOVATE_MCP_HOST_TOKENS` is an error before spawning. The `token` input is retained as an ad-hoc / testing fallback — when supplied inline it is persisted in the MCP tool transcript that the client may share, replay, or feed back into the LLM, so an advisory entry is appended to the result `warnings` array steering callers toward env-var auth.\n\nDefault mode runs `--platform=local` against the filesystem at `repoPath`. Renovate cannot resolve `local>…` presets (or unprefixed `owner/repo` ones) in local mode, so in `lookup` and `full` mode the tool flattens them first: it copies the repository (tracked files) into a temporary directory, resolves every preset after the leading built-ins with Renovate's own preset resolver, routed through `presetPlatform` (else the platform of the origin remote) and `endpoint` (else `RENOVATE_ENDPOINT` when `RENOVATE_PLATFORM` names the same platform and, for an origin-derived platform, the endpoint is on the origin's host), validates the result as a repo config, writes it into the copy and runs Renovate there. The copy's path is reported as `repoPath` and the copy is removed afterwards; the result lists `flattenedPresets` and `keptExtends`. Refused before spawning: no derivable route (pass `presetPlatform`), a self-hosted origin without an endpoint, Bitbucket, a blocked endpoint, a preset that cannot be fetched, a flattened config that fails validation, a worker failure, or a repository over the copy caps. `dryRunMode=extract` is not flattened. Alternatively pass `platform` (`github` or `gitlab`), `endpoint` and `repository` (plus `token` when no env token applies) to run as a real platform client against the remote repository — Renovate still runs with `--dry-run`, so no PRs are opened. `gitlab>…` / `github>…` presets always come from gitlab.com / github.com, as in Renovate.\n\nCredentials for private registries (e.g. `COMPOSER_AUTH` for Packagist/Satis proxies, `NPM_TOKEN` / `.npmrc` for npm, Docker registry creds, `RENOVATE_HOST_RULES` for anything else) must be set on the MCP server process itself — via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env. Alternatively, encode credentials as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on this tool (written after the env-token rules to a mode-0600 temp file that is cleaned up after the run; token/password values — including the platform `token` input, the env tokens and `GITHUB_COM_TOKEN` — are scrubbed from `logTail`, `problems` and the report, `reportErrors` and a saved `reportOutputPath` included). Per-call `hostRules` are appended to any the repo's own config already declares. If a lookup can't auth to a registry, Renovate often reports 0 updates without a loud error; when that happens this tool surfaces detected auth failures under `problems` in the output so callers can distinguish a genuine \"no updates\" from a silent registry-auth failure.",
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
          "Custom API base URL (e.g. `https://gitlab.example.com/api/v4/` or `https://ghe.example.com/api/v3/`) for a remote run (`platform=github`/`gitlab`), forwarded as `--endpoint`; falls back to `RENOVATE_ENDPOINT` from the server env when `platform` is unset or equals `RENOVATE_PLATFORM` (otherwise the env endpoint is kept from the child). It routes requests only: an env token reaches its host only when `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` name that host or a `RENOVATE_MCP_HOST_TOKENS` entry covers it. Under `platform=local` it routes the local presets the tool flattens (with `presetPlatform`), and is ignored with a warning when nothing is flattened. `gitlab>…` / `github>…` presets always go to gitlab.com / github.com.",
        ).optional(),
        token: tokenString(
          "Platform token for a remote run (`platform=github`/`gitlab`), exported as `RENOVATE_TOKEN` to the child. Scrubbed from any log output this tool returns. When omitted, the env token bound to the API host is used: `RENOVATE_TOKEN` (then `GITHUB_TOKEN` / `GITLAB_TOKEN`) on the `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` host, `GITHUB_TOKEN` / `GITLAB_TOKEN` on the public host, or a `RENOVATE_MCP_HOST_TOKENS` entry for that host — same host scoping as `resolve_config`. Ignored with a warning under `platform=local`, where there is no platform host to send it to.",
        ).optional(),
        repository: repositoryString(
          "Identifier of the repository Renovate should operate on, passed as a positional argument (Renovate has no `--repository` flag). For GitHub: `owner/repo`. For GitLab: `group/project` or a nested-group path like `group/subgroup/project` — both are accepted. Required when `platform` is `github`/`gitlab`. Ignored when `platform=local`.",
        )
          // A leading `-` would be parsed as a CLI flag by Renovate's commander.
          .regex(/^[^-]/, "repository must not start with '-'")
          .optional(),
        hostRules: z
          .array(hostRuleSchema)
          .max(HOST_RULES_MAX_ITEMS)
          .optional()
          .describe(
            "Optional per-invocation Renovate hostRules for private registry auth. Written after the env-token host rules to a mode-0600 temp file that is passed via the RENOVATE_CONFIG_FILE env var (RENOVATE_ADDITIONAL_CONFIG_FILE when the operator already set RENOVATE_CONFIG_FILE; refused when both are set) and deleted after the run. Token/password values are scrubbed from any log output this tool returns. Appended to (not replacing) any hostRules declared in the repo's own config.",
          ),
        reportOutputPath: pathString(
          "Optional absolute path to copy the structured Renovate report to (created fresh with mode 0600 — the path must not already exist, or the call fails with `already exists` rather than overwriting). When set, `summary.report` is replaced by `{ reportPath, repoCount, updateCount }` so the inline response stays under MCP response-content caps. Use this — together with `dry_run_diff`'s `{ reportPath }` input — when the full inline report would exceed the harness truncation threshold (≈75 KB on Claude Desktop). `warnings`/`problems`/`reportErrors`/`environmentWarnings` always stay inline regardless.",
        ).optional(),
        baseBranches: z
          .array(z.string().min(1).max(BRANCH_NAME_MAX_BYTES))
          .max(BASE_BRANCHES_MAX_ITEMS)
          .optional()
          .describe(
            "One or more base branches to evaluate instead of the repository's default branch (Renovate's `baseBranchPatterns`). Each entry is an EXACT branch name unless it is wrapped in slashes: only `/…/`-delimited entries are treated as regex (optionally `!/…/` to negate) — a bare `^release/.*` is matched literally as a branch named `^release/.*` and will never match. The magic value `$default` expands to the repository's default branch. This is what lets you dry-run a Renovate config change that lives on a non-default branch (e.g. a feature branch) before it is merged. Maps to the `RENOVATE_BASE_BRANCH_PATTERNS` env var — `baseBranchPatterns` is not a CLI flag. Only applies to remote-platform runs (`platform: 'github'`/`'gitlab'`); ignored under `platform=local`, which always inspects the working tree at `repoPath`. See also `readConfigFromBaseBranch`.",
          ),
        presetPlatform: z
          .enum(HOSTED_PLATFORMS)
          .optional()
          .describe(
            "Local runs only: the platform the config's local presets (`local>owner/repo`, or an unprefixed `owner/repo`) live on. Under `platform=local` Renovate cannot resolve them, so in `lookup` and `full` mode dry_run resolves them first with Renovate's own preset resolver, writes the result into a temporary copy of the repository and runs Renovate there. When unset, it is derived from the origin remote (github.com, gitlab.com, gitea.com, codeberg.org, code.forgejo.org, or the flavour of a self-hosted host, which then needs `endpoint` or `RENOVATE_ENDPOINT`). Passing it also flattens a config whose local presets only appear inside other presets. `bitbucket` is refused: Renovate reads Bitbucket local presets through its platform client. Like `platform` in `resolve_config` it routes the presets but never moves an env token to their host.",
          ),
        readConfigFromBaseBranch: z
          .boolean()
          .optional()
          .describe(
            "Only meaningful together with `baseBranches`. When true (default), Renovate reads its config (renovate.json/.jsonc/.json5, …) FROM each base branch — `useBaseBranchConfig=merge` — so a config edit that only exists on that branch is actually evaluated. Set false to scan the base branches' manifests while still using the default branch's config.",
          ),
      },
    },
    async (
      {
        repoPath,
        dryRunMode,
        logLevel,
        timeoutMs,
        platform,
        endpoint,
        token,
        repository,
        hostRules,
        reportOutputPath,
        baseBranches,
        readConfigFromBaseBranch,
        presetPlatform,
      },
      extra,
    ) => {
      if (endpoint !== undefined) {
        const blocked = validateEndpoint(endpoint);
        if (blocked) return { isError: true, content: [{ type: "text", text: blocked }] };
      }

      // Preflight the paths we're about to hand to the child. A missing
      // `cwd` surfaces from spawn as ENOENT — indistinguishable from a
      // missing binary — and a bad `reportOutputPath` would only fail after
      // a run of up to 15 minutes.
      const repoError = await assertRepoDir(repoPath);
      if (repoError) return { isError: true, content: [{ type: "text", text: repoError }] };
      if (reportOutputPath !== undefined) {
        if (!path.isAbsolute(reportOutputPath)) {
          return {
            isError: true,
            content: [{ type: "text", text: `\`reportOutputPath\` must be an absolute path (got \`${reportOutputPath}\`).` }],
          };
        }
        // A missing parent would only surface as ENOENT after a run of up
        // to 15 minutes; fail before spawning instead.
        const parent = path.dirname(reportOutputPath);
        const parentStat = await fs.stat(parent).catch(() => null);
        if (!parentStat?.isDirectory()) {
          return {
            isError: true,
            content: [{ type: "text", text: `\`reportOutputPath\` parent directory \`${parent}\` does not exist or is not a directory.` }],
          };
        }
        // lstat: a dangling symlink counts as "exists" too (the wx write
        // below would refuse it anyway — this just fails before the run).
        if (await fs.lstat(reportOutputPath).then(() => true, () => false)) {
          return {
            isError: true,
            content: [{ type: "text", text: `\`reportOutputPath\` \`${reportOutputPath}\` already exists; refusing to overwrite. Pass a fresh path.` }],
          };
        }
      }
      // The temp host-rules file normally rides on RENOVATE_CONFIG_FILE. When
      // the operator already uses that variable, it goes in
      // RENOVATE_ADDITIONAL_CONFIG_FILE instead (merged after the file config,
      // hostRules concatenated). Only when both are taken is there no slot.
      const operatorConfigFile = process.env.RENOVATE_CONFIG_FILE;
      const operatorAdditionalFile = process.env.RENOVATE_ADDITIONAL_CONFIG_FILE;
      const hostRulesSlot: "RENOVATE_CONFIG_FILE" | "RENOVATE_ADDITIONAL_CONFIG_FILE" | null = !operatorConfigFile
        ? "RENOVATE_CONFIG_FILE"
        : !operatorAdditionalFile
          ? "RENOVATE_ADDITIONAL_CONFIG_FILE"
          : null;
      if (hostRules?.length && !hostRulesSlot) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `\`hostRules\` cannot be used while both \`RENOVATE_CONFIG_FILE\` (\`${operatorConfigFile}\`) and \`RENOVATE_ADDITIONAL_CONFIG_FILE\` (\`${operatorAdditionalFile}\`) are set on the MCP server: the tool passes per-call hostRules through one of those variables and would silently replace the operator's file for this run. Add the hostRules to one of those files instead, or unset one of the variables.`,
            },
          ],
        };
      }

      const reportPath = path.join(tmpdir(), `renovate-mcp-report-${randomUUID()}.json`);
      const tool = resolveRenovateTool("renovate");
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
      const platformSource: "input" | "env" | "default" = platform
        ? "input"
        : envPlatformAllowed
          ? "env"
          : "default";
      const effectivePlatform = platform ?? envPlatformAllowed ?? "local";
      const isRemotePlatform = effectivePlatform !== "local";
      const platformOriginTag = `(platform resolved from ${
        platformSource === "input"
          ? "`platform` input"
          : platformSource === "env"
            ? "`RENOVATE_PLATFORM` env"
            : "default"
      })`;

      // Host-scoped tokens (ADR-0008). Env tokens bind to their public hosts
      // and to the env scope (RENOVATE_PLATFORM + RENOVATE_ENDPOINT) only; the
      // `platform` / `endpoint` / `presetPlatform` inputs and the origin route
      // requests but never move a token. Remote: the route is the run's
      // platform with `endpoint`, else RENOVATE_ENDPOINT when it belongs to that
      // platform (passed to the child as `--endpoint`), and the platform token
      // exported as RENOVATE_TOKEN is the env token bound to the API host.
      // Local: Renovate's platform rule has hostType `local` and no host, so no
      // RENOVATE_TOKEN; env tokens reach Renovate only as host rules.
      //
      // Local `lookup` / `full` runs whose config names a local preset (or that
      // pass `presetPlatform`) flatten it first (ADR-0009): the repo is copied,
      // the copy's config is the one Renovate would read, and `route` is where
      // its `local>` presets are fetched from.
      let copy: { dir: string; relPath: string; config: Record<string, unknown>; warnings: string[] } | undefined;
      let route: TokenScope = homeScope({ platform: effectivePlatform, endpoint });
      if (!isRemotePlatform && dryRunMode !== "extract") {
        const located = await locateConfig(repoPath).catch(() => null);
        if (located && (presetPlatform || findLocalPresets(located.config).length)) {
          const copied = await copyRepo(repoPath);
          if (!copied.ok) return { isError: true, content: [{ type: "text", text: copied.reason }] };
          // An untracked config is not in the copy, as it is not in Renovate's
          // `git ls-files`; then there is nothing to flatten.
          const inCopy = await locateConfig(copied.dir).catch(() => null);
          if (inCopy && (presetPlatform || findLocalPresets(inCopy.config).length)) {
            const local = await resolveLocalPresetRoute(repoPath, { presetPlatform, endpoint });
            if (!local.ok) {
              await removeRepoCopy(copied.dir);
              return { isError: true, content: [{ type: "text", text: local.reason }] };
            }
            route = local.scope;
            copy = { dir: copied.dir, relPath: inCopy.relPath, config: inCopy.config, warnings: copied.warnings };
          } else {
            await removeRepoCopy(copied.dir);
          }
        }
      }
      const apiUrl = isRemotePlatform ? (route.endpoint ?? DEFAULT_API_URL[effectivePlatform]) : undefined;
      const envCredential = apiUrl
        ? selectToken(apiUrl, effectivePlatform as "github" | "gitlab", process.env, { githubComToken: false })
        : undefined;
      const resolvedToken = isRemotePlatform ? (token ?? envCredential!.token) : undefined;

      // Rules a later rule for the same hostType + matchHost replaces anyway:
      // the platform rule Renovate appends last, and per-call rules carrying a
      // credential. The platform rule sits on the API host; the env rule of the
      // run's platform on a parent domain of it (github.com for api.github.com)
      // is left out too, as a real run has no token off the API host either.
      const covered: Array<{ hostType: string; matchHost: string }> = [];
      if (apiUrl) {
        covered.push({ hostType: effectivePlatform, matchHost: new URL(apiUrl).hostname });
        const envHost = tokenHost(effectivePlatform as "github" | "gitlab");
        if (envHost && matchesHost(envHost, apiUrl)) covered.push({ hostType: effectivePlatform, matchHost: envHost });
      }
      for (const rule of ruleList) {
        if (typeof rule.hostType === "string" && typeof rule.matchHost === "string" && (rule.token || rule.password)) {
          covered.push({ hostType: rule.hostType, matchHost: rule.matchHost });
        }
      }
      const autoRules = buildHostTokenRules(process.env, covered);
      if (autoRules.error) {
        if (copy) await removeRepoCopy(copy.dir);
        return { isError: true, content: [{ type: "text", text: autoRules.error }] };
      }

      const secrets = [...new Set([...collectSecrets(ruleList), ...autoRules.secrets])];
      if (resolvedToken) secrets.push(resolvedToken);
      // Renovate reads it from env, and the flattening worker gets it too.
      if (process.env.GITHUB_COM_TOKEN) secrets.push(process.env.GITHUB_COM_TOKEN);

      // Inline-secret detection: fires when the *original* `token` parameter
      // (not the env-resolved fallback) is a non-empty string, or when any
      // host rule carries a non-empty `token`. Evaluated here — after input
      // parsing but before spawn — so the advisory warning still surfaces
      // even if the subsequent Renovate spawn fails. One consolidated warning
      // is emitted regardless of how many triggers fire (no N+1 spam).
      const inlineSecretDetected =
        (typeof token === "string" && token.length > 0) || hasInlineHostRuleToken(ruleList);
      const mcpWarnings: string[] = [];
      if (inlineSecretDetected) mcpWarnings.push(INLINE_SECRET_WARNING);
      mcpWarnings.push(...autoRules.warnings);
      const fileRules: HostRule[] = [...autoRules.rules, ...ruleList];
      if (!hostRulesSlot && autoRules.rules.length > 0) {
        mcpWarnings.push(
          `Host rules for the env tokens were skipped: both \`RENOVATE_CONFIG_FILE\` and \`RENOVATE_ADDITIONAL_CONFIG_FILE\` are set on the MCP server, so there is no file slot left for them. Add them to one of those files if Renovate needs them.`,
        );
      }
      if (!isRemotePlatform && endpoint !== undefined && !copy) {
        mcpWarnings.push(
          "`endpoint` was ignored: under `platform=local` it only routes the local presets dry_run flattens, and this run flattens none (no local preset in the repo config, or `dryRunMode=extract`).",
        );
      }
      if (presetPlatform !== undefined && !copy) {
        mcpWarnings.push(
          "`presetPlatform` was ignored: it only applies to a `platform=local` run in `lookup` or `full` mode on a repository with a Renovate config.",
        );
      }
      if (copy) mcpWarnings.push(...copy.warnings);
      if (!isRemotePlatform && token !== undefined) {
        mcpWarnings.push(
          "`token` was ignored: under `platform=local` there is no platform host to send it to. Set the platform's own token (e.g. `GITLAB_TOKEN`) or a `RENOVATE_MCP_HOST_TOKENS` entry on the MCP server instead.",
        );
      }

      let hostRulesConfigPath: string | undefined;

      if (isRemotePlatform && !repository) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `\`repository\` is required when \`platform\` is \`${effectivePlatform}\` ${platformOriginTag}. Pass the target repo as \`owner/repo\` (GitHub) or \`group/project\` / \`group/subgroup/project\` (GitLab — nested groups are accepted), or unset \`platform\` to run against the local filesystem at \`repoPath\`.`,
            },
          ],
        };
      }

      if (isRemotePlatform && !resolvedToken) {
        const tried = envCredential!.triedVars.map((v) => `\`${v}\``);
        const apiHost = new URL(apiUrl!).hostname;
        const setHint = tried.length ? tried.join(" or ") : `a \`RENOVATE_MCP_HOST_TOKENS\` entry for \`${apiHost}\``;
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `No auth token found for \`platform=${effectivePlatform}\` ${platformOriginTag}: no env token is bound to \`${apiHost}\` (tried ${tried.join(", ") || "none"}). ` +
                `Set ${setHint}, or \`RENOVATE_TOKEN\` with \`RENOVATE_PLATFORM\` / \`RENOVATE_ENDPOINT\` naming this host, in the MCP server's \`env\` ` +
                "(in `.mcp.json` / `claude_desktop_config.json` — not your shell, since the MCP server runs as a child of Claude and does not inherit shell env); " +
                "an `endpoint` passed on the call never receives an env token. Or pass `token` as a tool input. Run `check_setup` to see which env vars the server currently sees.",
            },
          ],
        };
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

      // Renovate runs in the copy, so its output names the copy: show the
      // caller's repoPath instead, everywhere, and scrub secrets on top.
      const unCopy = (text: string): string => (copy ? text.split(copy.dir).join(repoPath) : text);
      const clean = (text: string): string => scrubSecrets(unCopy(text), secrets);

      const emit = (message: string): void => {
        if (!progressEnabled) return;
        progressCounter += 1;
        void sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: progressCounter,
            message: clean(message),
          },
        }).catch(() => undefined);
      };

      try {
        // Pre-create the report file with mode 0600 so the on-disk JSON is
        // not world-readable while Renovate is running. Renovate's report
        // writer calls fs.writeFile with O_WRONLY|O_CREAT|O_TRUNC, which
        // preserves the existing file's mode — so the 0600 we set here
        // sticks across Renovate's overwrite. The `wx` flag fails fast if
        // the path already exists (e.g. UUID collision), which is the safer
        // default than silently inheriting whatever mode it had.
        await fs.writeFile(reportPath, "", { flag: "wx", mode: 0o600 });

        let flattened: { flattenedPresets: string[]; keptExtends: string[] } | undefined;
        if (copy) {
          emit(`Flattening local presets via ${route.platform}`);
          // The resolver authenticates like the spawned Renovate will: env
          // token rules, per-call rules, then GITHUB_COM_TOKEN as Renovate
          // appends it from env.
          const githubCom = process.env.GITHUB_COM_TOKEN;
          const result = await flattenLocalPresets(copy.config, {
            platform: route.platform!,
            endpoint: route.endpoint,
            hostRules: githubCom
              ? [...fileRules, { hostType: "github", matchHost: "github.com", token: githubCom }]
              : fileRules,
            timeoutMs,
          });
          if (!result.ok) return { isError: true, content: [{ type: "text", text: clean(result.reason) }] };
          const written = await writeFlattenedConfig(copy.dir, copy.relPath, result.config);
          if (!written.ok) return { isError: true, content: [{ type: "text", text: written.reason }] };
          mcpWarnings.push(...result.warnings);
          flattened = { flattenedPresets: result.flattenedPresets, keptExtends: result.keptExtends };
        }

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
        if (isRemotePlatform) {
          // The routed endpoint (ADR-0008). An env endpoint that belongs to
          // another RENOVATE_PLATFORM must not reach the child.
          if (route.endpoint) args.push(`--endpoint=${route.endpoint}`);
          else childEnv.RENOVATE_ENDPOINT = undefined;
          childEnv.RENOVATE_TOKEN = resolvedToken;
          // Renovate has no `--repository` flag — repos are positional args.
          args.push(repository!);
        } else {
          // run() merges process.env into the child env; `undefined` removes
          // an inherited RENOVATE_TOKEN (spawn skips undefined values).
          childEnv.RENOVATE_TOKEN = undefined;
        }
        // A copy under a git work tree (TMPDIR inside a checkout) would make
        // `git ls-files` list the enclosing repo, which tracks nothing in the
        // copy; stop git at the copy's parent so Renovate falls back to its walk.
        if (copy) childEnv.GIT_CEILING_DIRECTORIES = path.dirname(copy.dir);
        if (hostRulesSlot && fileRules.length > 0) {
          hostRulesConfigPath = await writeHostRulesConfig(fileRules);
          // Renovate reads config files via env vars, not CLI flags —
          // `--config-file` is not a real Renovate flag and passing it crashes
          // the CLI with "unknown option".
          childEnv[hostRulesSlot] = hostRulesConfigPath;
        }

        // Base-branch selection. `baseBranchPatterns` (the option formerly
        // known as `baseBranches`) is `cli:false` in Renovate, so it can only
        // be supplied via env, not a flag. Renovate coerces the array option
        // from a JSON5/JSON string (falling back to comma-split), so a JSON
        // array is the unambiguous encoding even for branch names with commas.
        // Base branches are a remote concept — under `--platform=local`
        // Renovate inspects the working tree at `repoPath` and never resolves
        // branches, so the input would silently do nothing; warn instead.
        if (baseBranches !== undefined) {
          if (baseBranches.length === 0) {
            mcpWarnings.push(
              "`baseBranches` was ignored: an empty array has no effect. Pass at least one exact branch name or a `/…/`-wrapped regex pattern.",
            );
          } else if (isRemotePlatform) {
            childEnv.RENOVATE_BASE_BRANCH_PATTERNS = JSON.stringify(baseBranches);
            // Patterns alone only change WHICH branches are scanned for
            // manifests; Renovate still reads its config from the default
            // branch unless `useBaseBranchConfig=merge`. Enable it by default
            // so a config change living on a non-default branch is actually
            // evaluated — the headline use case for this input.
            if (readConfigFromBaseBranch ?? true) {
              childEnv.RENOVATE_USE_BASE_BRANCH_CONFIG = "merge";
            }
          } else {
            mcpWarnings.push(
              "`baseBranches` was ignored: base-branch selection requires a remote-platform run (`platform: 'github'` / `'gitlab'`). Under `platform=local` Renovate only inspects the working tree at `repoPath`.",
            );
          }
        } else if (readConfigFromBaseBranch !== undefined) {
          mcpWarnings.push(
            "`readConfigFromBaseBranch` was ignored: it only has an effect together with `baseBranches`.",
          );
        }

        if (progressEnabled) {
          emit(`Starting Renovate dry-run (${dryRunMode})`);
          heartbeat = setInterval(
            () => emit(buildDryRunHeartbeatMessage(Date.now() - startedAt, lastLogMsg)),
            HEARTBEAT_MS,
          );
        }

        const result = await run(tool.cmd, [...tool.prefixArgs, ...args], {
          cwd: copy?.dir ?? repoPath,
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
          // The copy's path as it appears inside JSON strings.
          const inJson = (p: string) => JSON.stringify(p).slice(1, -1);
          // Every string is scrubbed, so the inline report, reportErrors and a
          // saved reportOutputPath never carry a token Renovate echoed.
          report = JSON.parse(copy ? raw.split(inJson(copy.dir)).join(inJson(repoPath)) : raw, (_key, value: unknown) =>
            typeof value === "string" ? scrubSecrets(value, secrets) : value,
          );
        } catch {
          // no report produced (e.g., renovate errored before writing)
        }

        const { fatal: reportErrors, environment: environmentWarnings } =
          collectReportProblems(report);

        // If `reportOutputPath` was provided, write the structured report
        // to disk and collapse the inline payload to a small descriptor so
        // the MCP response stays under client truncation caps.
        let reportSummary: unknown = report;
        let savedReportPath: string | undefined;
        if (reportOutputPath && report) {
          try {
            // `wx`: never follow or overwrite something that appeared at the
            // path since the preflight; the file is always fresh, so 0600
            // sticks without a chmod.
            await fs.writeFile(reportOutputPath, JSON.stringify(report), {
              flag: "wx",
              mode: 0o600,
            });
            savedReportPath = reportOutputPath;
            const repoCount = countRepositories(report);
            const updateCount = countUpdates(report);
            reportSummary = {
              reportPath: reportOutputPath,
              repoCount,
              updateCount,
            };
          } catch (err) {
            const text =
              (err as NodeJS.ErrnoException).code === "EEXIST"
                ? `\`reportOutputPath\` \`${reportOutputPath}\` already exists; refusing to overwrite. Pass a fresh path.`
                : `Failed to write report to \`${reportOutputPath}\`: ${(err as Error).message}.`;
            return { isError: true, content: [{ type: "text", text }] };
          }
        }

        const summary: Record<string, unknown> = {
          // `ok` collapses the failure modes (spawn error, non-zero exit,
          // in-report validation/error-level problems) into a single field.
          // Renovate frequently writes a report with exitCode=0 while its
          // `problems` array records a validation/config failure — judging
          // only by exitCode hides those runs. Environment-mismatch entries
          // (RE2 fallback, `Unsupported node environment`) are filtered out
          // of `reportErrors`: the run completed and the report is usable,
          // they shouldn't flip `ok`.
          ok:
            (result.exitCode === 0 || (report !== null && environmentWarnings.length > 0))
            && reportErrors.length === 0,
          exitCode: result.exitCode,
          hasReport: report !== null,
          platformSource,
          effectivePlatform,
          ...(flattened ?? {}),
          report: reportSummary,
        };

        const scrubbedStdout = clean(result.stdout);
        const scrubbedStderr = clean(result.stderr);

        const problems = detectLookupProblems(`${scrubbedStderr}\n${scrubbedStdout}`);
        if (problems.length > 0) {
          summary.problems = problems;
        }

        if (reportErrors.length > 0) {
          summary.reportErrors = reportErrors;
        }

        if (environmentWarnings.length > 0) {
          summary.environmentWarnings = environmentWarnings;
        }

        const nestedHint = nestedLocalPresetHint(reportErrors);
        if (nestedHint) mcpWarnings.push(nestedHint);

        // Advisory: if `platform` was unset and the env fallback pulled in
        // a non-`local` value, the caller probably didn't realise their
        // MCP-server env was redirecting the run. Surface a notice so the
        // origin of the surprising platform is visible without reading
        // source.
        if (
          platformSource === "env"
          && effectivePlatform !== "local"
        ) {
          mcpWarnings.push(
            `Running as \`${effectivePlatform}\` because \`RENOVATE_PLATFORM\` is set in the MCP server's env; pass \`platform: 'local'\` to override.`,
          );
        }

        // Merge MCP-side advisory warnings (currently just the inline-secret
        // notice) ahead of Renovate's own runtime warnings so they surface at
        // the top of the array — easier for clients to render prominently.
        const combinedWarnings = [
          ...mcpWarnings,
          ...result.runtimeWarnings.map((w) => ({
            ...w,
            message: unCopy(w.message),
            ...(w.detail ? { detail: unCopy(w.detail) } : {}),
          })),
        ];
        if (combinedWarnings.length > 0) {
          summary.warnings = combinedWarnings;
        }

        // run() keeps only the last 4 MiB per stream; tell the caller when
        // `logTail` / `problems` were derived from a capped log.
        if (result.truncated) {
          summary.outputTruncated = true;
        }

        // On a failed run (no report, or a non-zero exit even with one),
        // surface the last bit of stderr so Claude can debug without blowing
        // up the context with Renovate's verbose logs.
        if (!report || result.exitCode !== 0) {
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
              text: clean(
                err instanceof CommandTimeoutError
                  ? formatTimeoutError("renovate", err)
                  : formatMissingBinaryError("renovate", err as Error),
              ),
            },
          ],
        };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await fs.unlink(reportPath).catch(() => undefined);
        if (hostRulesConfigPath) await removeHostRulesConfig(hostRulesConfigPath);
        if (copy) await removeRepoCopy(copy.dir);
      }
    },
  );
}
