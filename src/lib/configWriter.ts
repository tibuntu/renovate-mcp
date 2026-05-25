/**
 * Serialization entry point for `write_config`.
 *
 * Per ADR-0002, every Phase 4 write path funnels through `serializeConfig`.
 * Plan 04-01 landed the public surface plus the fresh-write branch; plan 04-02
 * (this one) implements the round-trip branch via `jsonc-parser`'s
 * `modify` + `applyEdits` API. Plan 04-03 will refine the refusal-reason
 * dispatch for `.json5`-specific cases.
 *
 * Pure function: no `fs`, no `process`, no I/O. The caller is responsible for
 * reading the existing file off disk and passing the string in (or omitting it
 * when the target file does not yet exist).
 */

import {
  parseTree,
  modify,
  applyEdits,
  ParseErrorCode,
  type Node,
  type ParseError,
  type JSONPath,
  type Edit,
} from "jsonc-parser";

export type SerializeArgs = {
  /**
   * The on-disk path the bytes will eventually be written to. Used by the
   * round-trip branch (04-02 / 04-03) to drive extension-based behavior
   * (e.g. detecting `.json5` for the JSONC-compatibility refusal). Unused on
   * the fresh-write path.
   */
  targetPath: string;
  /** The config object the caller wants on disk after the write. */
  nextConfig: Record<string, unknown>;
  /**
   * The current on-disk content of `targetPath`, or `undefined` if the file
   * does not exist yet (fresh-write path).
   */
  existing?: string;
};

export type SerializeOk = {
  mode: "fresh-write" | "round-trip";
  bytes: string;
};

export type SerializeRefusal = {
  refuse: true;
  reason: string;
  hint: string;
};

export type SerializeResult = SerializeOk | SerializeRefusal;

const REFUSAL_HINT =
  "This file appears to use JSON5-only syntax that jsonc-parser cannot edit safely. " +
  "Pass force=true to overwrite with a fresh JSON rendering, or rewrite the file as " +
  "JSONC (comments + trailing commas are supported).";

// Parse errors of these codes are non-fatal in JSONC: `allowTrailingComma`
// makes the parser still emit `InvalidCommentToken` / `TrailingCommaExpected`-
// adjacent codes as `ParseError`s in some library versions. We tolerate codes
// that purely describe JSONC-permitted syntax. Any other code → refuse.
//
// Empirically (jsonc-parser 3.3): with `allowTrailingComma: true` and the
// default `disallowComments: false`, a well-formed JSONC document yields an
// empty errors array. So treating ANY error as fatal is the safe default.

