import type { Credential } from "./credentialResolver.js";
import { HOSTED_PLATFORMS, type HostedPlatform } from "./gitRemote.js";
import { HOST_RULES_MAX_ITEMS } from "./inputLimits.js";

/**
 * Host-scoped credential selection (ADR-0008). Every token is bound to the
 * host it belongs to, so a request to one platform never carries another
 * platform's token. Pure: callers pass `env` (defaults to `process.env`).
 */

type Env = Record<string, string | undefined>;

export const PLATFORM_TOKEN_ENV: Record<HostedPlatform, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  gitea: "GITEA_TOKEN",
  forgejo: "FORGEJO_TOKEN",
  bitbucket: "BITBUCKET_TOKEN",
};

/** Each platform's public host; a bare domain also covers its subdomains (api.github.com). */
export const PUBLIC_HOST: Record<HostedPlatform, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  gitea: "gitea.com",
  forgejo: "code.forgejo.org",
  bitbucket: "bitbucket.org",
};

export const HOST_TOKENS_ENV = "RENOVATE_MCP_HOST_TOKENS";

/** One `RENOVATE_MCP_HOST_TOKENS` entry. `tokenEnv` names another env var; the value never appears here. */
export interface HostTokenEntry {
  matchHost: string;
  hostType: string;
  tokenEnv: string;
}

export type HostTokensParse =
  | { ok: true; entries: HostTokenEntry[] }
  | { ok: false; error: string };

/**
 * A platform/endpoint pair. `homeScope(input, env)` gives the route of
 * `local>` presets (call inputs included); `homeScope({}, env)`, the env
 * scope, is the only place `RENOVATE_TOKEN` applies and the host the home
 * platform's own token binds to when `RENOVATE_ENDPOINT` is set. Tokens never
 * follow call inputs or the repo's origin (ADR-0008).
 */
export interface TokenScope {
  platform?: HostedPlatform;
  endpoint?: string;
}

export type HostTokenRule = {
  hostType: string;
  matchHost: string;
  token: string;
};

