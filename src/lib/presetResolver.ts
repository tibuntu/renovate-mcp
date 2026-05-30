import { PRESETS } from "../data/presets.generated.js";
import { fetchExternalPreset, type FetchResult } from "./externalPresetFetcher.js";
import { runMerge } from "./mergeWorker.js";

export interface UnresolvedPreset {
  preset: string;
  reason: string;
}

export interface PresetWarning {
  preset: string;
  message: string;
}

/**
 * `"faithful"` when the resolved config came from Renovate's real
 * `mergeChildConfig` (the worker path); `"preview"` when the worker was
 * unavailable and we fell back to the in-process approximate merge.
 */
export type MergeQuality = "faithful" | "preview";

export interface ResolveResult {
  resolved: Record<string, unknown>;
  presetsResolved: string[];
  presetsUnresolved: UnresolvedPreset[];
  warnings: PresetWarning[];
  mergeQuality: MergeQuality;
}

/**
 * Sentinel used as the `label`/`source` of contributions that come from the
 * user's own input config (the keys that are siblings of `extends`, not from
 * any preset). Angle brackets cannot appear in a real preset reference, so this
 * never collides with one. Re-exported from `configExplainer.ts` for callers
 * that historically imported it from there.
 */
export const OWN_SOURCE = "<own>";

export interface MergeStep {
  /** Preset entry exactly as written in `extends`, or OWN_SOURCE for own keys. */
  label: string;
  /** Parent preset chain that brought this config in, outermost first. */
  via: string[];
  /** Extends-stripped, args-substituted body contributed by `label`. */
  config: Record<string, unknown>;
}

export interface CollectResult {
  steps: MergeStep[];
  presetsResolved: string[];
  presetsUnresolved: UnresolvedPreset[];
  warnings: PresetWarning[];
}

export type FetchPlatform = "github" | "gitlab";

export interface ResolveOptions {
  /** When true, fetch external presets (github>, gitlab>, …) over the network. */
  fetchExternal?: boolean;
  /** Per-request fetch timeout; forwarded to the external fetcher. */
  timeoutMs?: number;
  /**
   * Override the API base URL used for `github>` / `gitlab>` fetches — e.g.
   * `https://ghe.example.com/api/v3` for GitHub Enterprise or
   * `https://gitlab.example.com/api/v4` for self-hosted GitLab. When unset,
   * defaults to `https://api.github.com` and `https://gitlab.com/api/v4`.
   */
  endpoint?: string;
  /**
   * Platform flavour of `endpoint`. Required only when it's not derivable from
   * the preset source (e.g. to resolve `local>` presets against a self-hosted
   * GitHub/GitLab). When set, `local>owner/repo` is fetched as if it were
   * `<platform>>owner/repo`.
   */
  platform?: FetchPlatform;
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
 * - `bitbucket`, `gitea`, `npm`: unsupported by resolve_config — the reason
 *   points users at `dry_run` (the Renovate CLI resolves these) rather than at
 *   a tracking issue.
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
          "local> presets need a platform context. Pass `platform` (`github` or `gitlab`) plus `endpoint` to resolve_config so they're routed through your platform's API. For full-fidelity merging (hostRules, regexManagers, etc.), run `dry_run` with the same params instead.",
      };
    case "bitbucket":
    case "gitea":
      return {
        fetchable: false,
        reason: `${source}> presets are not supported by resolve_config. Run dry_run (with platform + endpoint) for full external-preset resolution via the Renovate CLI, or host the preset on GitHub or GitLab.`,
      };
    case "npm":
      return {
        fetchable: false,
        reason:
          "npm-hosted presets are not supported by resolve_config. Run dry_run for full-fidelity resolution via the Renovate CLI, or host the preset on GitHub or GitLab.",
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
  /**
   * Set when parsing already determined the preset cannot be resolved — e.g.
   * an unknown source prefix like `xyz>foo/bar`. `loadPresetBody` short-circuits
   * to the unresolved list with this reason.
   */
  unresolvableReason?: string;
}

