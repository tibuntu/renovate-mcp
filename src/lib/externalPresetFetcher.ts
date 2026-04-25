import { resolveCredential, type Credential } from "./credentialResolver.js";
import { EndpointValidationError, validateEndpoint } from "./endpointValidator.js";
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
const MAX_PRESET_BYTES = 1_000_000;
const MAX_AUTH_BODY_BYTES = 8_192;

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
  let endpoint: string | undefined;
  if (options.endpoint) {
    try {
      validateEndpoint(options.endpoint);
    } catch (err) {
      if (err instanceof EndpointValidationError) {
        return Promise.resolve({ ok: false, reason: err.message });
      }
      throw err;
    }
    endpoint = trimTrailingSlash(options.endpoint);
  }

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
  const sendAuth = Boolean(credential.token) && isHttpsUrl(url);
  if (sendAuth) headers.Authorization = `Bearer ${credential.token}`;
  return fetchJson(
    url,
    headers,
    timeoutMs,
    parsed.original,
    fetchImpl,
    "github",
    sendAuth ? credential : suppressCredential(credential),
  );
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
  const sendAuth = Boolean(credential.token) && isHttpsUrl(url);
  if (sendAuth) headers["PRIVATE-TOKEN"] = credential.token!;
  return fetchJson(
    url,
    headers,
    timeoutMs,
    parsed.original,
    fetchImpl,
    "gitlab",
    sendAuth ? credential : suppressCredential(credential),
  );
}

function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}

function suppressCredential(credential: Credential): Credential {
  return { envVar: null, token: undefined, triedVars: credential.triedVars };
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
    const res = await fetchImpl(url, {
      headers,
      signal: controller.signal,
      redirect: "manual",
    });
    if (isRedirectResponse(res)) {
      return { ok: false, reason: formatRedirectRefusal(presetName, url, res) };
    }
    if (!res.ok) {
      const rateLimit = detectRateLimit(res, platform, presetName);
      if (rateLimit) return { ok: false, reason: rateLimit };
      if (res.status === 401 || res.status === 403) {
        const body = await safeReadText(res, MAX_AUTH_BODY_BYTES);
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
    const oversize = checkDeclaredLength(res, presetName);
    if (oversize) return oversize;
    const bounded = await readBoundedText(res, MAX_PRESET_BYTES);
    if (!bounded.ok) {
      return {
        ok: false,
        reason: `Preset body for ${presetName} exceeds ${MAX_PRESET_BYTES} bytes.`,
      };
    }
    const text = bounded.text;
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

async function safeReadText(res: Response, maxBytes: number): Promise<string> {
  try {
    return await readCappedText(res, maxBytes);
  } catch {
    return "";
  }
}

function checkDeclaredLength(res: Response, presetName: string): FetchResult | undefined {
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_PRESET_BYTES) {
    return {
      ok: false,
      reason: `Preset body for ${presetName} exceeds ${MAX_PRESET_BYTES} bytes (declared ${declared}).`,
    };
  }
  return undefined;
}

type BoundedRead = { ok: true; text: string } | { ok: false };

async function readBoundedText(res: Response, maxBytes: number): Promise<BoundedRead> {
  const collected = await collectBytes(res, maxBytes, "reject");
  if (collected.overflow) return { ok: false };
  return { ok: true, text: new TextDecoder("utf-8").decode(collected.bytes) };
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const collected = await collectBytes(res, maxBytes, "truncate");
  return new TextDecoder("utf-8").decode(collected.bytes);
}

async function collectBytes(
  res: Response,
  maxBytes: number,
  onOverflow: "reject" | "truncate",
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  if (!res.body) {
    const text = await res.text();
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > maxBytes) {
      return onOverflow === "reject"
        ? { bytes: new Uint8Array(0), overflow: true }
        : { bytes: encoded.slice(0, maxBytes), overflow: true };
    }
    return { bytes: encoded, overflow: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        await reader.cancel().catch(() => undefined);
        if (onOverflow === "reject") {
          return { bytes: new Uint8Array(0), overflow: true };
        }
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          total += remaining;
        }
        return { bytes: concat(chunks, total), overflow: true };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  return { bytes: concat(chunks, total), overflow: false };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectResponse(res: Response): boolean {
  return res.type === "opaqueredirect" || REDIRECT_STATUSES.has(res.status);
}

function formatRedirectRefusal(presetName: string, url: string, res: Response): string {
  const status = res.status > 0 ? String(res.status) : "redirect";
  const lines = [
    `Redirect refused while fetching ${presetName}`,
    `  URL:      ${url}`,
    `  Status:   ${status}`,
    `  Reason:   Following redirects is disabled to prevent leaking auth tokens to a different host. If your endpoint legitimately redirects, fetch the final URL directly.`,
  ];
  return lines.join("\n");
}