const ENTRY_KEYS = ["hostType", "matchHost", "tokenEnv"];
const TOKEN_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_TYPE_RE = /^[a-z0-9-]+$/;
const BARE_HOST_RE = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/** Parse `RENOVATE_MCP_HOST_TOKENS`. Any malformed entry rejects the whole var; errors never echo its value. */
export function parseHostTokens(env: Env = process.env): HostTokensParse {
  const raw = env[HOST_TOKENS_ENV]?.trim();
  if (!raw) return { ok: true, entries: [] };
  const fail = (what: string): HostTokensParse => ({
    ok: false,
    error: `${HOST_TOKENS_ENV}${what.startsWith("[") ? "" : " "}${what}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    return fail("must be a JSON array of {matchHost, hostType, tokenEnv} objects.");
  }
  if (parsed.length > HOST_RULES_MAX_ITEMS) {
    return fail(`has ${parsed.length} entries; the limit is ${HOST_RULES_MAX_ITEMS}.`);
  }
  for (const [i, e] of parsed.entries()) {
    const at = `[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return fail(`${at} must be an object with exactly the keys matchHost, hostType, tokenEnv.`);
    }
    if (Object.keys(e).sort().join() !== ENTRY_KEYS.join()) {
      return fail(`${at} must be an object with exactly the keys matchHost, hostType, tokenEnv.`);
    }
    const { matchHost, hostType, tokenEnv } = e as Record<string, unknown>;
    if (typeof tokenEnv !== "string" || !TOKEN_ENV_RE.test(tokenEnv)) {
      return fail(`${at}.tokenEnv must be an environment variable name (letters, digits, underscore).`);
    }
    if (typeof hostType !== "string" || !HOST_TYPE_RE.test(hostType)) {
      return fail(`${at}.hostType must be a lowercase Renovate hostType such as gitlab or npm.`);
    }
    if (typeof matchHost !== "string" || !isValidMatchHost(matchHost)) {
      return fail(
        `${at}.matchHost must be a bare lowercase host (gitlab.example.com) or an https:// URL prefix without credentials.`,
      );
    }
  }
  return { ok: true, entries: parsed as HostTokenEntry[] };
}

function isValidMatchHost(matchHost: string): boolean {
  if (BARE_HOST_RE.test(matchHost)) return true;
  const url = parseUrl(matchHost);
  return url !== null && url.protocol === "https:" && !url.username && !url.password;
}

/** Renovate's `matchesHost`: URL-form `matchHost` is a prefix match, a bare host matches itself and its subdomains. */
export function matchesHost(matchHost: string, url: string): boolean {
  const parsedUrl = parseUrl(url);
  if (!parsedUrl) return false;
  const parsedMatch = parseUrl(matchHost);
  if (isHttp(parsedUrl) && parsedMatch && isHttp(parsedMatch)) {
    const { href } = parsedMatch;
    const bare = new URL(parsedUrl.href);
    bare.username = "";
    bare.password = "";
    if (bare.href.startsWith(href)) return true;
    return `${parsedUrl.origin}${parsedUrl.pathname}`.replace(/\/?$/, "/") === href;
  }
  return domainMatches(parsedUrl.hostname, matchHost);
}

/**
 * Resolve the `local>` route (ADR-0008): platform = the tool's `platform`
 * input, else `RENOVATE_PLATFORM`; endpoint = the `endpoint` input, else
 * `RENOVATE_ENDPOINT`, but the env endpoint only when there is no platform
 * input or it equals `RENOVATE_PLATFORM` (an env endpoint belongs to the env
 * platform). Unlike Renovate, a missing platform does not default to github:
 * without a hosted platform there is no scope and `local>` has no route.
 * Routing only: token binding reads the env scope, `homeScope({}, env)`.
 */
export function homeScope(input: { platform?: string; endpoint?: string }, env: Env = process.env): TokenScope {
  const platform = input.platform || env.RENOVATE_PLATFORM;
  if (!(HOSTED_PLATFORMS as readonly string[]).includes(platform as string)) return {};
  const envEndpointApplies = !input.platform || input.platform === env.RENOVATE_PLATFORM;
  const endpoint = input.endpoint || (envEndpointApplies ? env.RENOVATE_ENDPOINT : undefined);
  return endpoint ? { platform: platform as HostedPlatform, endpoint } : { platform: platform as HostedPlatform };
}

/** A rule of the emitted list; `vars` are tried in order and the first set one is its token. */
interface CandidateRule {
  hostType: string;
  matchHost: string;
  vars: string[];
  /** From `RENOVATE_MCP_HOST_TOKENS`, so an unset variable is worth a warning. */
  entry?: true;
}

/** Renovate turns `GITHUB_COM_TOKEN` into this rule itself, after the file config's rules. */
const GITHUB_COM_RULE: CandidateRule = { hostType: "github", matchHost: "github.com", vars: ["GITHUB_COM_TOKEN"] };

/**
 * The rule list in the order `buildHostTokenRules` writes it: one rule per
 * hosted platform on its bound bare host, then the host-token entries. The
 * env home platform's rule carries `RENOVATE_TOKEN` first, as Renovate's own
 * platform rule does (it deletes `GITLAB_TOKEN` and friends from its env), and
 * its own token as the fallback. Only env vars shape the list: a call input or
 * the repo's origin can never bind a token to another host (ADR-0008).
 */
function candidateRules(env: Env, entries: HostTokenEntry[]): CandidateRule[] {
  const home = homeScope({}, env);
  const rules: CandidateRule[] = [];
  for (const platform of HOSTED_PLATFORMS) {
    const matchHost = boundHost(platform, home);
    if (!matchHost) continue;
    const vars = platform === home.platform ? ["RENOVATE_TOKEN", PLATFORM_TOKEN_ENV[platform]] : [PLATFORM_TOKEN_ENV[platform]];
    rules.push({ hostType: platform, matchHost, vars });
  }
  for (const { matchHost, hostType, tokenEnv } of entries) rules.push({ hostType, matchHost, vars: [tokenEnv], entry: true });
  return rules;
}

/**
 * Pick the token for a request to `url` of `hostType` the way Renovate's
 * `hostRules.find()` does over the exact rule list `buildHostTokenRules`
 * emits, followed by the `GITHUB_COM_TOKEN` rule Renovate appends from env.
 * Every rule here has a hostType and a matchHost, so Renovate's rank ties and
 * the longer raw `matchHost` wins, then the later rule. A rule whose variables
 * are all unset does not exist for Renovate and is skipped. `triedVars` lists
 * the variables of every matching rule, most specific first.
 * `githubComToken: false` leaves the `GITHUB_COM_TOKEN` rule out.
 * A malformed `RENOVATE_MCP_HOST_TOKENS` contributes no entries; callers refuse it first.
 */
export function selectToken(
  url: string,
  hostType: HostedPlatform,
  env: Env = process.env,
  options: { githubComToken?: boolean } = {},
): Credential {
  const parsed = parseHostTokens(env);
  const rules = candidateRules(env, parsed.ok ? parsed.entries : []);
  if (options.githubComToken !== false) rules.push(GITHUB_COM_RULE);
  const ranked = rules
    .filter((r) => r.hostType === hostType && matchesHost(r.matchHost, url))
    // Renovate sorts ascending (stable) and the last match wins; reversed,
    // that is longest first and, on a tie, the later rule first.
    .sort((a, b) => a.matchHost.length - b.matchHost.length)
    .reverse();
  const triedVars = [...new Set(ranked.flatMap((r) => r.vars))];
  for (const rule of ranked) {
    const envVar = rule.vars.find((v) => env[v]);
    if (envVar) return { envVar, token: env[envVar], triedVars };
  }
  return { envVar: null, token: undefined, triedVars };
}

/**
 * Host rules for a spawned Renovate, in find() order: each per-platform token
 * on its bound bare host (`RENOVATE_TOKEN` first on the env home platform's
 * host, its own token when that is unset), then every host-token entry, so entries win
 * an equal-length tie. `GITHUB_COM_TOKEN` is left to Renovate, which reads it
 * from env. Rules a `covered` entry (per-call hostRules, the platform rule)
 * must win over are left out. Renovate's `find()` ranks hostType + matchHost
 * over matchHost alone over hostType alone, then the longer matchHost, then
 * the later rule, so an env rule goes when the entry has no other hostType and
 * the env rule sits on the entry's host or below it (a tie the env rule would
 * win or lose to the later entry anyway), or when the entry has no hostType
 * and sits below the env rule's host (the env rule outranks it). An entry
 * without a matchHost covers every host of its hostType. Entries whose
 * variable is unset are skipped with a warning; a malformed var yields `error`
 * and no rules.
 */
export function buildHostTokenRules(
  env: Env = process.env,
  covered: Array<{ hostType?: string; matchHost?: string }> = [],
): { rules: HostTokenRule[]; secrets: string[]; warnings: string[]; error?: string } {
  const parsed = parseHostTokens(env);
  if (!parsed.ok) return { rules: [], secrets: [], warnings: [], error: parsed.error };

  const rules: HostTokenRule[] = [];
  const warnings: string[] = [];
  /** `host` (bare or URL form) is `matchHost` or falls under it. */
  const under = (host: string, matchHost: string) =>
    host === matchHost || matchesHost(matchHost, parseUrl(host) ? host : `https://${host}`);
  const isCovered = (r: CandidateRule) =>
    covered.some((c) => {
      if (c.hostType !== undefined && c.hostType !== r.hostType) return false;
      if (c.matchHost === undefined) return true;
      if (under(r.matchHost, c.matchHost)) return true;
      return c.hostType === undefined && under(c.matchHost, r.matchHost);
    });
  for (const rule of candidateRules(env, parsed.entries)) {
    const envVar = rule.vars.find((v) => env[v]);
    if (envVar && !isCovered(rule)) rules.push({ hostType: rule.hostType, matchHost: rule.matchHost, token: env[envVar]! });
    else if (!envVar && rule.entry) {
      warnings.push(`${HOST_TOKENS_ENV} entry for ${rule.matchHost} (${rule.hostType}) names ${rule.vars[0]}, which is not set; skipped.`);
    }
  }
  return { rules, secrets: [...new Set(rules.map((r) => r.token))], warnings };
}

/** The bare host the env token rule for `platform` is bound to; undefined for an unparseable `RENOVATE_ENDPOINT`. */
export function tokenHost(platform: HostedPlatform, env: Env = process.env): string | undefined {
  return boundHost(platform, homeScope({}, env));
}

function boundHost(platform: HostedPlatform, scope: TokenScope): string | undefined {
  if (scope.platform === platform && scope.endpoint) return parseUrl(scope.endpoint)?.hostname || undefined;
  return PUBLIC_HOST[platform];
}

function domainMatches(host: string, domain: string): boolean {
  if (!host) return false;
  if (host === domain) return true;
  return host.endsWith(domain.startsWith(".") ? domain : `.${domain}`);
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}
