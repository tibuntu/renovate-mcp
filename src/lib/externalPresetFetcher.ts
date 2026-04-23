import { classifyExternalSource, type ParsedPreset } from "./presetResolver.js";

export interface FetchOptions {
  timeoutMs?: number;
  cache?: Map<string, Promise<FetchResult>>;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type FetchResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchExternalPreset(
  parsed: ParsedPreset,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const cache = options.cache;
  const cacheKey = parsed.key;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }
  const promise = dispatch(parsed, options);
  cache?.set(cacheKey, promise);
  return promise;
}

function dispatch(parsed: ParsedPreset, options: FetchOptions): Promise<FetchResult> {
  if (!parsed.source) {
    return Promise.resolve({ ok: false, reason: "Unknown preset source: (none)" });
  }

  const classification = classifyExternalSource(parsed.source);
  if (!classification.fetchable) {
    return Promise.resolve({ ok: false, reason: classification.reason });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  switch (parsed.source) {
    case "github":
      return fetchGitHub(parsed, timeoutMs, fetchImpl);
    case "gitlab":
      return fetchGitLab(parsed, timeoutMs, fetchImpl);
    default:
      return Promise.resolve({
        ok: false,
        reason: `Unknown preset source: ${parsed.source}`,
      });
  }
}

async function fetchGitHub(
  parsed: ParsedPreset,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  if (!parsed.repoPath || !parsed.repoPath.includes("/")) {
    return { ok: false, reason: `Invalid github preset: ${parsed.original}` };
  }
  const file = presetFileName(parsed);
  const ref = parsed.ref ?? "HEAD";
  const url = `https://api.github.com/repos/${parsed.repoPath}/contents/${encodeFilePath(
    file,
  )}?ref=${encodeURIComponent(ref)}`;
  const token = process.env.GITHUB_TOKEN || process.env.RENOVATE_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "renovate-mcp",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetchJson(url, headers, timeoutMs, parsed.original, fetchImpl);
}

async function fetchGitLab(
  parsed: ParsedPreset,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  if (!parsed.repoPath) {
    return { ok: false, reason: `Invalid gitlab preset: ${parsed.original}` };
  }
  const file = presetFileName(parsed);
  const ref = parsed.ref ?? "HEAD";
  const url = `https://gitlab.com/api/v4/projects/${encodeURIComponent(
    parsed.repoPath,
  )}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`;
  const token = process.env.GITLAB_TOKEN || process.env.RENOVATE_TOKEN;
  const headers: Record<string, string> = { "User-Agent": "renovate-mcp" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  return fetchJson(url, headers, timeoutMs, parsed.original, fetchImpl);
}

function presetFileName(parsed: ParsedPreset): string {
  if (parsed.subpath) return ensureJson(parsed.subpath);
  if (parsed.presetName) return ensureJson(parsed.presetName);
  return "default.json";
}

function ensureJson(name: string): string {
  return /\.(json5?|jsonc)$/i.test(name) ? name : `${name}.json`;
}

function encodeFilePath(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  presetName: string,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false,
        reason: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} when fetching ${presetName}`,
      };
    }
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {
          ok: false,
          reason: `Preset body for ${presetName} is not a JSON object.`,
        };
      }
      return { ok: true, body: body as Record<string, unknown> };
    } catch (e) {
      return {
        ok: false,
        reason: `Preset body for ${presetName} is not valid JSON: ${(e as Error).message}`,
      };
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return {
        ok: false,
        reason: `Timed out after ${timeoutMs}ms fetching ${presetName}`,
      };
    }
    return {
      ok: false,
      reason: `Network error fetching ${presetName}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
