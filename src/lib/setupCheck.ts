import { createRequire } from "node:module";
import fs from "node:fs";
import { locateConfig } from "./configLocations.js";
import { resolveCredential } from "./credentialResolver.js";
import { probeEndpoint, type EndpointProbeResult } from "./endpointProbe.js";
import {
  classifyRemoteHost,
  parseRemoteUrl,
  readOriginRemote,
  type ClassifiedRemote,
  type ParsedRemote,
  type RemoteClassification,
} from "./gitRemote.js";
import { run, resolveRenovateTool } from "./renovateCli.js";
import { dedupeRuntimeWarnings, type RuntimeWarning } from "./runtimeWarnings.js";

const requireFromHere = createRequire(import.meta.url);

export type RenovateBinary = "renovate" | "renovate-config-validator";

export interface BinaryStatus {
  tool: RenovateBinary;
  command: string;
  /**
   * Where the resolved binary came from. `bundled` means renovate-mcp's own
   * `node_modules/renovate` was used (the default); `env` means the user set
   * `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN`; `path` means the bundled
   * lookup failed and we fell through to the bare tool name on `PATH`.
   */
  source: "env" | "bundled" | "path";
  found: boolean;
  version?: string;
  error?: string;
  /**
   * Runtime warnings parsed from this binary's `--version` stderr (e.g. RE2
   * dlopen failure). Present only when at least one warning was detected.
   */
  runtimeWarnings?: RuntimeWarning[];
}

export type DryRunPlatform = "local" | "github" | "gitlab";

const DRY_RUN_PLATFORMS: readonly DryRunPlatform[] = ["local", "github", "gitlab"] as const;

export interface PlatformContext {
  /** Raw `RENOVATE_PLATFORM` value from the MCP server's env, or null. */
  renovatePlatform: string | null;
  /** Raw `RENOVATE_ENDPOINT` value from the MCP server's env, or null. */
  renovateEndpoint: string | null;
  /** Presence-only — never echo the value, since these are secrets. */
  tokensPresent: {
    RENOVATE_TOKEN: boolean;
    GITHUB_TOKEN: boolean;
    GITLAB_TOKEN: boolean;
    /** github.com *datasource* token (release notes, github-tags/-releases/-actions). Distinct from the platform token; never auto-derived from the others. */
    GITHUB_COM_TOKEN: boolean;
  };
  /**
   * What `dry_run` would pick for `--platform=` when its `platform` input is
   * unset. Mirrors the env fallback in `src/tools/dryRun.ts`: only values
   * inside the dry_run schema enum (`local`/`github`/`gitlab`) are honored,
   * anything else silently degrades to `local`.
   */
  effectiveDryRunPlatform: DryRunPlatform;
  /** Cross-checks that are mechanical to compute but easy for callers to miss. */
  notes: string[];
}

export type EffectivePlatform = "github" | "gitlab" | "local" | "unknown";
export type EffectivePlatformSource = "remote" | "config" | "env" | "default";

export interface RepoContext {
  repoPath: string;
  remote:
    | (ParsedRemote & ClassifiedRemote & { url: string })
    | null;
  configFile: { path: string; format: string } | null;
  configEndpoint?: string;
  configPlatform?: "github" | "gitlab" | "local";
  effectivePlatform: EffectivePlatform;
  effectivePlatformSource: EffectivePlatformSource;
  endpointProbe?: EndpointProbeResult & { derivedFrom: "config" | "env" | "default" };
  inconsistencies: string[];
}

export interface CheckSetupOptions {
  repoPath?: string;
  /**
   * Override the network probe (for tests). When set, the helper is called
   * instead of `probeEndpoint` for any reachability check. Production callers
   * should leave this unset.
   */
  probe?: (url: string) => Promise<EndpointProbeResult>;
}

