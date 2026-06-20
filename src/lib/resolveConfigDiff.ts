/**
 * Pure structural diff over two *resolved* Renovate configs (the output of
 * `resolve_config` — preset-expanded and merged). This is the resolve-level
 * counterpart to `dryRunDiff.ts`: it answers "did this config refactor change
 * the effective settings only in the ways I intended?" without running
 * Renovate, so it works offline even when datasource lookups would fail.
 *
 * Two diff modes by key shape:
 *   - Array-valued top-level keys (`packageRules`, `customManagers`,
 *     `matchManagers`, `addLabels`, …) → order-insensitive *set* diff. Members
 *     are normalized with `stableStringify` (recursive sort-keys) and compared
 *     as a set, so a reordered array reads as no change and a tweaked rule
 *     reads as one removed + one added (no pairing). Mirrors the throwaway
 *     Python script this tool replaces.
 *   - Everything else → deep-compare via `stableStringify` equality; a
 *     difference emits the full before/after values.
 *
 * Only TOP-LEVEL keys are walked. Arrays nested inside an object are part of
 * that object's deep-compare and surface as a whole-field change.
 */

export interface ResolveConfigFieldChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface ResolveConfigArrayChange {
  added: unknown[];
  removed: unknown[];
}

export interface ResolveConfigDiffSummary {
  fieldsChanged: number;
  arraysChanged: number;
  arrayItemsAdded: number;
  arrayItemsRemoved: number;
}

export interface ResolveConfigDiff {
  summary: ResolveConfigDiffSummary;
  fieldChanges: ResolveConfigFieldChange[];
  arrayChanges: Record<string, ResolveConfigArrayChange>;
  text: string;
}

/**
 * Deterministic JSON serialization with object keys sorted recursively, so two
 * structurally-equal values produce byte-identical strings regardless of key
 * insertion order. `JSON.stringify` alone preserves insertion order, which
 * would make `{a,b}` and `{b,a}` compare unequal. Arrays keep their order
 * (callers that want order-insensitivity sort the normalized members).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}

function diffArrayKey(before: unknown[], after: unknown[]): ResolveConfigArrayChange {
  const beforeNorm = new Map<string, unknown>();
  for (const item of before) beforeNorm.set(stableStringify(item), item);
  const afterNorm = new Map<string, unknown>();
  for (const item of after) afterNorm.set(stableStringify(item), item);

  const removed: unknown[] = [];
  for (const [norm, item] of beforeNorm) {
    if (!afterNorm.has(norm)) removed.push(item);
  }
  const added: unknown[] = [];
  for (const [norm, item] of afterNorm) {
    if (!beforeNorm.has(norm)) added.push(item);
  }

  // Deterministic output regardless of source ordering.
  removed.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  added.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  return { added, removed };
}

export function diffResolvedConfigs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ResolveConfigDiff {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();

  const fieldChanges: ResolveConfigFieldChange[] = [];
  const arrayChanges: Record<string, ResolveConfigArrayChange> = {};

  for (const key of keys) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    const beforeVal = before[key];
    const afterVal = after[key];

    const beforeIsArray = Array.isArray(beforeVal);
    const afterIsArray = Array.isArray(afterVal);

    // Treat a key as "array-shaped" when it is an array on at least one side
    // and never a non-array object on the other (so we don't set-diff an
    // array against a scalar/object — that's a real type change).
    if (
      (beforeIsArray || afterIsArray) &&
      (!hasBefore || beforeIsArray) &&
      (!hasAfter || afterIsArray)
    ) {
      const change = diffArrayKey(
        beforeIsArray ? (beforeVal as unknown[]) : [],
        afterIsArray ? (afterVal as unknown[]) : [],
      );
      if (change.added.length > 0 || change.removed.length > 0) {
        arrayChanges[key] = change;
      }
      continue;
    }

    if (!hasBefore || !hasAfter || stableStringify(beforeVal) !== stableStringify(afterVal)) {
      fieldChanges.push({
        key,
        before: hasBefore ? beforeVal : undefined,
        after: hasAfter ? afterVal : undefined,
      });
    }
  }

  const summary: ResolveConfigDiffSummary = {
    fieldsChanged: fieldChanges.length,
    arraysChanged: Object.keys(arrayChanges).length,
    arrayItemsAdded: Object.values(arrayChanges).reduce((n, c) => n + c.added.length, 0),
    arrayItemsRemoved: Object.values(arrayChanges).reduce((n, c) => n + c.removed.length, 0),
  };

  return {
    summary,
    fieldChanges,
    arrayChanges,
    text: renderText(summary, fieldChanges, arrayChanges),
  };
}

function renderText(
  summary: ResolveConfigDiffSummary,
  fieldChanges: ResolveConfigFieldChange[],
  arrayChanges: Record<string, ResolveConfigArrayChange>,
): string {
  if (summary.fieldsChanged === 0 && summary.arraysChanged === 0) {
    return "No differences between the two resolved configs.";
  }

  const lines: string[] = [];
  lines.push(
    `${summary.fieldsChanged} field${summary.fieldsChanged === 1 ? "" : "s"} changed · ` +
      `${summary.arraysChanged} array key${summary.arraysChanged === 1 ? "" : "s"} changed ` +
      `(+${summary.arrayItemsAdded} / -${summary.arrayItemsRemoved})`,
  );

  if (fieldChanges.length > 0) {
    lines.push("", "Changed fields:");
    for (const fc of fieldChanges) {
      lines.push(`  ${fc.key}: OLD=${formatValue(fc.before)}  NEW=${formatValue(fc.after)}`);
    }
  }

  for (const key of Object.keys(arrayChanges).sort()) {
    const change = arrayChanges[key]!;
    lines.push("", `${key}:`);
    for (const item of change.removed) lines.push(`  - ${stableStringify(item)}`);
    for (const item of change.added) lines.push(`  + ${stableStringify(item)}`);
  }

  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  return stableStringify(value);
}
