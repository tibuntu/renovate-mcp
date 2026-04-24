import { spawn } from "node:child_process";
import { toMessage } from "./errors.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
}

/**
 * Spawn a command and capture stdout/stderr. Never throws on non-zero exit —
 * caller inspects exitCode. Throws only for spawn errors (ENOENT etc.) and
 * timeouts.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let killed = false;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(new Error(`Command timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(" ")}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    if (opts.stdin != null) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Resolve how to invoke a Renovate CLI tool. Users can override via env:
 *   RENOVATE_BIN                  — path to the `renovate` binary
 *   RENOVATE_CONFIG_VALIDATOR_BIN — path to the validator binary
 * Otherwise we rely on PATH resolution (globally installed Renovate, or a
 * `npm exec` from a project with Renovate installed locally).
 */
export function resolveRenovateTool(tool: "renovate" | "renovate-config-validator"): string {
  const envKey = tool === "renovate" ? "RENOVATE_BIN" : "RENOVATE_CONFIG_VALIDATOR_BIN";
  return process.env[envKey] || tool;
}

/**
 * Centralized message for when a Renovate CLI binary can't be spawned (ENOENT,
 * permission denied, etc.). Used by all tools that shell out so users get
 * consistent, actionable hints instead of raw spawn errors.
 */
export function formatMissingBinaryError(
  tool: "renovate" | "renovate-config-validator",
  cause: unknown,
): string {
  const envKey = tool === "renovate" ? "RENOVATE_BIN" : "RENOVATE_CONFIG_VALIDATOR_BIN";
  return [
    `Failed to run \`${tool}\`: ${toMessage(cause)}.`,
    `Install Renovate globally with \`npm i -g renovate\`, or set ${envKey} to point at an existing binary.`,
    "Call the `check_setup` tool for a full diagnostic.",
  ].join(" ");
}
