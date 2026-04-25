import {
  applyArgs,
  loadPresetBody,
  parsePreset,
  recordTemplateWarnings,
  type ExpandContext,
  type PresetWarning,
  type ResolveOptions,
  type UnresolvedPreset,
} from "./presetResolver.js";

/**
 * Sentinel used as the `source` of contributions that come from the user's own
 * input config (i.e. the keys siblings of `extends`, not from any preset).
 * Distinguishable from any real preset name because angle brackets cannot
 * appear in a Renovate preset reference.
 */
export const OWN_SOURCE = "<own>";

export interface Contribution {
  /**
   * Where the value came from. `<own>` for the user's input config; otherwise
   * the preset reference exactly as it appeared in `extends` (e.g.
   * `config:recommended`, `:automergeAll`, `github>acme/renovate-config`).
   */
  source: string;
  /**
   * Path of presets that brought this contribution in, outermost first. Empty
   * when the value comes from `<own>` or from a top-level entry in the user's
   * `extends`. For nested presets, lists every parent preset between the
   * user's root and `source`.
   */
  via: string[];
  /**
   * The exact value `source` contributed at the point of the merge — for
   * scalars this is the value `source` set, before any later preset/own
   * override; for arrays this is just the slice `source` added.
   */
  value: unknown;
}

export type AnnotatedNode = AnnotatedLeaf | AnnotatedObject;

export interface AnnotatedLeaf {
  /**
   * Final merged value of this field. Last `setBy` entry is the winner for
   * scalars; for arrays, every contribution's `value` is concatenated into
   * `value`.
   */
  value: unknown;
  /**
   * Contributions in merge order. The last entry is the winner for scalars;
   * for arrays each entry adds its own slice to `value`.
   */
  setBy: Contribution[];
}

export type AnnotatedObject = { [key: string]: AnnotatedNode };

export interface ExplainResult {
  explanation: AnnotatedObject;
  presetsResolved: string[];
  presetsUnresolved: UnresolvedPreset[];
  warnings: PresetWarning[];
}

/**
 * Inverse of `resolveConfig`: walk the same preset tree but, instead of
 * collapsing everything into a flat resolved object, annotate each leaf field
 * with the chain of presets that touched it. The last entry in `setBy` is the
 * winner; `value` is what `resolveConfig` would have returned.
 *
 * Sharing as much as possible with `presetResolver`'s expansion logic
 * (`parsePreset`, `loadPresetBody`, `applyArgs`, `recordTemplateWarnings`) so
 * the two tools stay consistent — if `resolve_config` resolves a preset,
 * `explain_config` does too, by definition.
 */
export async function explainConfig(
  config: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<ExplainResult> {
  const presetsResolved: string[] = [];
  const presetsUnresolved: UnresolvedPreset[] = [];
  const warnings: PresetWarning[] = [];
  const stack: string[] = [];
  const ctx: ExpandContext = {
    fetchExternal: options.fetchExternal ?? false,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint,
    platform: options.platform,
    cache: new Map(),
  };

  const annotated = await expandAnnotated(
    config,
    null,
    [],
    presetsResolved,
    presetsUnresolved,
    warnings,
    stack,
    ctx,
  );
  // The user's input is always a JSON object, so the root annotation is always
  // an object, not a leaf. The cast is safe; falling back to `{}` is just
  // defence in depth.
  const explanation = isAnnotatedLeaf(annotated) ? {} : (annotated as AnnotatedObject);
  return { explanation, presetsResolved, presetsUnresolved, warnings };
}

async function expandAnnotated(
  input: Record<string, unknown>,
  ownerName: string | null,
  viaChain: string[],
  resolvedList: string[],
  unresolvedList: UnresolvedPreset[],
  warningsList: PresetWarning[],
  stack: string[],
  ctx: ExpandContext,
): Promise<AnnotatedNode> {
  let accumulated: AnnotatedObject = {};

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

      const { value, missingArgs, unknownTemplates } = applyArgs(body, parsed.args);
      recordTemplateWarnings(
        entry,
        parsed.args.length,
        missingArgs,
        unknownTemplates,
        warningsList,
      );
      stack.push(parsed.key);
      const subNode = await expandAnnotated(
        value as Record<string, unknown>,
        entry,
        childVia,
        resolvedList,
        unresolvedList,
        warningsList,
        stack,
        ctx,
      );
      stack.pop();

      accumulated = mergeAnnotated(accumulated, subNode) as AnnotatedObject;
      resolvedList.push(entry);
    }
  }

  const { extends: _drop, ...ownKeys } = input;
  const source = ownerName ?? OWN_SOURCE;
  const ownAnnotated = annotateValue(ownKeys, source, viaChain);
  return mergeAnnotated(accumulated, ownAnnotated);
}

function annotateValue(
  value: unknown,
  source: string,
  via: string[],
): AnnotatedNode {
  if (isPlainObject(value)) {
    const out: AnnotatedObject = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = annotateValue(v, source, via);
    }
    return out;
  }
  return { value, setBy: [{ source, via: [...via], value }] };
}

/**
 * Mirrors `mergeConfig` in `presetResolver.ts`: arrays concat, plain objects
 * recurse, everything else `b` wins. The annotated layer additionally keeps
 * each contribution in `setBy` so callers can see the full chain that produced
 * the final value.
 */
function mergeAnnotated(a: AnnotatedNode, b: AnnotatedNode): AnnotatedNode {
  const aIsLeaf = isAnnotatedLeaf(a);
  const bIsLeaf = isAnnotatedLeaf(b);

  if (!aIsLeaf && !bIsLeaf) {
    const out: AnnotatedObject = { ...(a as AnnotatedObject) };
    for (const [k, bChild] of Object.entries(b as AnnotatedObject)) {
      const existing = out[k];
      out[k] = existing ? mergeAnnotated(existing, bChild) : bChild;
    }
    return out;
  }

  if (aIsLeaf && bIsLeaf) {
    if (Array.isArray(a.value) && Array.isArray(b.value)) {
      return {
        value: [...(a.value as unknown[]), ...(b.value as unknown[])],
        setBy: [...a.setBy, ...b.setBy],
      };
    }
    return {
      value: b.value,
      setBy: [...a.setBy, ...b.setBy],
    };
  }

  // Mixed leaf / object — `b` wins entirely (matches `mergeConfig`'s "b wins
  // unless both plain objects" rule). `a`'s contributions to the discarded
  // shape are dropped, mirroring the resolved config losing them.
  return b;
}

function isAnnotatedLeaf(node: AnnotatedNode): node is AnnotatedLeaf {
  if (typeof node !== "object" || node === null) return false;
  if (!("value" in node) || !("setBy" in node)) return false;
  return Array.isArray((node as AnnotatedLeaf).setBy);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
