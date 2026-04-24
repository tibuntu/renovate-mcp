import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "../../dist/index.js");

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

export interface McpSession {
  request<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse & { result?: T }>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
  readonly child: ChildProcess;
  readonly instructions: string;
}

/**
 * Spawn dist/index.js, run the initialize handshake, and return a session you
 * can call request/notify on. The server shuts down cleanly when you call
 * close() (which ends stdin, triggering StdioServerTransport to close).
 */
export async function startServer(env: NodeJS.ProcessEnv = {}): Promise<McpSession> {
  const child = spawn("node", [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    } catch {
      // non-JSON stdout line — ignore
    }
  });

  let nextId = 0;

  function request<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<JsonRpcResponse & { result?: T }> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve as (msg: JsonRpcResponse) => void);
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  function notify(method: string, params?: unknown): void {
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
    async close() {
      child.stdin!.end();
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
    },
  };
}