export interface ExpandContext {
  fetchExternal: boolean;
  timeoutMs: number | undefined;
  endpoint: string | undefined;
  platform: FetchPlatform | undefined;
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
  const { steps, presetsResolved, presetsUnresolved, warnings } =
    await collectMergeSteps(config, options);
  const configs = steps.map((s) => s.config);

  try {
    const { merged } = await runMerge(configs);
    return {
      resolved: merged,
      presetsResolved,
      presetsUnresolved,
      warnings,
      mergeQuality: "faithful",
    };
  } catch (err) {
    // Graceful degradation: the faithful merge worker is unavailable (e.g.
    // renovate not installed, or a pathological cold-load timeout). Fall back
    // to the in-process approximate merge so a previously-offline-instant tool
    // never hard-fails — and signal the reduced fidelity via mergeQuality.
    const resolved = configs.reduce<Record<string, unknown>>(
      (acc, c) => mergeConfig(acc, c),
      {},
    );
    warnings.push({
      preset: "<merge>",
      message: `Faithful merge worker unavailable (${
        err instanceof Error ? err.message : String(err)
      }); fell back to approximate merge. Run dry_run for authoritative output.`,
    });
    return {
      resolved,
      presetsResolved,
      presetsUnresolved,
      warnings,
      mergeQuality: "preview",
    };
  }
}

/**
 * Flatten a config's preset tree into the ordered sequence of leaf configs that
 * resolve_config / explain_config fold. DFS order, own-keys-last-per-node, so a
 * left-fold of `steps.map(s => s.config)` reproduces the nested merge — every
 * key type in Renovate's `mergeChildConfig` is left-associative, so flattening
 * is equivalent to the nested fold. Shared by both tools so they can never drift
 * on *which* configs merge in *what* order. This collects only; it does not
 * merge (the worker-isolated faithful merge runs separately, see `mergeWorker`).
 */
export async function collectMergeSteps(
  config: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<CollectResult> {
  const presetsResolved: string[] = [];
  const presetsUnresolved: UnresolvedPreset[] = [];
  const warnings: PresetWarning[] = [];
  const steps: MergeStep[] = [];
  const stack: string[] = [];
  const ctx: ExpandContext = {
    fetchExternal: options.fetchExternal ?? false,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint,
    platform: options.platform,
    cache: new Map(),
  };

  await collectSteps(
    config,
    null,
    [],
    steps,
    presetsResolved,
    presetsUnresolved,
    warnings,
    stack,
    ctx,
  );
  return { steps, presetsResolved, presetsUnresolved, warnings };
}

async function collectSteps(
  input: Record<string, unknown>,
  ownerName: string | null,
  viaChain: string[],
  steps: MergeStep[],
  resolvedList: string[],
  unresolvedList: UnresolvedPreset[],
  warningsList: PresetWarning[],
  stack: string[],
  ctx: ExpandContext,
): Promise<void> {
  const rawExtends = input.extends;
  if (Array.isArray(rawExtends) && rawExtends.length > 0) {
    // Children of `input` are reached by going through `ownerName` (if any).
    // The user's root has no name; for it `viaChain` and `childVia` are equal.
    const childVia = ownerName === null ? viaChain : [...viaChain, ownerName];

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

      const { value, missingArgs, unknownTemplates } = applyArgs(
        body,
        parsed.args,
      );
      recordTemplateWarnings(
        entry,
        parsed.args.length,
        missingArgs,
        unknownTemplates,
        warningsList,
      );
      stack.push(parsed.key);
      await collectSteps(
        value as Record<string, unknown>,
        entry,
        childVia,
        steps,
        resolvedList,
        unresolvedList,
        warningsList,
        stack,
        ctx,
      );
      stack.pop();
      resolvedList.push(entry);
    }
  }

  // Own keys (siblings of `extends`) merge last for this node. Skip empty
  // own-key sets so a single-preset config stays a single step (no worker).
  const { extends: _drop, ...ownKeys } = input;
  if (Object.keys(ownKeys).length > 0) {
    steps.push({
      label: ownerName ?? OWN_SOURCE,
      via: [...viaChain],
      config: ownKeys,
    });
  }
}