function deepEqual(a: unknown, b: unknown): boolean {
  // Sufficient for config-shaped data (no functions / Dates / Maps).
  // Key-order-sensitive at the same nesting level: matches what we want —
  // reordering keys at one level is a no-op (handled by the recursive walk
  // visiting each key and finding equal subtrees), while value changes
  // produce different stringifications and trigger a real edit.
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/** Extract the parsed object value at a node-path from the parseTree root. */
function nodeObjectKeys(node: Node | undefined): string[] {
  if (!node || node.type !== "object" || !node.children) return [];
  return node.children
    .filter((c) => c.type === "property" && c.children && c.children.length >= 1)
    .map((c) => c.children![0]!.value as string);
}

function nodeChildValue(node: Node | undefined, key: string): Node | undefined {
  if (!node || node.type !== "object" || !node.children) return undefined;
  for (const prop of node.children) {
    if (
      prop.type === "property" &&
      prop.children &&
      prop.children.length === 2 &&
      prop.children[0]!.value === key
    ) {
      return prop.children[1];
    }
  }
  return undefined;
}

/**
 * Compute the list of JSONPath-rooted edits between the parsed `existingRoot`
 * and `nextConfig`. The returned list is in walk order; the caller applies
 * them iteratively (one `modify` + `applyEdits` per edit, against the running
 * text) because `jsonc-parser`'s docs warn that EditResults from separate
 * `modify` calls MUST NOT be concatenated and applied in one shot — the
 * offsets are relative to the input that each `modify` was called against.
 *
 * Note (array semantics): arrays are treated as ATOMIC. Any change inside an
 * array — including a deeply-nested change to one element — results in the
 * whole array being replaced via a single REPLACE at the array's path.
 * Comments ABOVE the array key survive (they are outside the edited region).
 * Comments INSIDE an array element MAY NOT survive. This is a deliberate
 * scope-cap; element-wise array round-trip is a real-world ask but is NOT in
 * Phase 4 GOAL.md's acceptance list. Future plans can revisit.
 */
type PlannedEdit =
  | { kind: "set"; path: JSONPath; value: unknown }
  | { kind: "remove"; path: JSONPath };

function planEdits(
  existingRoot: Node,
  nextConfig: Record<string, unknown>,
  parentPath: JSONPath,
  existingValue: unknown,
): PlannedEdit[] {
  const edits: PlannedEdit[] = [];

  // Both sides are plain objects → walk keys and recurse.
  if (isPlainObject(existingValue)) {
    const existingObj = existingValue;
    const existingKeys = Object.keys(existingObj);
    const nextKeys = Object.keys(nextConfig);
    const allKeys = new Set([...existingKeys, ...nextKeys]);

    for (const key of allKeys) {
      const inExisting = key in existingObj;
      const inNext = key in nextConfig;
      const path = [...parentPath, key];

      if (inExisting && !inNext) {
        edits.push({ kind: "remove", path });
      } else if (!inExisting && inNext) {
        edits.push({ kind: "set", path, value: nextConfig[key] });
      } else {
        const a = existingObj[key];
        const b = nextConfig[key];
        if (deepEqual(a, b)) continue;
        // Both present, different. Recurse only if BOTH are plain objects.
        if (isPlainObject(a) && isPlainObject(b)) {
          edits.push(...planEdits(existingRoot, b, path, a));
        } else {
          // Arrays or primitives → atomic replace at this path.
          edits.push({ kind: "set", path, value: b });
        }
      }
    }
  } else {
    // Shouldn't normally hit this — we only call with a top-level object.
    // Defensive fallback: replace the whole value.
    edits.push({ kind: "set", path: parentPath, value: nextConfig });
  }

  return edits;
}

export function serializeConfig(args: SerializeArgs): SerializeResult {
  if (args.existing === undefined) {
    return {
      mode: "fresh-write",
      // MUST stay byte-identical to the literal expression currently inlined
      // in src/tools/writeConfig.ts (`JSON.stringify(config, null, 2) + "\n"`)
      // — see ADR-0002 and the snapshot test in configWriter.test.ts.
      bytes: JSON.stringify(args.nextConfig, null, 2) + "\n",
    };
  }

  // Reference targetPath so it is not flagged as unused; plan 04-03 will use
  // it to dispatch on `.json5` extension.
  void args.targetPath;

  const existing = args.existing;
  const parseErrors: ParseError[] = [];
  const root = parseTree(existing, parseErrors, { allowTrailingComma: true });

  const fatalErrors = parseErrors.filter(
    // Any reported parse error at this point means the file is not safe to
    // round-trip — even errors that would scan-only (e.g. InvalidCommentToken
    // when comments are disallowed) signal structural unknowns. With
    // allowTrailingComma=true on a JSONC file, this list is empty in practice.
    (e) => e.error !== ParseErrorCode.InvalidCommentToken,
  );

  if (!root || root.type !== "object" || fatalErrors.length > 0) {
    return {
      refuse: true,
      reason: "json5-not-jsonc-compatible",
      hint: REFUSAL_HINT,
    };
  }

  // Build the in-memory "existing object" view by walking the root's keys.
  // We need the object form (not just the Node) for the diff walk.
  const existingObj: Record<string, unknown> = {};
  for (const key of nodeObjectKeys(root)) {
    const child = nodeChildValue(root, key);
    if (!child) continue;
    // getNodeValue would also work; we mirror it inline to avoid an extra
    // import and to keep this function self-contained.
    existingObj[key] = JSON.parse(existing.slice(child.offset, child.offset + child.length));
  }

  const planned = planEdits(root, args.nextConfig, [], existingObj);

  // Detect line endings: preserve CRLF if the existing file uses it.
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { tabSize: 2, insertSpaces: true, eol };

  // Apply edits ITERATIVELY (not by concatenation): jsonc-parser docs warn
  // that EditResults from separate `modify` calls must not be merged because
  // their offsets refer to the original-at-the-time text. Running them one
  // at a time against the running text is the safe pattern.
  let text = existing;
  for (const edit of planned) {
    const value = edit.kind === "remove" ? undefined : edit.value;
    const editResult: Edit[] = modify(text, edit.path, value, { formattingOptions });
    text = applyEdits(text, editResult);
  }

  return { mode: "round-trip", bytes: text };
}
