import { PRESETS } from "../data/presets.generated.js";

export interface UnresolvedPreset {
  preset: string;
  reason: string;
}

export interface ResolveResult {
  resolved: Record<string, unknown>;
  presetsResolved: string[];
  presetsUnresolved: UnresolvedPreset[];
}

interface ParsedPreset {
  /** Normalized catalogue key, e.g. ":pinAll" → "default:pinAll" */
  key: string;
  /** Original (un-normalized) string as it appeared in `extends` */
  original: string;
  args: string[];
}

const EXTERNAL_SOURCE_RE = /^[a-z]+>/i;

/**
 * Resolve a Renovate config by expanding every built-in preset in `extends`
 * against the committed catalogue. Never touches the network and never shells
 * out — external presets (github>, gitlab>, local>, npm) are flagged in
 * `presetsUnresolved` instead.
 */
export function resolveConfig(config: Record<string, unknown>): ResolveResult {
  const presetsResolved: string[] = [];
  const presetsUnresolved: UnresolvedPreset[] = [];
  const stack: string[] = [];

  const resolved = expand(config, presetsResolved, presetsUnresolved, stack);
  return { resolved, presetsResolved, presetsUnresolved };
}

function expand(
  input: Record<string, unknown>,
  resolvedList: string[],
  unresolvedList: UnresolvedPreset[],
  stack: string[],
): Record<string, unknown> {
  const rawExtends = input.extends;
  if (!Array.isArray(rawExtends) || rawExtends.length === 0) {
    const { extends: _drop, ...rest } = input;
    return rest;
  }

  // Accumulator for everything the extends chain contributes.
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

    if (isExternal(parsed.key)) {
      unresolvedList.push({
        preset: entry,
        reason:
          "External preset (github>, gitlab>, bitbucket>, gitea>, local>, or npm). Fetching requires network access and potentially credentials, which this tool does not perform.",
      });
      continue;
    }

    if (stack.includes(parsed.key)) {
      unresolvedList.push({
        preset: entry,
        reason: `Cycle detected: ${[...stack, parsed.key].join(" → ")}`,
      });
      continue;
    }

    const preset = PRESETS[parsed.key];
    if (!preset) {
      unresolvedList.push({
        preset: entry,
        reason: `Unknown built-in preset. Not present in the committed catalogue.`,
      });
      continue;
    }

    const substituted = applyArgs(preset.body, parsed.args) as Record<string, unknown>;
    stack.push(parsed.key);
    const subResolved = expand(substituted, resolvedList, unresolvedList, stack);
    stack.pop();

    accumulated = mergeConfig(accumulated, subResolved);
    resolvedList.push(entry);
  }

  // Merge the caller's own keys (everything except `extends`) on top of the
  // expanded chain. This matches Renovate's precedence: outer config wins.
  const { extends: _drop, ...ownKeys } = input;
  return mergeConfig(accumulated, ownKeys);
}

function parsePreset(raw: string): ParsedPreset {
  const original = raw;
  const match = /^([^()]+?)(?:\(([^)]*)\))?$/.exec(raw.trim());
  const name = (match?.[1] ?? raw).trim();
  const argsRaw = match?.[2];
  const args = argsRaw == null
    ? []
    : argsRaw.split(",").map((a) => a.trim()).filter((a) => a.length > 0);

  // `:foo` is Renovate shorthand for `default:foo`.
  const key = name.startsWith(":") ? `default${name}` : name;
  return { key, original, args };
}

function isExternal(key: string): boolean {
  if (EXTERNAL_SOURCE_RE.test(key)) return true;
  // Built-in keys always contain a namespace colon (e.g. "config:recommended").
  // Anything without one points at an npm preset package.
  return !key.includes(":");
}

/** Deep-substitute `{{argN}}` placeholders inside any string values. */
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
