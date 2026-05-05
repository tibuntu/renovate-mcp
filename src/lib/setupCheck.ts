import { run, resolveRenovateTool } from "./renovateCli.js";
import { dedupeRuntimeWarnings, type RuntimeWarning } from "./runtimeWarnings.js";

export type RenovateBinary = "renovate" | "renovate-config-validator";

export interface BinaryStatus {
  tool: RenovateBinary;
  command: string;
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
}

const VERSION_TIMEOUT_MS = 10_000;

const INSTALL_HINT =
  "Install Renovate globally with `npm i -g renovate`, or set RENOVATE_BIN / RENOVATE_CONFIG_VALIDATOR_BIN to existing binaries.";

async function checkBinary(tool: RenovateBinary): Promise<BinaryStatus> {
  const command = resolveRenovateTool(tool);
  try {
    const result = await run(command, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    const runtimeWarnings = result.runtimeWarnings.length ? result.runtimeWarnings : undefined;
    if (result.exitCode !== 0) {
      return {
        tool,
        command,
        found: false,
        error: (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`,
        runtimeWarnings,
      };
    }
    return {
      tool,
      command,
      found: true,
      version: result.stdout.trim() || undefined,
      runtimeWarnings,
    };
  } catch (err) {
    return {
      tool,
      command,
      found: false,
      error: (err as Error).message,
    };
  }
}

export async function checkSetup(): Promise<SetupStatus> {
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

  const warnings = dedupeRuntimeWarnings([
    ...(renovate.runtimeWarnings ?? []),
    ...(renovateConfigValidator.runtimeWarnings ?? []),
  ]);

  return {
    node: process.version,
    renovate,
    renovateConfigValidator,
    envOverrides,
    platformContext: inspectPlatformContext(process.env),
    ok: renovate.found && renovateConfigValidator.found,
    hints,
    warnings,
  };
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
        `  Renovate CLI not found — only blocks: ${unavailList}.`,
        `  Offline tools (${offlineList}) still work; do not flag this as a setup problem when the task only needs those.`,
        "  Install Renovate (`npm i -g renovate`) before calling the blocked tools, or call `check_setup` for a full diagnostic.",
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
  if (s.found) return `${s.version ?? "(version unknown)"} (${s.command})`;
  return `MISSING — ${s.error ?? "unknown error"}`;
}