export interface SetupStatus {
  node: string;
  renovate: BinaryStatus;
  renovateConfigValidator: BinaryStatus;
  envOverrides: Record<string, string>;
  platformContext: PlatformContext;
  ok: boolean;
  hints: string[];
  /**
   * Deduped union of `runtimeWarnings` from every binary's `--version` probe.
   * Distinct from `hints`: hints are "things you need to install / fix to use
   * this server"; warnings are "Renovate is running but degraded." Empty array
   * when nothing was detected.
   */
  warnings: RuntimeWarning[];
  /**
   * Repo-aware diagnosis. Populated only when `checkSetup` is called with a
   * `repoPath`. Omitted entirely otherwise so the startup-time invocation in
   * `src/index.ts` (no repoPath) keeps its existing output shape.
   */
  repoContext?: RepoContext;
}

const VERSION_TIMEOUT_MS = 10_000;

const INSTALL_HINT =
  "Renovate ships bundled with renovate-mcp; if that fails to load, set RENOVATE_BIN / RENOVATE_CONFIG_VALIDATOR_BIN to a working binary or reinstall renovate-mcp.";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmp(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Tiny semver-range matcher tuned for the shapes Renovate's `engines.node`
 * actually uses (currently `^24.11.0`). Recognized: `^X.Y.Z`, `~X.Y.Z`,
 * `>=X.Y.Z`, and bare `X.Y.Z`. Anything else is treated as a non-match so we
 * stay conservative — a stale parser must not falsely claim a match. Exported
 * for unit tests.
 */
export function versionSatisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const trimmed = range.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("^")) {
    const min = parseVersion(trimmed.slice(1));
    if (!min) return false;
    if (cmp(v, min) < 0) return false;
    return v.major === min.major;
  }
  if (trimmed.startsWith("~")) {
    const min = parseVersion(trimmed.slice(1));
    if (!min) return false;
    if (cmp(v, min) < 0) return false;
    return v.major === min.major && v.minor === min.minor;
  }
  if (trimmed.startsWith(">=")) {
    const min = parseVersion(trimmed.slice(2));
    if (!min) return false;
    return cmp(v, min) >= 0;
  }
  const exact = parseVersion(trimmed);
  if (!exact) return false;
  return cmp(v, exact) === 0;
}

/**
 * Returns a hint message when the running Node version is outside Renovate's
 * declared `engines.node` range, or `null` when there's no mismatch or the
 * range can't be resolved. Renovate's CLI will print an `Unsupported node
 * environment` log line under the same condition; surfacing it here means the
 * LLM sees the mismatch before any `dry_run` is attempted.
 */
export function checkRenovateEnginesMatch(nodeVersion: string): string | null {
  let pkg: { engines?: { node?: string } };
  try {
    const pkgPath = requireFromHere.resolve("renovate/package.json");
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { engines?: { node?: string } };
  } catch {
    return null;
  }
  const range = pkg.engines?.node;
  if (!range) return null;
  if (versionSatisfiesRange(nodeVersion, range)) return null;
  return `Renovate requires Node \`${range}\`; you're on \`${nodeVersion}\`. Use nvm/asdf/volta to switch — Renovate will log \`Unsupported node environment\` otherwise.`;
}

/**
 * Read the bundled Renovate's version from its `package.json` without
 * spawning. Both `bin` entries (`renovate` + `renovate-config-validator`)
 * ship from the same package and share its version, so one filesystem read
 * answers both probes. Returns `null` if the package can't be resolved.
 *
 * Spawning `node <bundled-cli> --version` cold-loads Renovate's full ESM
 * graph (≈2 s per probe on a fast laptop, much more on cold caches) and
 * blocks the MCP `initialize` handshake — every session pays that cost
 * before the LLM can call any tool. Reading `package.json#version` is
 * ~milliseconds and removes the dominant startup-latency source for the
 * default install path. RE2 dlopen failures and other runtime warnings
 * would normally be surfaced by parsing the `--version` stderr; with the
 * spawn skipped at startup, they still fire on the first real tool call
 * (every shell-out through `renovateCli.ts:run` parses stderr the same
 * way), so the only thing lost is the startup-banner advance notice.
 */
