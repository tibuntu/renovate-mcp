import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { detectRuntimeWarnings, type RuntimeWarning } from "./runtimeWarnings.js";

const requireFromHere = createRequire(import.meta.url);

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Renovate runtime conditions detected from stderr that the caller benefits
   * from knowing about even though the run itself may have succeeded (e.g. RE2
   * native-module dlopen failure causing a silent slow-path fallback). Always
   * present — empty array when nothing was detected.
   */
  runtimeWarnings: RuntimeWarning[];
  /**
   * True when stdout or stderr exceeded MAX_CAPTURE_BYTES and only the tail
   * was kept. Line observers still saw every line.
   */
  truncated: boolean;
}

/** Per-stream cap on captured output; only the tail is kept beyond it. */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
/** Cap on a partial (newline-free) line held for the line observers. */
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Bounded capture of one stream: chunks are appended as they arrive and whole
 * chunks are dropped from the front once the total passes the cap, so nothing
 * is copied per chunk. Joined once on close.
 */
class TailBuffer {
  private chunks: string[] = [];
  private length = 0;
  truncated = false;

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length > MAX_CAPTURE_BYTES && this.chunks.length > 1) {
      this.length -= this.chunks.shift()!.length;
      this.truncated = true;
    }
  }

  join(): string {
    const s = this.chunks.join("");
    // A single oversized chunk can still exceed the cap; trim once here.
    if (s.length <= MAX_CAPTURE_BYTES) return s;
    this.truncated = true;
    return s.slice(-MAX_CAPTURE_BYTES);
  }
}

