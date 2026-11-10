import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Wiring for test/fixtures/fetch-stub.mjs: a network stub the MCP server
 * child, its Renovate workers and the fake renovate binary all preload via
 * NODE_OPTIONS. Spawn, stdio and the workers stay real; only the HTTPS
 * answers come from a table (see docs/development.md, "Network stub").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FETCH_STUB_URL = pathToFileURL(path.resolve(__dirname, "../fixtures/fetch-stub.mjs")).href;

export interface StubRoute {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StubbedRequest {
  url: string;
  method: string;
  authorization: string | null;
}

/** Env for `startServer` that preloads the stub with `routes`, logging requests to `logPath`. */
export function fetchStubEnv(routes: Record<string, StubRoute>, logPath?: string): Record<string, string> {
  const env: Record<string, string> = {
    NODE_OPTIONS: `--import=${FETCH_STUB_URL}`,
    RENOVATE_MCP_TEST_FETCH_ROUTES: JSON.stringify(routes),
  };
  if (logPath) env.RENOVATE_MCP_TEST_FETCH_LOG = logPath;
  return env;
}

/** The requests the stub logged, in order; empty when nothing was requested. */
export async function readFetchLog(logPath: string): Promise<StubbedRequest[]> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubbedRequest);
}

/** A GitHub contents / GitLab repository-files API answer carrying `content` as the file. */
export function repoFileRoute(content: unknown): StubRoute {
  return { body: { content: Buffer.from(JSON.stringify(content)).toString("base64") } };
}