export function recordTemplateWarnings(
  entry: string,
  suppliedArgs: number,
  missingArgs: Set<number>,
  unknownTemplates: Set<string>,
  warningsList: PresetWarning[],
): void {
  for (const idx of [...missingArgs].sort((a, b) => a - b)) {
    warningsList.push({
      preset: entry,
      message:
        `Preset references {{arg${idx}}} but only ${suppliedArgs} argument(s) were supplied; ` +
        `the placeholder was substituted with an empty string. Pass more arguments, ` +
        `e.g. "${entry.replace(/\([^)]*\)\s*$/, "")}(arg0, arg1, ...)".`,
    });
  }
  for (const token of [...unknownTemplates].sort()) {
    warningsList.push({
      preset: entry,
      message:
        `Preset uses template "{{${token}}}" which resolve_config does not expand ` +
        `(only positional {{argN}} is supported). The token was left verbatim; ` +
        `run dry_run for full-fidelity expansion via the Renovate CLI.`,
    });
  }
}

export async function loadPresetBody(
  parsed: ParsedPreset,
  ctx: ExpandContext,
  unresolvedList: UnresolvedPreset[],
): Promise<Record<string, unknown> | null> {
  if (parsed.unresolvableReason) {
    unresolvedList.push({ preset: parsed.original, reason: parsed.unresolvableReason });
    return null;
  }

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

  // If a `platform` is configured, route `local>` presets through it — the
  // self-hosted case where the user's "local" presets actually live on their
  // private GitHub/GitLab at `endpoint`.
  const effective =
    parsed.source === "local" && ctx.platform
      ? { ...parsed, source: ctx.platform }
      : parsed;

  const classification = classifyExternalSource(effective.source!);
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

  const result = await fetchExternalPreset(effective, {
    timeoutMs: ctx.timeoutMs,
    endpoint: ctx.endpoint,
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
  if (!KNOWN_SOURCES.has(sourceRaw as ExternalSource)) {
    return {
      key: original,
      original,
      args,
      unresolvableReason: `Unknown preset source: ${sourceRaw}`,
    };
  }
  const source = sourceRaw as ExternalSource;

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

export interface ApplyArgsResult {
  value: unknown;
  /** Indices referenced by `{{argN}}` where N ≥ args.length. */
  missingArgs: Set<number>;
  /** Non-argN tokens (e.g. `{{packageRules}}`, block helpers) left verbatim. */
  unknownTemplates: Set<string>;
}

export function applyArgs(value: unknown, args: string[]): ApplyArgsResult {
  const missingArgs = new Set<number>();
  const unknownTemplates = new Set<string>();
  const out = applyArgsInner(value, args, missingArgs, unknownTemplates);
  return { value: out, missingArgs, unknownTemplates };
}

const TEMPLATE_TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ARG_TOKEN_RE = /^arg(\d+)$/;

function applyArgsInner(
  value: unknown,
  args: string[],
  missingArgs: Set<number>,
  unknownTemplates: Set<string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_TOKEN_RE, (match, inner: string) => {
      const argMatch = ARG_TOKEN_RE.exec(inner);
      if (argMatch) {
        const i = Number(argMatch[1]);
        if (i < args.length) return args[i]!;
        missingArgs.add(i);
        return "";
      }
      unknownTemplates.add(inner);
      return match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyArgsInner(v, args, missingArgs, unknownTemplates));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyArgsInner(v, args, missingArgs, unknownTemplates);
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
