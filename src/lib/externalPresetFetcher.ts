import { resolveCredential, type Credential } from "./credentialResolver.js";
import { validateEndpoint } from "./endpointValidator.js";
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
    const blocked = validateEndpoint(options.endpoint);
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    endpoint = trimTrailingSlash(options.endpoint);
  }

  // `fetchable` is only ever true for github / gitlab.
  return parsed.source === "github"
    ? fetchGitHub(parsed, timeoutMs, fetchImpl, endpoint)
    : fetchGitLab(parsed, timeoutMs, fetchImpl, endpoint);
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
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (isRedirectResponse(res) || !res.ok) {
      const reason = await failureReason(res, url, presetName, platform, credential);
      await discardBody(res);
      return { ok: false, reason };
    }
    const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_PRESET_BYTES) {
      await discardBody(res);
      return {
        ok: false,
        reason: `Preset body for ${presetName} exceeds ${MAX_PRESET_BYTES} bytes (declared ${declared}).`,
      };
    }
    const { text, overflow } = await readBody(res, MAX_PRESET_BYTES);
    if (overflow) {
      return {
        ok: false,
        reason: `Preset body for ${presetName} exceeds ${MAX_PRESET_BYTES} bytes.`,
      };
    }
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
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return {
        ok: false,
        reason: `Timed out after ${timeoutMs}ms fetching ${presetName}`,
      };
    }
    return {
      ok: false,
      reason: `Network error fetching ${presetName}: ${err.message}`,
    };
  }
}

/** Reason for a redirect or non-2xx response; only 401/403 read (a capped slice of) the body. */
async function failureReason(
  res: Response,
  url: string,
  presetName: string,
  platform: Platform,
  credential: Credential,
): Promise<string> {
  if (isRedirectResponse(res)) return formatRedirectRefusal(presetName, url, res);
  const rateLimit = detectRateLimit(res, platform, presetName);
  if (rateLimit) return rateLimit;
  if (res.status === 401 || res.status === 403) {
    const { text } = await readBody(res, MAX_AUTH_BODY_BYTES).catch(() => ({ text: "" }));
    return formatAuthFailure(res.status, presetName, url, credential, text);
  }
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} when fetching ${presetName}`;
}

const AUTH_BODY_MAX = 500;

/**
 * Read at most `max` bytes of the body. On overflow the reader is cancelled
 * and `text` holds the truncated prefix — the preset path treats `overflow`
 * as a failure, the auth-snippet path keeps the prefix.
 */
async function readBody(res: Response, max: number): Promise<{ text: string; overflow: boolean }> {
  if (!res.body) return { text: "", overflow: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      const chunk = r.value.subarray(0, max - total);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < r.value.byteLength) {
        overflow = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks, total)), overflow };
}

/** Release a body we will not read so undici can close or reuse the connection. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already consumed, locked, or a bodiless test double
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
