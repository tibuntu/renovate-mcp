import { resolveCredential, type Credential } from "./credentialResolver.js";
import { classifyExternalSource, type ParsedPreset } from "./presetResolver.js";

export interface FetchOptions {
  timeoutMs?: number;
  cache?: Map<string, Promise<FetchResult>>;
  /**
   * Override the API base URL. For `github>` presets, defaults to
   * `https://api.github.com` (pass `https://ghe.example.com/api/v3` for GitHub
   * Enterprise). For `gitlab>`, defaults to `https://gitlab.com/api/v4` (pass
   * `https://gitlab.example.com/api/v4` for self-hosted).
   */
  endpoint?: string;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export type FetchResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_GITLAB_API_BASE = "https://gitlab.com/api/v4";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

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
  const endpoint = options.endpoint ? trimTrailingSlash(options.endpoint) : undefined;

  switch (parsed.source) {
    case "github":
      return fetchGitHub(parsed, timeoutMs, fetchImpl, endpoint);
    case "gitlab":
      return fetchGitLab(parsed, timeoutMs, fetchImpl, endpoint);
    default:
      return Promise.resolve({
        ok: false,
        reason: `Unknown preset source: ${parsed.source}`,
      });
  }
}

type Platform = "github" | "gitlab";

async function fetchGitHub(
  parsed: ParsedPreset,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  endpoint: string | undefined,
): Promise<FetchResult> {
  if (!parsed.repoPath || !parsed.repoPath.includes("/")) {
    return { ok: false, reason: `Invalid github preset: ${parsed.original}` };
  }
  const file = presetFileName(parsed);
  const ref = parsed.ref ?? "HEAD";
  const apiBase = endpoint ?? DEFAULT_GITHUB_API_BASE;
  const url = `${apiBase}/repos/${parsed.repoPath}/contents/${encodeFilePath(
    file,
  )}?ref=${encodeURIComponent(ref)}`;
  const credential = resolveCredential(["RENOVATE_TOKEN", "GITHUB_TOKEN"]);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "renovate-mcp",
  };
  if (credential.token) headers.Authorization = `Bearer ${credential.token}`;
  return fetchJson(url, headers, timeoutMs, parsed.original, fetchImpl, "github", credential);
}

async function fetchGitLab(
  parsed: ParsedPreset,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  endpoint: string | undefined,
): Promise<FetchResult> {
  if (!parsed.repoPath) {
    return { ok: false, reason: `Invalid gitlab preset: ${parsed.original}` };
  }
  const file = presetFileName(parsed);
  const ref = parsed.ref ?? "HEAD";
  const apiBase = endpoint ?? DEFAULT_GITLAB_API_BASE;
  const url = `${apiBase}/projects/${encodeURIComponent(
    parsed.repoPath,
  )}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`;
  const credential = resolveCredential(["RENOVATE_TOKEN", "GITLAB_TOKEN"]);
  const headers: Record<string, string> = { "User-Agent": "renovate-mcp" };
  if (credential.token) headers["PRIVATE-TOKEN"] = credential.token;
  return fetchJson(url, headers, timeoutMs, parsed.original, fetchImpl, "gitlab", credential);
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

function detectRateLimit(
  res: Response,
  platform: Platform,
  presetName: string,
): string | undefined {
  if (platform === "github" && res.status === 403) {
    if (res.headers.get("x-ratelimit-remaining") !== "0") return undefined;
    const resetIso = parseEpochHeader(res.headers.get("x-ratelimit-reset"));
    const resetClause = resetIso ? ` (resets at ${resetIso})` : "";
    return `GitHub API rate limit exceeded${resetClause} when fetching ${presetName}. Set GITHUB_TOKEN for an authenticated limit, or wait for reset.`;
  }
  if (platform === "gitlab" && res.status === 429) {
    const resetIso = parseEpochHeader(res.headers.get("ratelimit-reset"));
    const resetClause = resetIso ? ` (resets at ${resetIso})` : "";
    return `GitLab API rate limit exceeded${resetClause} when fetching ${presetName}. Set GITLAB_TOKEN for an authenticated limit, or wait for reset.`;
  }
  return undefined;
}

function parseEpochHeader(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  presetName: string,
  fetchImpl: typeof fetch,
  platform: Platform,
  credential: Credential,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const rateLimit = detectRateLimit(res, platform, presetName);
      if (rateLimit) return { ok: false, reason: rateLimit };
      if (res.status === 401 || res.status === 403) {
        const body = await safeReadText(res);
        return {
          ok: false,
          reason: formatAuthFailure(res.status, presetName, url, credential, body),
        };
      }
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

const AUTH_BODY_MAX = 500;

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function formatAuthFailure(
  status: number,
  presetName: string,
  url: string,
  credential: Credential,
  body: string,
): string {
  const lines: string[] = [`HTTP ${status} when fetching ${presetName}`];
  lines.push(`  URL:         ${url}`);
  lines.push(`  Credential:  ${formatCredential(credential)}`);
  const trimmed = body.trim();
  if (trimmed) {
    const snippet =
      trimmed.length > AUTH_BODY_MAX
        ? `${trimmed.slice(0, AUTH_BODY_MAX)}… [truncated]`
        : trimmed;
    lines.push(`  Response:    ${snippet}`);
  }
  return lines.join("\n");
}

function formatCredential(credential: Credential): string {
  if (credential.envVar) return `${credential.envVar} (present)`;
  return `none (tried ${credential.triedVars.join(", ")})`;
}