function readBundledRenovateVersion(): string | null {
  try {
    const pkgPath = requireFromHere.resolve("renovate/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

async function checkBinary(tool: RenovateBinary): Promise<BinaryStatus> {
  const resolved = resolveRenovateTool(tool);
  const command = resolved.command;
  // Fast path: when we're using the bundled binary (the default), skip the
  // child-process spawn entirely and read the version from package.json.
  // See `readBundledRenovateVersion` for the rationale.
  if (resolved.source === "bundled") {
    const version = readBundledRenovateVersion();
    if (version) {
      return {
        tool,
        command,
        source: resolved.source,
        found: true,
        version,
      };
    }
    // Fall through to the spawn-based probe if package.json is missing or
    // unreadable — we want a real error message rather than a silent miss.
  }
  try {
    const result = await run(resolved.cmd, [...resolved.prefixArgs, "--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const runtimeWarnings = result.runtimeWarnings.length ? result.runtimeWarnings : undefined;
    if (result.exitCode !== 0) {
      return {
        tool,
        command,
        source: resolved.source,
        found: false,
        error: (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`,
        runtimeWarnings,
      };
    }
    return {
      tool,
      command,
      source: resolved.source,
      found: true,
      version: result.stdout.trim() || undefined,
      runtimeWarnings,
    };
  } catch (err) {
    return {
      tool,
      command,
      source: resolved.source,
      found: false,
      error: (err as Error).message,
    };
  }
}

export async function checkSetup(options: CheckSetupOptions = {}): Promise<SetupStatus> {
  const [renovate, renovateConfigValidator] = await Promise.all([
    checkBinary("renovate"),
    checkBinary("renovate-config-validator"),
  ]);

  const envOverrides: Record<string, string> = {};
  for (const key of ["RENOVATE_BIN", "RENOVATE_CONFIG_VALIDATOR_BIN"] as const) {
    const v = process.env[key];
    if (v) envOverrides[key] = v;
  }

  const hints: string[] = [];
  if (!renovate.found) {
    hints.push(`renovate not reachable at \`${renovate.command}\`. ${INSTALL_HINT}`);
  }
  if (!renovateConfigValidator.found) {
    hints.push(
      `renovate-config-validator not reachable at \`${renovateConfigValidator.command}\`. ${INSTALL_HINT}`,
    );
  }

  const engineMismatch = checkRenovateEnginesMatch(process.version);
  if (engineMismatch) {
    hints.push(engineMismatch);
  }

  const warnings = dedupeRuntimeWarnings([
    ...(renovate.runtimeWarnings ?? []),
    ...(renovateConfigValidator.runtimeWarnings ?? []),
  ]);

  const platformContext = inspectPlatformContext(process.env);

  let repoContext: RepoContext | undefined;
  if (options.repoPath) {
    repoContext = await gatherRepoContext(options.repoPath, platformContext, options.probe);
    appendRepoHints(repoContext, hints, platformContext);
  }

  return {
    node: process.version,
    renovate,
    renovateConfigValidator,
    envOverrides,
    platformContext,
    ok: renovate.found && renovateConfigValidator.found,
    hints,
    warnings,
    ...(repoContext ? { repoContext } : {}),
  };
}

async function gatherRepoContext(
  repoPath: string,
  platformContext: PlatformContext,
  probe: ((url: string) => Promise<EndpointProbeResult>) | undefined,
): Promise<RepoContext> {
  const inconsistencies: string[] = [];

  const remoteUrl = await readOriginRemote(repoPath);
  let remote: RepoContext["remote"] = null;
  if (remoteUrl) {
    const parsed = parseRemoteUrl(remoteUrl);
    if (parsed) {
      const classification = classifyRemoteHost(parsed.host);
      remote = { url: remoteUrl, ...parsed, ...classification };
    }
  }

  let configFile: RepoContext["configFile"] = null;
  let configEndpoint: string | undefined;
  let configPlatform: RepoContext["configPlatform"];
  try {
    const located = await locateConfig(repoPath);
    if (located) {
      configFile = { path: located.relPath, format: located.format };
      const cfgEndpoint = located.config.endpoint;
      if (typeof cfgEndpoint === "string" && cfgEndpoint.length > 0) {
        configEndpoint = cfgEndpoint;
      }
      const cfgPlatform = located.config.platform;
      if (cfgPlatform === "github" || cfgPlatform === "gitlab" || cfgPlatform === "local") {
        configPlatform = cfgPlatform;
      }
    }
  } catch {
    // Parsing errors are surfaced by read_config; for setup diagnosis we
    // intentionally swallow them rather than failing the whole tool.
  }

  const { platform: effectivePlatform, source: effectivePlatformSource } = derivePlatform(
    remote,
    configPlatform,
    platformContext.renovatePlatform,
  );

  if (remote && configEndpoint) {
    const cfgHost = safeHostFromUrl(configEndpoint);
    if (cfgHost && cfgHost !== remote.host) {
      inconsistencies.push(
        `Remote origin (\`${remote.host}\`) and config \`endpoint\` (\`${cfgHost}\`) point at different hosts. Renovate will use the config endpoint.`,
      );
    }
  }
  if (remote && platformContext.renovatePlatform) {
    const remoteSays =
      remote.classified === "github" || remote.classified === "gitlab"
        ? remote.classified
        : remote.flavor;
    if (
      remoteSays
      && remoteSays !== platformContext.renovatePlatform
      && platformContext.renovatePlatform !== "local"
    ) {
      inconsistencies.push(
        `Remote origin classifies as \`${remoteSays}\` but \`RENOVATE_PLATFORM=${platformContext.renovatePlatform}\`. \`dry_run\` will use the env value when its \`platform\` input is unset.`,
      );
    }
  }

  const probeUrlInfo = resolveProbeUrl(remote, configEndpoint, platformContext.renovateEndpoint);
  let endpointProbe: RepoContext["endpointProbe"];
  if (probeUrlInfo) {
    const fn = probe ?? probeEndpoint;
    const result = await fn(probeUrlInfo.url);
    endpointProbe = { ...result, derivedFrom: probeUrlInfo.derivedFrom };
  }

  return {
    repoPath,
    remote,
    configFile,
    configEndpoint,
    configPlatform,
    effectivePlatform,
    effectivePlatformSource,
    endpointProbe,
    inconsistencies,
  };
}

function derivePlatform(
  remote: RepoContext["remote"],
  configPlatform: RepoContext["configPlatform"],
  envPlatform: string | null,
): { platform: EffectivePlatform; source: EffectivePlatformSource } {
  if (remote) {
    if (remote.classified === "github") return { platform: "github", source: "remote" };
    if (remote.classified === "gitlab") return { platform: "gitlab", source: "remote" };
    if (remote.classified === "self-hosted" && remote.flavor && remote.flavor !== "unknown") {
      return { platform: remote.flavor, source: "remote" };
    }
  }
  if (configPlatform) return { platform: configPlatform, source: "config" };
  if (envPlatform === "github" || envPlatform === "gitlab" || envPlatform === "local") {
    return { platform: envPlatform, source: "env" };
  }
  if (remote?.classified === "self-hosted") {
    return { platform: "unknown", source: "remote" };
  }
  return { platform: "local", source: "default" };
}

function resolveProbeUrl(
  remote: RepoContext["remote"],
  configEndpoint: string | undefined,
  envEndpoint: string | null,
): { url: string; derivedFrom: "config" | "env" | "default" } | null {
  if (configEndpoint) return { url: configEndpoint, derivedFrom: "config" };
  if (envEndpoint) return { url: envEndpoint, derivedFrom: "env" };
  if (!remote) return null;
  if (remote.classified === "github") {
    return { url: "https://api.github.com", derivedFrom: "default" };
  }
  if (remote.classified === "gitlab") {
    return { url: "https://gitlab.com/api/v4/version", derivedFrom: "default" };
  }
  // self-hosted with no configured endpoint: don't guess a path on someone's
  // private host.
  return null;
}

function safeHostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function appendRepoHints(
  ctx: RepoContext,
  hints: string[],
  platformContext: PlatformContext,
): void {
  const platform = ctx.effectivePlatform;
  if (platform === "github") {
    const cred = resolveCredential(["RENOVATE_TOKEN", "GITHUB_TOKEN"]);
    if (!cred.envVar) {
      hints.push(
        "This repo's origin is on GitHub. Set `GITHUB_TOKEN` (a read-only PAT is enough — used for rate-limit headroom on public deps) in the MCP server's env, or `dry_run` will skip your github-actions dependencies with `skipReason: github-token-required`.",
      );
    }
  } else if (platform === "gitlab") {
    const cred = resolveCredential(["RENOVATE_TOKEN", "GITLAB_TOKEN"]);
    if (!cred.envVar) {
      hints.push(
        "This repo's origin is on GitLab. Set `GITLAB_TOKEN` (or `RENOVATE_TOKEN`) in the MCP server's env, or private-preset / private-registry lookups will fail.",
      );
    }
  }

  // github.com *datasource* token gap. `dry_run` defaults to `platform: local`
  // and never reads git origin, so for a github.com-origin repo the platform
  // token (GITHUB_TOKEN/RENOVATE_TOKEN) is NOT applied to github.com datasource
  // lookups under the default local run — Renovate reads GITHUB_COM_TOKEN for
  // that, and it is never auto-derived. The origin-derived `effectivePlatform`
  // can read "github" while the actual dry_run platform is "local"; this hint
  // reconciles that divergence for the case that trips users up.
  if (
    platformContext.effectiveDryRunPlatform === "local"
    && ctx.remote?.host === "github.com"
    && !platformContext.tokensPresent.GITHUB_COM_TOKEN
  ) {
    const hasPlatformToken =
      platformContext.tokensPresent.GITHUB_TOKEN || platformContext.tokensPresent.RENOVATE_TOKEN;
    if (hasPlatformToken) {
      hints.push(
        "This repo's origin is github.com, but `dry_run` defaults to `platform: local` and does not read git origin. The `GITHUB_TOKEN` / `RENOVATE_TOKEN` you've set is used for Renovate's *platform* role only — and that role is active only when you run `platform: \"github\"`. Under the default local run it is NOT applied to github.com *datasource* lookups (release notes, `github-tags` / `github-releases` / `github-actions`) at all. Either (a) set `GITHUB_COM_TOKEN` (the same read-only PAT works) so those lookups are authenticated, or (b) call `dry_run` with `platform: \"github\"`, `repository: \"<owner>/<repo>\"`, and the token, which covers both roles. (Moot if your config already has a github.com `hostRules` entry.)",
      );
    } else {
      hints.push(
        "This repo's origin is github.com. Under the default `dry_run` `platform: local`, github.com *datasource* lookups (release notes, `github-tags` / `github-releases` / `github-actions`) run anonymously — expect a low rate limit and possible `skipReason`. Set `GITHUB_COM_TOKEN` (a read-only PAT is enough) in the MCP server's env to authenticate them.",
      );
    }
  }

  if (
    ctx.remote?.classified === "self-hosted"
    && !ctx.configEndpoint
    && !platformContext.renovateEndpoint
  ) {
    hints.push(
      `Self-hosted host \`${ctx.remote.host}\` detected from origin, but no \`endpoint\` is configured. Set \`endpoint\` in renovate.json or \`RENOVATE_ENDPOINT\` in the MCP server's env — see docs/platform-setup.md.`,
    );
    if (ctx.remote.flavor === "unknown") {
      hints.push(
        `Could not infer GitHub vs GitLab from hostname \`${ctx.remote.host}\`. Set \`RENOVATE_PLATFORM=github\` or \`RENOVATE_PLATFORM=gitlab\` explicitly.`,
      );
    }
  }

  if (ctx.endpointProbe && !ctx.endpointProbe.reachable) {
    if (ctx.endpointProbe.skipped === "endpoint-blocked") {
      hints.push(
        `Skipped reachability probe of \`${ctx.endpointProbe.url}\`: ${ctx.endpointProbe.error ?? "blocked by endpoint allowlist"}. Use a public-DNS https URL for \`endpoint\` / \`RENOVATE_ENDPOINT\` — see docs/security.md#endpoint-validation.`,
      );
    } else {
      hints.push(
        `Could not reach \`${ctx.endpointProbe.url}\`: ${ctx.endpointProbe.error ?? "no response"}. If you're behind a VPN/proxy, \`dry_run\` will fail with the same network error.`,
      );
    }
  }

  for (const item of ctx.inconsistencies) {
    hints.push(item);
  }
}

/**
 * Reads platform-related env (RENOVATE_PLATFORM/_ENDPOINT/_TOKEN, plus
 * GITHUB_TOKEN / GITLAB_TOKEN) and reports what the `dry_run` tool would
 * actually do when its inputs are unset. Tokens are surfaced as presence
 * booleans only — values are never echoed.
 *
 * The `notes` array carries cross-checks mechanical enough to compute here
 * but easy to miss when staring at a `dry_run` failure: missing token for the
 * selected platform, an endpoint that looks like a UI URL instead of an API
 * URL, and an unsupported `RENOVATE_PLATFORM` value (which silently degrades
 * to `local` because of dry_run's enum whitelist).
 */
export function inspectPlatformContext(env: NodeJS.ProcessEnv): PlatformContext {
  const renovatePlatformRaw = env.RENOVATE_PLATFORM ?? null;
  const renovateEndpoint = env.RENOVATE_ENDPOINT ?? null;
  const tokensPresent = {
    RENOVATE_TOKEN: Boolean(env.RENOVATE_TOKEN),
    GITHUB_TOKEN: Boolean(env.GITHUB_TOKEN),
    GITLAB_TOKEN: Boolean(env.GITLAB_TOKEN),
    GITHUB_COM_TOKEN: Boolean(env.GITHUB_COM_TOKEN),
  };

  const allowedPlatform = DRY_RUN_PLATFORMS.find((p) => p === renovatePlatformRaw);
  const effectiveDryRunPlatform: DryRunPlatform = allowedPlatform ?? "local";

  const notes: string[] = [];

  if (renovatePlatformRaw && !allowedPlatform) {
    notes.push(
      `\`RENOVATE_PLATFORM=${renovatePlatformRaw}\` is outside the \`dry_run\` schema enum (\`local\`/\`github\`/\`gitlab\`). The env fallback ignores it, so \`dry_run\` will silently use \`local\` — pass \`platform\` explicitly when calling \`dry_run\` if you need a different value.`,
    );
  }

  if (allowedPlatform === "gitlab" && !tokensPresent.GITLAB_TOKEN && !tokensPresent.RENOVATE_TOKEN) {
    notes.push(
      "`RENOVATE_PLATFORM=gitlab` is set but neither `GITLAB_TOKEN` nor `RENOVATE_TOKEN` is present in the MCP server's env — `gitlab>` presets and private-repo lookups will likely fail to authenticate.",
    );
  } else if (
    allowedPlatform === "gitlab"
    && tokensPresent.GITLAB_TOKEN
    && !tokensPresent.RENOVATE_TOKEN
  ) {
    notes.push(
      "Info: `GITLAB_TOKEN` is set without `RENOVATE_TOKEN`. `dry_run` will export `GITLAB_TOKEN` as `RENOVATE_TOKEN` to the spawned Renovate CLI when `platform=gitlab` (Renovate itself only reads `RENOVATE_TOKEN`). `resolve_config` already accepts this fallback directly.",
    );
  }
  if (allowedPlatform === "github" && !tokensPresent.GITHUB_TOKEN && !tokensPresent.RENOVATE_TOKEN) {
    notes.push(
      "`RENOVATE_PLATFORM=github` is set but neither `GITHUB_TOKEN` nor `RENOVATE_TOKEN` is present in the MCP server's env — `github>` presets and private-repo lookups will likely fail to authenticate.",
    );
  } else if (
    allowedPlatform === "github"
    && tokensPresent.GITHUB_TOKEN
    && !tokensPresent.RENOVATE_TOKEN
  ) {
    notes.push(
      "Info: `GITHUB_TOKEN` is set without `RENOVATE_TOKEN`. `dry_run` will export `GITHUB_TOKEN` as `RENOVATE_TOKEN` to the spawned Renovate CLI when `platform=github` (Renovate itself only reads `RENOVATE_TOKEN`). `resolve_config` already accepts this fallback directly.",
    );
  }

  if (renovateEndpoint && looksLikeUiUrl(renovateEndpoint)) {
    notes.push(
      `\`RENOVATE_ENDPOINT=${renovateEndpoint}\` looks like a UI URL. Renovate expects an API base URL — typically \`/api/v4/\` for GitLab or \`/api/v3/\` for GitHub Enterprise.`,
    );
  }

  return {
    renovatePlatform: renovatePlatformRaw,
    renovateEndpoint,
    tokensPresent,
    effectiveDryRunPlatform,
    notes,
  };
}

/**
 * Heuristic: a GitLab/GitHub endpoint is meant to be the API base, but users
 * routinely paste the web UI URL. Trigger the note when the URL is missing
 * any `/api/` segment. We avoid hard-coding `/api/v4/` vs `/api/v3/` since
 * Renovate accepts either depending on platform. Applies regardless of the
 * effective platform — `dry_run` forwards `--endpoint` even in local mode to
 * redirect `gitlab>` / `github>` preset shortcuts at a self-hosted host.
 */
function looksLikeUiUrl(endpoint: string): boolean {
  return !/\/api\//.test(endpoint);
}

// Tools that do not depend on the Renovate CLI and are always callable.
export const OFFLINE_TOOLS = ["read_config", "resolve_config", "preview_custom_manager"] as const;

// Returns the tool names that cannot currently run because their backing
// binary is missing. Order is workflow-ordered (validate → dry_run → write).
export function unavailableTools(status: SetupStatus): string[] {
  const names: string[] = [];
  if (!status.renovateConfigValidator.found) names.push("validate_config");
  if (!status.renovate.found) names.push("dry_run");
  if (!status.renovateConfigValidator.found) names.push("write_config");
  return names;
}

/**
 * Concise startup banner appended to the server's MCP `instructions` so the
 * LLM is primed to treat CLI-missing as a partial-availability signal rather
 * than a setup error. Also emits a banner — independent of binary availability
 * — when Renovate runtime warnings are detected (e.g. RE2 dlopen failure
 * causing a slow-path fallback). Returns `null` when nothing needs surfacing.
 */
export function startupBanner(status: SetupStatus): string | null {
  const unavailable = unavailableTools(status);
  const sections: string[] = [];

  if (unavailable.length > 0) {
    const unavailList = unavailable.map((n) => `\`${n}\``).join(", ");
    const offlineList = OFFLINE_TOOLS.map((n) => `\`${n}\``).join(", ");
    sections.push(
      [
        "Partial availability:",
        `  Renovate CLI not reachable — only blocks: ${unavailList}.`,
        `  Offline tools (${offlineList}) still work; do not flag this as a setup problem when the task only needs those.`,
        "  Renovate ships bundled with renovate-mcp; if you see this banner, the bundled binary failed to spawn or `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` points at a broken binary. Call `check_setup` for a full diagnostic.",
        "  Set `RENOVATE_MCP_REQUIRE_CLI=false` to suppress this notice if you have consciously chosen the offline subset.",
      ].join("\n"),
    );
  }

  if (status.warnings.length > 0) {
    const lines: string[] = ["Renovate runtime warnings:"];
    for (const w of status.warnings) {
      lines.push(`  - ${w.message}`);
      lines.push(`    Fix: ${w.fix}`);
    }
    lines.push("  These do not block tool calls. Surface this if a user reports unexpectedly slow runs.");
    sections.push(lines.join("\n"));
  }

  return sections.length === 0 ? null : sections.join("\n\n");
}

export function describeSetup(status: SetupStatus): string {
  const lines: string[] = [];
  lines.push(`Node: ${status.node}`);
  lines.push(`renovate: ${formatBinary(status.renovate)}`);
  lines.push(`renovate-config-validator: ${formatBinary(status.renovateConfigValidator)}`);
  const overrideKeys = Object.keys(status.envOverrides);
  if (overrideKeys.length > 0) {
    lines.push("Env overrides:");
    for (const key of overrideKeys) lines.push(`  ${key}=${status.envOverrides[key]}`);
  }
  lines.push("");
  lines.push("Platform context:");
  const ctx = status.platformContext;
  lines.push(`  RENOVATE_PLATFORM: ${ctx.renovatePlatform ?? "(unset)"}`);
  lines.push(`  RENOVATE_ENDPOINT: ${ctx.renovateEndpoint ?? "(unset)"}`);
  const tokens = Object.entries(ctx.tokensPresent)
    .map(([k, v]) => `${k}=${v ? "set" : "unset"}`)
    .join(", ");
  lines.push(`  Tokens: ${tokens}`);
  lines.push(`  Effective dry_run platform (when input unset): ${ctx.effectiveDryRunPlatform}`);
  if (ctx.notes.length > 0) {
    lines.push("  Notes:");
    for (const n of ctx.notes) lines.push(`    - ${n}`);
  }
  if (status.repoContext) {
    const rc = status.repoContext;
    lines.push("");
    lines.push(`Repo context (${rc.repoPath}):`);
    if (rc.remote) {
      const flavor = rc.remote.flavor ? ` (${rc.remote.flavor})` : "";
      lines.push(`  origin: ${rc.remote.url}`);
      lines.push(`  host: ${rc.remote.host} → ${rc.remote.classified}${flavor}`);
    } else {
      lines.push("  origin: (no git remote found)");
    }
    if (rc.configFile) {
      lines.push(`  config: ${rc.configFile.path} (${rc.configFile.format})`);
    } else {
      lines.push("  config: (no renovate config found)");
    }
    if (rc.configEndpoint) lines.push(`  config.endpoint: ${rc.configEndpoint}`);
    if (rc.configPlatform) lines.push(`  config.platform: ${rc.configPlatform}`);
    lines.push(`  effective platform: ${rc.effectivePlatform} (from ${rc.effectivePlatformSource})`);
    if (rc.endpointProbe) {
      if (rc.endpointProbe.skipped) {
        lines.push(`  endpoint probe (${rc.endpointProbe.derivedFrom}): SKIPPED — ${rc.endpointProbe.skipped}`);
      } else if (rc.endpointProbe.reachable) {
        const status = rc.endpointProbe.status ?? "?";
        lines.push(`  endpoint probe (${rc.endpointProbe.derivedFrom}): ${rc.endpointProbe.url} → ${status}`);
      } else {
        lines.push(`  endpoint probe (${rc.endpointProbe.derivedFrom}): ${rc.endpointProbe.url} → UNREACHABLE (${rc.endpointProbe.error ?? "no response"})`);
      }
    }
    if (rc.inconsistencies.length > 0) {
      lines.push("  Inconsistencies:");
      for (const i of rc.inconsistencies) lines.push(`    - ${i}`);
    }
  }
  if (status.hints.length > 0) {
    lines.push("");
    lines.push("Hints:");
    for (const h of status.hints) lines.push(`  - ${h}`);
  }
  if (status.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of status.warnings) {
      lines.push(`  - ${w.message}`);
      if (w.detail) lines.push(`    Detail: ${w.detail}`);
      lines.push(`    Fix: ${w.fix}`);
    }
  }
  return lines.join("\n");
}

function formatBinary(s: BinaryStatus): string {
  if (s.found) {
    const version = s.version ?? "(version unknown)";
    if (s.source === "bundled") return `${version} (bundled)`;
    const prefix = s.source === "env" ? "env" : "PATH";
    return `${version} (${prefix}: ${s.command})`;
  }
  if (s.source === "bundled") return `MISSING — ${s.error ?? "unknown error"} (bundled)`;
  return `MISSING — ${s.error ?? "unknown error"} (${s.command})`;
}
