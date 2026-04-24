import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_ENTRY = path.resolve(__dirname, "../../dist/index.js");
// V8 coverage instrumentation inflates child cold start; allow more headroom
// when NODE_V8_COVERAGE is set (vitest sets it for --coverage runs).
const DEFAULT_REQUEST_TIMEOUT_MS = process.env.NODE_V8_COVERAGE ? 30_000 : 10_000;
const STDERR_CAP_BYTES = 64 * 1024;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StartServerOptions {
  /** Per-request wall-clock timeout in milliseconds. Default: 10_000. */
  requestTimeoutMs?: number;
  /** Override the script to spawn. Default: dist/index.js of this repo. */
  serverEntry?: string;
}

export interface McpSession {
  request<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse & { result?: T }>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
  readonly child: ChildProcess;
  readonly instructions: string;
  /** Current buffered stderr from the server (capped). */
  readonly stderr: string;
}

/**
 * Spawn the MCP server, run the initialize handshake, and return a session you
 * can call request/notify on. The server shuts down cleanly when you call
 * close() (which ends stdin, triggering StdioServerTransport to close).
 *
 * Pending requests reject on wall-clock timeout, on `child error`, or on
 * `child exit` — the rejection message includes the buffered stderr so a
 * crashed server surfaces diagnostics instead of hanging the test.
 */
export async function startServer(
  env: NodeJS.ProcessEnv = {},
  options: StartServerOptions = {},
): Promise<McpSession> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const serverEntry = options.serverEntry ?? DEFAULT_SERVER_ENTRY;

  const child = spawn("node", [serverEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  let stderrBuffer = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > STDERR_CAP_BYTES) {
      stderrBuffer = stderrBuffer.slice(stderrBuffer.length - STDERR_CAP_BYTES);
    }
  });

  interface Pending {
    method: string;
    resolve: (msg: JsonRpcResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }
  const pending = new Map<number, Pending>();

  let terminated = false;
  let terminationError: Error | null = null;
  let closed = false;

  function stderrSuffix(): string {
    return stderrBuffer ? `\n--- server stderr ---\n${stderrBuffer.trimEnd()}` : "";
  }

  function failAllPending(err: Error) {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  child.on("error", (err) => {
    terminated = true;
    terminationError = new Error(`MCP server spawn error: ${err.message}${stderrSuffix()}`);
    failAllPending(terminationError);
  });

  child.on("exit", (code, signal) => {
    terminated = true;
    if (pending.size === 0) return;
    const desc = signal ? `signal ${signal}` : `code ${code}`;
    terminationError = new Error(
      `MCP server exited (${desc}) with ${pending.size} pending request(s)${stderrSuffix()}`,
    );
    failAllPending(terminationError);
  });

  child.on("close", () => {
    closed = true;
  });

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    } catch {
      // non-JSON stdout line — ignore
    }
  });

  let nextId = 0;

  function request<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse & { result?: T }> {
    if (terminated) {
      return Promise.reject(
        terminationError ??
          new Error(`MCP server has terminated before request ${method}${stderrSuffix()}`),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `MCP request ${method} (id=${id}) timed out after ${requestTimeoutMs}ms${stderrSuffix()}`,
          ),
        );
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, {
        method,
        resolve: resolve as (msg: JsonRpcResponse) => void,
        reject,
        timer,
      });
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  function notify(method: string, params?: unknown): void {
    if (terminated) return;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  const init = await request<{ instructions?: string }>("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0" },
  });
  notify("notifications/initialized");

  return {
    request,
    notify,
    child,
    instructions: init.result?.instructions ?? "",
    get stderr() {
      return stderrBuffer;
    },
    async close() {
      if (closed) return;
      try {
        child.stdin!.end();
      } catch {
        // stdin may already be closed — fine.
      }
      await new Promise<void>((resolve) => {
        if (closed) return resolve();
        child.once("close", () => resolve());
      });
    },
  };
}
