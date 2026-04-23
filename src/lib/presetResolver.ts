import { PRESETS } from "../data/presets.generated.js";
import { fetchExternalPreset, type FetchResult } from "./externalPresetFetcher.js";

export interface UnresolvedPreset {
  preset: string;
  reason: string;
}

export interface ResolveResult {
  resolved: Record<string, unknown>;
  presetsResolved: string[];
  presetsUnresolved: UnresolvedPreset[];
}

export interface ResolveOptions {
  /** When true, fetch external presets (github>, gitlab>, …) over the network. */
  fetchExternal?: boolean;
  /** Per-request fetch timeout; forwarded to the external fetcher. */
  timeoutMs?: number;
}

export type ExternalSource =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "local"
  | "npm";

export type SourceClassification =
  | { fetchable: true }
  | { fetchable: false; reason: string };

/**
 * Single source of truth for "can resolve_config ever fetch this external
 * preset?". Used by both the resolver (to short-circuit before branching on the
 * `externalPresets` flag) and the fetcher (to produce the same reason once the
 * flag is on) — so a `local>` preset, say, returns the identical unresolved
 * reason regardless of the flag.
 *
 * - `github`, `gitlab`: fetchable over HTTPS.
 * - `local`: structurally unsupported — requires platform/repo context the
 *   tool does not have.
 * - `bitbucket`, `gitea`, `npm`: not yet implemented.
 */
export function classifyExternalSource(source: string): SourceClassification {
  switch (source) {
    case "github":
    case "gitlab":
      return { fetchable: true };
    case "local":
      return {
        fetchable: false,
        reason:
          "local> presets require platform/repo context that resolve_config does not have; out of scope.",
      };
    case "bitbucket":
    case "gitea":
      return {
        fetchable: false,
        reason: `${source}> presets are not yet supported. Track progress in issue #10.`,
      };
    case "npm":
      return {
        fetchable: false,
        reason:
          "npm-hosted presets are not yet supported. Host the preset on GitHub or GitLab, or track progress in issue #10.",
      };
    default:
      return {
        fetchable: false,
        reason: `Unknown preset source: ${source}`,
      };
  }
}

export interface ParsedPreset {
  /** Canonical identifier used as map key and for cycle detection. */
  key: string;
  /** Original un-normalized string as it appeared in `extends`. */
  original: string;
  args: string[];
  /** For external (non-builtin) presets. */
  source?: ExternalSource;
  /** Git sources: "owner/repo". npm: the package name. */
  repoPath?: string;
  /** Optional `:presetName` fragment. */
  presetName?: string;
  /** Optional `//subpath` fragment. */
  subpath?: string;
  /** Optional `#ref` (branch/tag/commit) fragment. */
  ref?: string;
}

interface ExpandContext {
  fetchExternal: boolean;
  timeoutMs: number | undefined;
  cache: Map<string, Promise<FetchResult>>;
}

/**
 * Resolve a Renovate config by expanding every preset in `extends`. Built-in
 * presets resolve offline against the committed catalogue; external presets
 * (`github>`, `gitlab>`, …) are only fetched when `fetchExternal` is true —
 * otherwise they land in `presetsUnresolved` with a network reason.
 */
export async function resolveConfig(
  config: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const presetsResolved: string[] = [];
  const presetsUnresolved: UnresolvedPreset[] = [];
  const stack: string[] = [];
  const ctx: ExpandContext = {
    fetchExternal: options.fetchExternal ?? false,
    timeoutMs: options.timeoutMs,
    cache: new Map(),
  };

  const resolved = await expand(config, presetsResolved, presetsUnresolved, stack, ctx);
  return { resolved, presetsResolved, presetsUnresolved };
}

async function expand(
  input: Record<string, unknown>,
  resolvedList: string[],
  unresolvedList: UnresolvedPreset[],
  stack: string[],
  ctx: ExpandContext,
): Promise<Record<string, unknown>> {
  const rawExtends = input.extends;
  if (!Array.isArray(rawExtends) || rawExtends.length === 0) {
    const { extends: _drop, ...rest } = input;
    return rest;
  }

  let accumulated: Record<string, unknown> = {};

  for (const entry of rawExtends) {
    if (typeof entry !== "string") {
      unresolvedList.push({
        preset: String(entry),
        reason: "Preset entry must be a string.",
      });
      continue;
    }

    const parsed = parsePreset(entry);

    if (stack.includes(parsed.key)) {
      unresolvedList.push({
        preset: entry,
        reason: `Cycle detected: ${[...stack, parsed.key].join(" → ")}`,
      });
      continue;
    }

    const body = await loadPresetBody(parsed, ctx, unresolvedList);
    if (!body) continue;

    const substituted = applyArgs(body, parsed.args) as Record<string, unknown>;
    stack.push(parsed.key);
    const subResolved = await expand(substituted, resolvedList, unresolvedList, stack, ctx);
    stack.pop();

    accumulated = mergeConfig(accumulated, subResolved);
    resolvedList.push(entry);
  }

  const { extends: _drop, ...ownKeys } = input;
  return mergeConfig(accumulated, ownKeys);
}