/** Thrown by `run()` when the child exceeded `timeoutMs` and was killed. */
export class CommandTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, cmd: string, args: string[]) {
    super(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`);
    this.name = "CommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  /**
   * Optional line-oriented observers. Invoked once per complete line (newline
   * stripped) as data arrives, and once more on process close for any trailing
   * non-empty fragment. Exceptions thrown by the callbacks are swallowed so a
   * buggy observer can't crash the child-process pipeline.
   */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

/**
 * Spawn a command and capture stdout/stderr. Never throws on non-zero exit —
 * caller inspects exitCode. Throws only for spawn errors (ENOENT etc.) and
 * timeouts.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `detached` makes the child a process-group leader so a timeout can kill
    // the whole group — Renovate spawns git and package-manager children that
    // would otherwise outlive it.
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const stdoutBuf = new TailBuffer();
    const stderrBuf = new TailBuffer();
    let stdoutLineBuf = "";
    let stderrLineBuf = "";
    let timer: NodeJS.Timeout | undefined;
    let killed = false;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, opts.timeoutMs);
    }

    const emitLines = (
      chunk: string,
      buf: string,
      cb: ((line: string) => void) | undefined,
    ): string => {
      if (!cb) return "";
      const combined = buf + chunk;
      const parts = combined.split(/\r?\n/);
      const trailing = parts.pop() ?? "";
      for (const line of parts) {
        try {
          cb(line);
        } catch {
          // never let an observer crash the pipeline
        }
      }
      // A newline-free stream must not grow the partial-line buffer unbounded.
      return trailing.length > MAX_LINE_BYTES ? trailing.slice(-MAX_LINE_BYTES) : trailing;
    };

    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdoutBuf.push(chunk);
      stdoutLineBuf = emitLines(chunk, stdoutLineBuf, opts.onStdoutLine);
    });
    child.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderrBuf.push(chunk);
      stderrLineBuf = emitLines(chunk, stderrLineBuf, opts.onStderrLine);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // Flush trailing partial lines (output that didn't end with a newline).
      if (stdoutLineBuf && opts.onStdoutLine) {
        try {
          opts.onStdoutLine(stdoutLineBuf);
        } catch {
          // ignore
        }
      }
      if (stderrLineBuf && opts.onStderrLine) {
        try {
          opts.onStderrLine(stderrLineBuf);
        } catch {
          // ignore
        }
      }
      if (killed) {
        reject(new CommandTimeoutError(opts.timeoutMs!, cmd, args));
        return;
      }
      const stdout = stdoutBuf.join();
      const stderr = stderrBuf.join();
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        runtimeWarnings: detectRuntimeWarnings(stderr),
        truncated: stdoutBuf.truncated || stderrBuf.truncated,
      });
    });

    if (opts.stdin != null) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export interface ResolvedRenovateTool {
  /** Process to spawn. */
  cmd: string;
  /** Args prepended to the caller's args (e.g., the JS file path when `cmd` is `node`). */
  prefixArgs: string[];
  /** Where the binary came from — drives setup-status messaging. */
  source: "env" | "bundled" | "path";
  /**
   * Raw user-visible identifier for the resolved binary. For `env` it's the
   * env-var value (often an absolute path); for `bundled` and `path` it's the
   * tool name. Callers compose this with `source` when rendering a label —
   * keeping it raw avoids producing nested parens in error messages like
   * `MISSING — <err> (<command>)`.
   */
  command: string;
}

/**
 * Locate the JS entry-point for one of Renovate's CLI tools inside the
 * `renovate` npm package shipped as a runtime dep. Returns `null` if the
 * package can't be resolved or its `bin` field doesn't list the tool —
 * callers fall back to PATH lookup so a user with a deliberately broken
 * `renovate` install (or an unusual install topology that hides it from
 * `require.resolve`) still has an escape hatch.
 */
function resolveBundledBinary(tool: "renovate" | "renovate-config-validator"): string | null {
  try {
    const pkgPath = requireFromHere.resolve("renovate/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin?: Record<string, string> };
    const binEntry = pkg.bin?.[tool];
    if (typeof binEntry !== "string") return null;
    const binAbs = path.join(path.dirname(pkgPath), binEntry);
    if (!fs.existsSync(binAbs)) return null;
    return binAbs;
  } catch {
    return null;
  }
}

/**
 * Resolve how to invoke a Renovate CLI tool. Resolution order:
 *   1. `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` env override — if set,
 *      always wins (even if it points at a broken path; we surface the spawn
 *      error rather than silently falling through).
 *   2. Bundled binary — the `renovate` package is a runtime dep, so its
 *      `bin/renovate.js` / `bin/config-validator.js` ship with the install.
 *      Spawned as `node <jsPath>` to sidestep shebang/permission concerns.
 *   3. Bare tool name on `PATH` — last-resort fallback for the unusual case
 *      where the bundled lookup fails (e.g. a corrupted node_modules). Only
 *      manually tested; unit-testing this branch would require monkey-patching
 *      `require.resolve` to fake a bundled-lookup failure.
 */
export function resolveRenovateTool(
  tool: "renovate" | "renovate-config-validator",
): ResolvedRenovateTool {
  const envKey = tool === "renovate" ? "RENOVATE_BIN" : "RENOVATE_CONFIG_VALIDATOR_BIN";
  const envValue = process.env[envKey];
  if (envValue) {
    return { cmd: envValue, prefixArgs: [], source: "env", command: envValue };
  }
  const bundled = resolveBundledBinary(tool);
  if (bundled) {
    return { cmd: process.execPath, prefixArgs: [bundled], source: "bundled", command: tool };
  }
  return { cmd: tool, prefixArgs: [], source: "path", command: tool };
}

/**
 * Message for a `CommandTimeoutError`: the binary ran but exceeded its budget,
 * so the missing-binary hints (env override, check_setup) would mislead.
 */
export function formatTimeoutError(
  tool: "renovate" | "renovate-config-validator",
  err: CommandTimeoutError,
): string {
  const hint =
    tool === "renovate"
      ? "Raise `timeoutMs` (max 15 minutes) or narrow the run with `dryRunMode: \"extract\"`."
      : "Retry; if it keeps timing out, the config may be extremely large or the machine overloaded.";
  return `\`${tool}\` timed out after ${err.timeoutMs} ms and was killed. ${hint}`;
}

/**
 * Centralized message for when a Renovate CLI binary can't be spawned (ENOENT,
 * permission denied, etc.). Used by all tools that shell out so users get
 * consistent, actionable hints instead of raw spawn errors. Renovate ships
 * bundled with the server, so the most likely cause of failure here is a
 * deliberately broken `RENOVATE_BIN` override or a corrupted install.
 */
export function formatMissingBinaryError(
  tool: "renovate" | "renovate-config-validator",
  cause: Error,
): string {
  const envKey = tool === "renovate" ? "RENOVATE_BIN" : "RENOVATE_CONFIG_VALIDATOR_BIN";
  return [
    `Failed to run \`${tool}\`: ${cause.message}.`,
    `Renovate ships bundled with renovate-mcp; if the bundled binary fails to load, set ${envKey} to a working binary or reinstall renovate-mcp.`,
    "Call the `check_setup` tool for a full diagnostic.",
  ].join(" ");
}
