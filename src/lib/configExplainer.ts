import {
  collectMergeSteps,
  OWN_SOURCE,
  type MergeQuality,
  type MergeStep,
  type PresetWarning,
  type ResolveOptions,
  type UnresolvedPreset,
} from "./presetResolver.js";
import { runMerge } from "./mergeWorker.js";

// Re-exported for callers that historically imported the sentinel from here.
export { OWN_SOURCE };

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
   * The value `source` contributed at the point of the merge. For a scalar /
   * overwritten array, the value `source` set; for a *mergeable* array, just
   * the slice `source` appended.
   */
  value: unknown;
}

export type AnnotatedNode = AnnotatedLeaf | AnnotatedObject;

export interface AnnotatedLeaf {
  /**
   * Final merged value of this field (read authoritatively from the faithful
   * merge result, so it always equals what resolve_config returns). The last
   * `setBy` entry is the winner for scalars and overwritten arrays.
   */
  value: unknown;
  /**
   * Contributions in merge order. For scalars / overwritten arrays the last
   * entry is the winner; for a mergeable array each entry adds its own slice.
   * Note: a source that re-asserts an already-current value is not listed —
   * attribution credits whoever *changed* the value.
   */
  setBy: Contribution[];
}

export type AnnotatedObject = { [key: string]: AnnotatedNode };

export interface ExplainResult {
  explanation: AnnotatedObject;
  presetsResolved: string[];
  presetsUnresolved: UnresolvedPreset[];
  warnings: PresetWarning[];
  mergeQuality: MergeQuality;
}

/**
 * Inverse of `resolveConfig`: instead of collapsing the preset tree into a flat
 * resolved object, annotate each leaf field with the chain of presets that set
 * it. Shares `collectMergeSteps` with `resolveConfig` and folds the same steps
 * through the same worker-isolated faithful merge, then reconstructs provenance
 * by diffing the merge's per-step snapshots (see `attributeContributions`).
 * Because both tools fold identical steps, `explain_config`'s leaf values are
 * by construction identical to `resolve_config`'s output.
 *
 * If the faithful merge worker is unavailable, falls back to an in-process
 * approximate annotated merge over the same steps (no re-expansion) and reports
 * `mergeQuality: "preview"`.
 */
export async function explainConfig(
  config: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<ExplainResult> {
  const { steps, presetsResolved, presetsUnresolved, warnings } =
    await collectMergeSteps(config, options);
  const configs = steps.map((s) => s.config);

  try {
    const { merged, snapshots } = await runMerge(configs, { withSteps: true });
    const explanation = attributeContributions(steps, snapshots ?? [], merged);
    return {
      explanation,
      presetsResolved,
      presetsUnresolved,
      warnings,
      mergeQuality: "faithful",
    };
  } catch (err) {
    // Graceful degradation: fold the already-collected steps with the
    // in-process approximate annotated merge (no worker, no re-expansion).
    let acc: AnnotatedObject = {};
    for (const step of steps) {
      const annotated = annotateValue(
        step.config,
        step.label,
        step.via,
      ) as AnnotatedObject;
      acc = mergeAnnotated(acc, annotated) as AnnotatedObject;
    }
    warnings.push({
      preset: "<merge>",
      message: `Faithful merge worker unavailable (${
        err instanceof Error ? err.message : String(err)
      }); fell back to approximate merge. Run dry_run for authoritative output.`,
    });
    return {
      explanation: acc,
      presetsResolved,
      presetsUnresolved,
      warnings,
      mergeQuality: "preview",
    };
  }
}

/**
 * Reconstruct per-field provenance from the faithful merge's per-step
 * snapshots. `snapshots[i]` is the accumulator after folding `configs[0..i]`,
 * so `snapshots[i-1]` is the state before step `i`; the config contributed at
 * step `i` is `steps[i]` (its `label`/`via` identify the source). For each step
 * we diff the accumulator before vs after to find which leaves it changed, and
 * attribute those changes. Final leaf `value`s come from `merged`, so stripped
 * values always equal `resolve_config`'s output.
 */
function attributeContributions(
  steps: MergeStep[],
  snapshots: Record<string, unknown>[],
  merged: Record<string, unknown>,
): AnnotatedObject {
  const contribByPath = new Map<string, Contribution[]>();

  for (let i = 0; i < steps.length; i++) {
    const before = i === 0 ? {} : (snapshots[i - 1] ?? {});
    const after = snapshots[i] ?? {};
    const step = steps[i]!;
    diffLeaves(before, after, [], (path, contributedValue) => {
      const key = JSON.stringify(path);
      const list = contribByPath.get(key) ?? [];
      list.push({
        source: step.label,
        via: [...step.via],
        value: contributedValue,
      });
      contribByPath.set(key, list);
    });
  }

  return buildAnnotated(merged, [], contribByPath) as AnnotatedObject;
}

/**
 * Walk `after` (the post-step accumulator) and, for every leaf path it changed
 * relative to `before`, invoke `onContribution` with the value this step added.
 * Mergeable-array concatenation (`after` is `before` ++ tail) records only the
 * tail; everything else (scalar/array overwrite, new key) records the whole
 * value. mergeChildConfig only ever adds keys, so walking `after` is complete.
 */
function diffLeaves(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string[],
  onContribution: (path: string[], contributedValue: unknown) => void,
): void {
  for (const [key, afterVal] of Object.entries(after)) {
    const beforeVal = before[key];
    const childPath = [...path, key];

    if (isPlainObject(afterVal)) {
      diffLeaves(
        isPlainObject(beforeVal) ? beforeVal : {},
        afterVal,
        childPath,
        onContribution,
      );
      continue;
    }

    if (jsonEqual(beforeVal, afterVal)) continue;

    if (
      Array.isArray(beforeVal) &&
      Array.isArray(afterVal) &&
      afterVal.length > beforeVal.length &&
      jsonEqual(afterVal.slice(0, beforeVal.length), beforeVal)
    ) {
      // Mergeable-array concatenation: record only the tail this step appended.
      onContribution(childPath, afterVal.slice(beforeVal.length));
    } else {
      // Scalar/array overwrite or a brand-new key: record the whole value.
      onContribution(childPath, afterVal);
    }
  }
}

/**
 * Build the annotated tree from the final `merged` config (authoritative leaf
 * values) plus the path→contributions map produced by `diffLeaves`.
 */
function buildAnnotated(
  node: unknown,
  path: string[],
  contribByPath: Map<string, Contribution[]>,
): AnnotatedNode {
  if (isPlainObject(node)) {
    const out: AnnotatedObject = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = buildAnnotated(child, [...path, key], contribByPath);
    }
    return out;
  }
  return { value: node, setBy: contribByPath.get(JSON.stringify(path)) ?? [] };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Approximate annotated merge — the fallback when the faithful worker is
 * unavailable. Arrays concat (and concat their `setBy`), plain objects recurse,
 * everything else `b` wins (keeping both contributions). Mirrors the historical
 * pre-faithful behavior, so a degraded explanation is never worse than what the
 * tool produced before.
 */
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

  // Mixed leaf / object — `b` wins entirely.
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