async function loadPresetBody(
  parsed: ParsedPreset,
  ctx: ExpandContext,
  unresolvedList: UnresolvedPreset[],
): Promise<Record<string, unknown> | null> {
  if (!parsed.source) {
    const preset = PRESETS[parsed.key];
    if (!preset) {
      unresolvedList.push({
        preset: parsed.original,
        reason: `Unknown built-in preset. Not present in the committed catalogue.`,
      });
      return null;
    }
    return preset.body;
  }

  const classification = classifyExternalSource(parsed.source);
  if (!classification.fetchable) {
    unresolvedList.push({ preset: parsed.original, reason: classification.reason });
    return null;
  }

  if (!ctx.fetchExternal) {
    unresolvedList.push({
      preset: parsed.original,
      reason:
        "External preset (github>, gitlab>). Fetching requires network access and potentially credentials; pass externalPresets: true to enable.",
    });
    return null;
  }

  const result = await fetchExternalPreset(parsed, {
    timeoutMs: ctx.timeoutMs,
    cache: ctx.cache,
  });

  if (!result.ok) {
    unresolvedList.push({ preset: parsed.original, reason: result.reason });
    return null;
  }
  return result.body;
}

const SOURCE_PREFIX_RE = /^([a-z]+)>/i;
const KNOWN_SOURCES = new Set<ExternalSource>([
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "local",
  "npm",
]);

export function parsePreset(raw: string): ParsedPreset {
  const original = raw;
  let rest = raw.trim();

  // Trailing "(arg1, arg2)"
  let args: string[] = [];
  const argMatch = /\(([^)]*)\)\s*$/.exec(rest);
  if (argMatch) {
    args = argMatch[1]!
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    rest = rest.slice(0, argMatch.index).trim();
  }

  const srcMatch = SOURCE_PREFIX_RE.exec(rest);
  if (srcMatch) {
    return parseExternal(rest, original, args, srcMatch[1]!.toLowerCase());
  }

  // Built-in: `:foo` is shorthand for `default:foo`.
  const key = rest.startsWith(":") ? `default${rest}` : rest;

  // An entry with no `>` prefix and no `:` namespace is an npm preset.
  if (!key.includes(":")) {
    return {
      key: `npm>${key}`,
      original,
      args,
      source: "npm",
      repoPath: key,
    };
  }

  return { key, original, args };
}

function parseExternal(
  rest: string,
  original: string,
  args: string[],
  sourceRaw: string,
): ParsedPreset {
  const source = (KNOWN_SOURCES.has(sourceRaw as ExternalSource)
    ? sourceRaw
    : sourceRaw) as ExternalSource;

  let spec = rest.slice(sourceRaw.length + 1);

  let ref: string | undefined;
  const hashIdx = spec.indexOf("#");
  if (hashIdx !== -1) {
    ref = spec.slice(hashIdx + 1);
    spec = spec.slice(0, hashIdx);
  }

  let subpath: string | undefined;
  const slashSlashIdx = spec.indexOf("//");
  if (slashSlashIdx !== -1) {
    subpath = spec.slice(slashSlashIdx + 2);
    spec = spec.slice(0, slashSlashIdx);
  }

  let presetName: string | undefined;
  const colonIdx = spec.indexOf(":");
  if (colonIdx !== -1) {
    presetName = spec.slice(colonIdx + 1);
    spec = spec.slice(0, colonIdx);
  }

  const repoPath = spec;
  let key = `${source}>${repoPath}`;
  if (presetName) key += `:${presetName}`;
  if (subpath) key += `//${subpath}`;
  if (ref) key += `#${ref}`;

  return { key, original, args, source, repoPath, presetName, subpath, ref };
}

function applyArgs(value: unknown, args: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*arg(\d+)\s*\}\}/g, (_, idx) => {
      const i = Number(idx);
      return i < args.length ? args[i]! : "";
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyArgs(v, args));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyArgs(v, args);
    }
    return out;
  }
  return value;
}

/**
 * Merge two Renovate config objects. Rules:
 *   - arrays → concatenate (matches `packageRules`, `matchManagers`, etc.)
 *   - plain objects → recursive merge
 *   - everything else → `b` wins
 * Close enough to Renovate's `mergeChildConfig` for the purpose of showing a
 * user what their config resolves to; not bit-identical.
 */
function mergeConfig(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, bVal] of Object.entries(b)) {
    const aVal = out[key];
    if (Array.isArray(aVal) && Array.isArray(bVal)) {
      out[key] = [...aVal, ...bVal];
    } else if (isPlainObject(aVal) && isPlainObject(bVal)) {
      out[key] = mergeConfig(aVal, bVal);
    } else {
      out[key] = bVal;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
