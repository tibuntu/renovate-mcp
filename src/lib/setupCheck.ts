import { run, resolveRenovateTool } from "./renovateCli.js";

export type RenovateBinary = "renovate" | "renovate-config-validator";

export interface BinaryStatus {
  tool: RenovateBinary;
  command: string;
  found: boolean;
  version?: string;
  error?: string;
}

export interface SetupStatus {
  node: string;
  renovate: BinaryStatus;
  renovateConfigValidator: BinaryStatus;
  envOverrides: Record<string, string>;
  ok: boolean;
  hints: string[];
}

const VERSION_TIMEOUT_MS = 10_000;

const INSTALL_HINT =
  "Install Renovate globally with `npm i -g renovate`, or set RENOVATE_BIN / RENOVATE_CONFIG_VALIDATOR_BIN to existing binaries.";

async function checkBinary(tool: RenovateBinary): Promise<BinaryStatus> {
  const command = resolveRenovateTool(tool);
  try {
    const result = await run(command, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      return {
        tool,
        command,
        found: false,
        error: (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`,
      };
    }
    return {
      tool,
      command,
      found: true,
      version: result.stdout.trim() || undefined,
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

  return {
    node: process.version,
    renovate,
    renovateConfigValidator,
    envOverrides,
    ok: renovate.found && renovateConfigValidator.found,
    hints,
  };
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
  if (status.hints.length > 0) {
    lines.push("");
    lines.push("Hints:");
    for (const h of status.hints) lines.push(`  - ${h}`);
  }
  return lines.join("\n");
}

function formatBinary(s: BinaryStatus): string {
  if (s.found) return `${s.version ?? "(version unknown)"} (${s.command})`;
  return `MISSING — ${s.error ?? "unknown error"}`;
}
