import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import ignore, { type Ignore } from "ignore";

export interface CustomManager {
  customType: string;
  fileMatch: string[];
  matchStrings: string[];
  matchStringsStrategy?: string;
  // Required when customType === "jsonata"; undefined for the regex path.
  fileFormat?: StructuredFileFormat;
  // Template fields — Renovate has a fixed list. Unknown keys are ignored.
  depNameTemplate?: string;
  packageNameTemplate?: string;
  currentValueTemplate?: string;
  currentDigestTemplate?: string;
  datasourceTemplate?: string;
  versioningTemplate?: string;
  registryUrlTemplate?: string;
  depTypeTemplate?: string;
  extractVersionTemplate?: string;
  autoReplaceStringTemplate?: string;
}

export interface PreviewHit {
  file: string;
  matchStringIndex: number;
  line: number;
  match: string;
  groups: Record<string, string>;
}

export interface ExtractedDep {
  file: string;
  line: number;
  depName?: string;
  packageName?: string;
  currentValue?: string;
  currentDigest?: string;
  datasource?: string;
  versioning?: string;
  registryUrl?: string;
  depType?: string;
  extractVersion?: string;
  autoReplaceString?: string;
}

export interface PreviewOptions {
  maxFilesWalked?: number;
  maxFilesMatched?: number;
  maxHitsPerFile?: number;
  matchTimeoutMs?: number;
  maxFileBytes?: number;
}

export interface PreviewResult {
  filesWalked: number;
  filesMatched: string[];
  hits: PreviewHit[];
  extractedDeps: ExtractedDep[];
  warnings: string[];
}

export type StructuredFileFormat = "json" | "yaml" | "toml";
export type ParseStructuredResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Parse `content` according to `fileFormat`. YAML / TOML parsers are lazy-
 * imported on first use of the matching format so sessions that never preview
 * a JSONata-customType manager pay zero load cost. Failures (parser throws,
 * unsupported format) are converted to `{ ok: false, error }` — no exceptions
 * leak.
 */
export async function parseStructured(
  content: string,
  fileFormat: StructuredFileFormat,
): Promise<ParseStructuredResult> {
  try {
    if (fileFormat === "json") {
      return { ok: true, value: JSON.parse(content) };
    }
    if (fileFormat === "yaml") {
      const { parse } = await import("yaml");
      return { ok: true, value: parse(content) };
    }
    if (fileFormat === "toml") {
      const { parse } = await import("smol-toml");
      return { ok: true, value: parse(content) };
    }
    return { ok: false, error: `Unsupported fileFormat: ${fileFormat}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const DEFAULT_MAX_FILES_WALKED = 2000;
const DEFAULT_MAX_FILES_MATCHED = 500;
const DEFAULT_MAX_HITS_PER_FILE = 100;
const DEFAULT_MATCH_TIMEOUT_MS = 2000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const TEMPLATE_FIELD_MAP: Array<[keyof CustomManager, keyof ExtractedDep]> = [
  ["depNameTemplate", "depName"],
  ["packageNameTemplate", "packageName"],
  ["currentValueTemplate", "currentValue"],
  ["currentDigestTemplate", "currentDigest"],
  ["datasourceTemplate", "datasource"],
  ["versioningTemplate", "versioning"],
  ["registryUrlTemplate", "registryUrl"],
  ["depTypeTemplate", "depType"],
  ["extractVersionTemplate", "extractVersion"],
  ["autoReplaceStringTemplate", "autoReplaceString"],
];

export async function previewCustomManager(
  repoPath: string,
  manager: CustomManager,
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  if (manager.customType === "jsonata") {
    return previewJsonataManager(repoPath, manager, options);
  }

  const warnings: string[] = [];
  const maxFilesWalked = options.maxFilesWalked ?? DEFAULT_MAX_FILES_WALKED;
  const maxFilesMatched = options.maxFilesMatched ?? DEFAULT_MAX_FILES_MATCHED;
  const maxHitsPerFile = options.maxHitsPerFile ?? DEFAULT_MAX_HITS_PER_FILE;
  const matchTimeoutMs = options.matchTimeoutMs ?? DEFAULT_MATCH_TIMEOUT_MS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const strategy = resolveStrategy(manager.matchStringsStrategy, warnings);

  // Surface malformed user regexes eagerly, before we do any filesystem work.
  // The Worker path otherwise reports these as generic worker errors.
  for (const src of manager.fileMatch) validateRegex(src);
  for (const src of manager.matchStrings) validateRegex(src);

  // Walk first, then run fileMatch regexes in a worker so a pathological
  // pattern can't pin the event loop on the path-testing phase.
  const allPaths: string[] = [];
  for await (const rel of walk(repoPath)) {
    if (allPaths.length >= maxFilesWalked) {
      warnings.push(
        `Stopped walking the repo after ${maxFilesWalked} files; remaining files were never tested against fileMatch. Add ignores (or a .gitignore) to prune irrelevant directories, or raise maxFilesWalked.`,
      );
      break;
    }
    allPaths.push(rel);
  }
  const filesWalked = allPaths.length;

  const matchedSet = new Set<string>();
  for (let i = 0; i < manager.fileMatch.length; i++) {
    const source = manager.fileMatch[i]!;
    const res = await runTestInWorker(source, "", allPaths, matchTimeoutMs);
    if (res.timedOut) {
      warnings.push(
        `fileMatch[${i}] /${source}/ exceeded ${matchTimeoutMs}ms and was aborted; no paths were matched against this pattern. Simplify the regex (e.g. avoid nested quantifiers like (a+)+) or raise matchTimeoutMs.`,
      );
      continue;
    }
    for (const p of res.paths) matchedSet.add(p);
  }
  // Preserve walk order so output is stable.
  const allFilesMatched = allPaths.filter((p) => matchedSet.has(p));
  // Distinct from the walk cap: this caps the *result set*. A broad fileMatch
  // regex over a large repo can produce thousands of hits; truncate with a
  // dedicated warning so the user can tell which cap tripped.
  const filesMatched = allFilesMatched.slice(0, maxFilesMatched);
  if (allFilesMatched.length > maxFilesMatched) {
    warnings.push(
      `fileMatch matched ${allFilesMatched.length} files; capped result set at maxFilesMatched=${maxFilesMatched}. Narrow fileMatch to target the intended paths, or raise maxFilesMatched.`,
    );
  }

  const hits: PreviewHit[] = [];
  const extractedDeps: ExtractedDep[] = [];

  for (const rel of filesMatched) {
    const abs = path.join(repoPath, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      warnings.push(`Could not stat ${rel}: ${(err as Error).message}`);
      continue;
    }
    if (stat.size > maxFileBytes) {
      warnings.push(
        `${rel}: skipped, ${stat.size} bytes exceeds maxFileBytes=${maxFileBytes}. Tighten fileMatch to exclude it, or raise maxFileBytes.`,
      );
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      warnings.push(`Could not read ${rel}: ${(err as Error).message}`);
      continue;
    }

    const fileResult = await applyMatchStrings(
      rel,
      content,
      manager,
      strategy,
      matchTimeoutMs,
      maxHitsPerFile,
    );
    hits.push(...fileResult.hits);
    extractedDeps.push(...fileResult.deps);
    warnings.push(...fileResult.warnings);
  }

  return { filesWalked, filesMatched, hits, extractedDeps, warnings };
}

/**
 * JSONata customType branch. Mirrors the regex path's walker + fileMatch +
 * caps; differs only in what runs per matched file: structured-format parse
 * via `parseStructured()`, then per-expression JSONata evaluation in the
 * worker via `runEvaluateJsonataInWorker()`. Output-shape normalization
 * mirrors Renovate's `QueryResultZod` (see `normalizeJsonataResult`).
 */
async function previewJsonataManager(
  repoPath: string,
  manager: CustomManager,
  options: PreviewOptions,
): Promise<PreviewResult> {
  const warnings: string[] = [];
  const maxFilesWalked = options.maxFilesWalked ?? DEFAULT_MAX_FILES_WALKED;
  const maxFilesMatched = options.maxFilesMatched ?? DEFAULT_MAX_FILES_MATCHED;
  const matchTimeoutMs = options.matchTimeoutMs ?? DEFAULT_MATCH_TIMEOUT_MS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // Defense-in-depth: the tool layer (`src/tools/previewCustomManager.ts`)
  // catches missing fileFormat with a cleaner error message earlier. This
  // branch handles direct callers of the lib who skipped that guard.
  const fileFormat = manager.fileFormat;
  if (fileFormat !== "json" && fileFormat !== "yaml" && fileFormat !== "toml") {
    warnings.push(
      `customType=jsonata requires a fileFormat of 'json', 'yaml', or 'toml' (got ${
        fileFormat === undefined ? "undefined" : `'${String(fileFormat)}'`
      })`,
    );
    return { filesWalked: 0, filesMatched: [], hits: [], extractedDeps: [], warnings };
  }

  // The fileMatch regexes still apply on the path level. matchStrings are
  // JSONata expressions — DO NOT validateRegex them; their compile errors
  // surface from the worker.
  for (const src of manager.fileMatch) validateRegex(src);

  const allPaths: string[] = [];
  for await (const rel of walk(repoPath)) {
    if (allPaths.length >= maxFilesWalked) {
      warnings.push(
        `Stopped walking the repo after ${maxFilesWalked} files; remaining files were never tested against fileMatch. Add ignores (or a .gitignore) to prune irrelevant directories, or raise maxFilesWalked.`,
      );
      break;
    }
    allPaths.push(rel);
  }
  const filesWalked = allPaths.length;

  const matchedSet = new Set<string>();
  for (let i = 0; i < manager.fileMatch.length; i++) {
    const source = manager.fileMatch[i]!;
    const res = await runTestInWorker(source, "", allPaths, matchTimeoutMs);
    if (res.timedOut) {
      warnings.push(
        `fileMatch[${i}] /${source}/ exceeded ${matchTimeoutMs}ms and was aborted; no paths were matched against this pattern. Simplify the regex (e.g. avoid nested quantifiers like (a+)+) or raise matchTimeoutMs.`,
      );
      continue;
    }
    for (const p of res.paths) matchedSet.add(p);
  }
  const allFilesMatched = allPaths.filter((p) => matchedSet.has(p));
  const filesMatched = allFilesMatched.slice(0, maxFilesMatched);
  if (allFilesMatched.length > maxFilesMatched) {
    warnings.push(
      `fileMatch matched ${allFilesMatched.length} files; capped result set at maxFilesMatched=${maxFilesMatched}. Narrow fileMatch to target the intended paths, or raise maxFilesMatched.`,
    );
  }

  const extractedDeps: ExtractedDep[] = [];

  for (const rel of filesMatched) {
    const abs = path.join(repoPath, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (err) {
      warnings.push(`Could not stat ${rel}: ${(err as Error).message}`);
      continue;
    }
    if (stat.size > maxFileBytes) {
      warnings.push(
        `${rel}: skipped, ${stat.size} bytes exceeds maxFileBytes=${maxFileBytes}. Tighten fileMatch to exclude it, or raise maxFileBytes.`,
      );
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      warnings.push(`Could not read ${rel}: ${(err as Error).message}`);
      continue;
    }

    const parsed = await parseStructured(content, fileFormat);
    if (!parsed.ok) {
      warnings.push(
        `${rel}: failed to parse as ${fileFormat}: ${parsed.error}. No deps extracted from this file.`,
      );
      continue;
    }

    for (let i = 0; i < manager.matchStrings.length; i++) {
      const expression = manager.matchStrings[i]!;
      const res = await runEvaluateJsonataInWorker(
        expression,
        parsed.value,
        matchTimeoutMs,
      );
      if (res.timedOut) {
        warnings.push(
          `${rel}: matchStrings[${i}] JSONata expression exceeded ${matchTimeoutMs}ms and was aborted; any deps from this expression were skipped. Simplify the expression (avoid cartesian joins over large arrays) or raise matchTimeoutMs.`,
        );
        continue;
      }
      if (!res.ok) {
        warnings.push(
          `${rel}: matchStrings[${i}] JSONata compile/evaluation error: ${res.error}. No deps extracted from this expression.`,
        );
        continue;
      }
      const normalized = normalizeJsonataResult(res.result);
      if (normalized.kind === "empty") continue;
      if (normalized.kind === "shape-error") {
        warnings.push(
          `${rel}: matchStrings[${i}] JSONata expression must return an array of objects or a single object (got ${normalized.actualShape}). Adjust the expression to project a list shape like \`packages.{ "depName": name, "currentValue": version }\`. No deps extracted from this expression.`,
        );
        continue;
      }
      for (const obj of normalized.objects) {
        extractedDeps.push(buildJsonataDep(rel, obj, manager));
      }
    }
  }

  // JSONata path has no per-line concept; `hits` stays empty by design.
  // The regex `hits` shape (line, match string, named groups) doesn't map to
  // structured data, so we don't synthesize fake hits.
  return { filesWalked, filesMatched, hits: [], extractedDeps, warnings };
}

/**
 * Output-shape normalization for JSONata results. Mirrors Renovate's
 * `QueryResultZod` (`node_modules/renovate/dist/modules/manager/custom/jsonata/schema.js`):
 *   z.union([z.array(DepObject), DepObject]).transform(
 *     input => Array.isArray(input) ? input : [input],
 *   )
 * That is: a bare object result is SILENTLY wrapped to a one-element array.
 * Without this wrap, a single-dep JSONata expression like
 *   `{ "depName": name, "currentValue": version }` against an object input
 * would extract zero deps from us and one from Renovate — a parity bug.
 * null / undefined / empty array are silent (Renovate logs a debug-only
 * "no matches" message; we mirror by not surfacing a warning).
 */
function normalizeJsonataResult(
  result: unknown,
):
  | { kind: "empty" }
  | { kind: "deps"; objects: Record<string, unknown>[] }
  | { kind: "shape-error"; actualShape: string } {
  if (result === null || result === undefined) return { kind: "empty" };
  if (Array.isArray(result)) {
    if (result.length === 0) return { kind: "empty" };
    for (const entry of result) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { kind: "shape-error", actualShape: "array of non-object" };
      }
    }
    return { kind: "deps", objects: result as Record<string, unknown>[] };
  }
  if (typeof result === "object") {
    // Bare-object wrap — parity with Renovate's QueryResultZod transform.
    return { kind: "deps", objects: [result as Record<string, unknown>] };
  }
  return { kind: "shape-error", actualShape: `typeof === '${typeof result}'` };
}

/**
 * `applyTemplate` requires `Record<string, string>` to keep its return type
 * honest (no `[object Object]` leaking into substitutions and no `undefined`
 * stringification). JSONata results can carry arbitrary value types — numbers,
 * booleans, nested objects, arrays, null. We normalize before substitution:
 *   - string → kept as-is
 *   - number / boolean → coerced via `String(v)` (numeric `currentValue: 1.2`
 *     becomes `"1.2"`, load-bearing for users who project versions as numbers)
 *   - null / undefined → skipped (entry absent from the groups bag)
 *   - object / array → skipped (no `[object Object]` leakage)
 * The same rules apply to direct field reads (e.g. `result.depName`).
 */
function stringifyGroups(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "string") out[k] = v as string;
    else if (t === "number" || t === "boolean") out[k] = String(v);
    // Objects and arrays: skip — no [object Object] in templates.
  }
  return out;
}

function buildJsonataDep(
  file: string,
  obj: Record<string, unknown>,
  manager: CustomManager,
): ExtractedDep {
  // `line: 1` — parsed structured data has no source-line context, so we
  // anchor all JSONata-extracted deps at the top of the file.
  const dep: Record<string, unknown> = { file, line: 1 };
  const groups = stringifyGroups(obj);
  // Direct read from the result object: fields named the same as dep keys
  // populate the dep, after stringification. Mirrors Renovate's
  // `createDependency` reading from `validMatchFields`.
  for (const [, depKey] of TEMPLATE_FIELD_MAP) {
    if (depKey in groups) {
      dep[depKey] = groups[depKey];
    }
  }
  // Template fields still override matching object keys via the existing
  // {{groupName}} substitution. Full Handlebars stays out of scope (same gap
  // as the regex path).
  for (const [tmplKey, depKey] of TEMPLATE_FIELD_MAP) {
    const tmpl = manager[tmplKey];
    if (typeof tmpl === "string") {
      dep[depKey] = applyTemplate(tmpl, groups);
    }
  }
  return dep as unknown as ExtractedDep;
}

type Strategy = "any" | "combination" | "recursive";

function resolveStrategy(
  raw: string | undefined,
  warnings: string[],
): Strategy {
  if (raw === undefined || raw === "any") return "any";
  if (raw === "combination" || raw === "recursive") return raw;
  warnings.push(
    `matchStringsStrategy='${raw}' is not supported by this preview tool; treating as 'any'. Run dry_run for full-fidelity behavior.`,
  );
  return "any";
}

interface FileMatchResult {
  hits: PreviewHit[];
  deps: ExtractedDep[];
  warnings: string[];
}

async function applyMatchStrings(
  rel: string,
  content: string,
  manager: CustomManager,
  strategy: Strategy,
  matchTimeoutMs: number,
  maxHitsPerFile: number,
): Promise<FileMatchResult> {
  if (strategy === "combination") {
    return applyCombination(rel, content, manager, matchTimeoutMs);
  }
  if (strategy === "recursive") {
    return applyRecursive(rel, content, manager, matchTimeoutMs, maxHitsPerFile);
  }
  return applyAny(rel, content, manager, matchTimeoutMs, maxHitsPerFile);
}

async function applyAny(
  rel: string,
  content: string,
  manager: CustomManager,
  matchTimeoutMs: number,
  maxHitsPerFile: number,
): Promise<FileMatchResult> {
  const hits: PreviewHit[] = [];
  const deps: ExtractedDep[] = [];
  const warnings: string[] = [];
  let perFileHits = 0;
  for (let i = 0; i < manager.matchStrings.length; i++) {
    const source = manager.matchStrings[i]!;
    const res = await runMatchAllInWorker(source, "gm", content, matchTimeoutMs);
    if (res.timedOut) {
      warnings.push(
        `${rel}: matchStrings[${i}] /${source}/ exceeded ${matchTimeoutMs}ms and was aborted; any matches in this file for this pattern were skipped. Simplify the regex (e.g. avoid nested quantifiers like (.*)*) or raise matchTimeoutMs.`,
      );
      continue;
    }
    for (const m of res.matches) {
      if (perFileHits >= maxHitsPerFile) {
        warnings.push(
          `${rel}: capped at ${maxHitsPerFile} hits. Increase maxHitsPerFile to see more.`,
        );
        break;
      }
      const line = lineNumberAt(content, m.index);
      hits.push({
        file: rel,
        matchStringIndex: i,
        line,
        match: m.match,
        groups: m.groups,
      });
      deps.push(buildExtractedDep(rel, line, m.groups, manager));
      perFileHits++;
    }
    if (perFileHits >= maxHitsPerFile) break;
  }
  return { hits, deps, warnings };
}

/**
 * Mirrors Renovate's `handleCombination`: every matchString must hit at least
 * once for the file to produce a dep; all matches' named groups are merged
 * (later matches override earlier on key conflicts) into a single dep. We still
 * surface every match as a `hit` so the user can see which lines contributed,
 * but `extractedDeps` collapses to one entry per file.
 */
async function applyCombination(
  rel: string,
  content: string,
  manager: CustomManager,
  matchTimeoutMs: number,
): Promise<FileMatchResult> {
  const hits: PreviewHit[] = [];
  const warnings: string[] = [];
  const perStringMatches: MatchResult[][] = [];

  for (let i = 0; i < manager.matchStrings.length; i++) {
    const source = manager.matchStrings[i]!;
    const res = await runMatchAllInWorker(source, "gm", content, matchTimeoutMs);
    if (res.timedOut) {
      warnings.push(
        `${rel}: matchStrings[${i}] /${source}/ exceeded ${matchTimeoutMs}ms and was aborted; combination strategy could not produce a dep for this file. Simplify the regex or raise matchTimeoutMs.`,
      );
      return { hits: [], deps: [], warnings };
    }
    if (res.matches.length === 0) {
      // Combination requires every matchString to hit at least once.
      return { hits: [], deps: [], warnings };
    }
    perStringMatches.push(res.matches);
    for (const m of res.matches) {
      hits.push({
        file: rel,
        matchStringIndex: i,
        line: lineNumberAt(content, m.index),
        match: m.match,
        groups: m.groups,
      });
    }
  }

  // Merge groups in match order across all matchStrings (later overrides earlier).
  const mergedGroups: Record<string, string> = {};
  for (const matches of perStringMatches) {
    for (const m of matches) Object.assign(mergedGroups, m.groups);
  }
  // Anchor the dep at the first match's line so the user can navigate to the file.
  const firstHit = hits[0]!;
  const deps = [buildExtractedDep(rel, firstHit.line, mergedGroups, manager)];
  return { hits, deps, warnings };
}

/**
 * Mirrors Renovate's `handleRecursive`: matchStrings[0] runs against the file,
 * each match's text becomes the input for matchStrings[1], and so on. At the
 * leaf level (after the last matchString), the merged groups from every level
 * become a dep. Outer-level matches contribute groups but are not themselves
 * deps; only the leaves are. `hits` reports the leaf-level matches with the
 * merged groups, which matches the `any` strategy's "one hit per dep" shape.
 */
async function applyRecursive(
  rel: string,
  content: string,
  manager: CustomManager,
  matchTimeoutMs: number,
  maxHitsPerFile: number,
): Promise<FileMatchResult> {
  const state: RecursiveState = {
    rel,
    manager,
    originalContent: content,
    matchTimeoutMs,
    maxHitsPerFile,
    hits: [],
    deps: [],
    warnings: [],
    capped: false,
  };
  await recurse(state, content, 0, 0, {});
  return { hits: state.hits, deps: state.deps, warnings: state.warnings };
}

interface RecursiveState {
  rel: string;
  manager: CustomManager;
  originalContent: string;
  matchTimeoutMs: number;
  maxHitsPerFile: number;
  hits: PreviewHit[];
  deps: ExtractedDep[];
  warnings: string[];
  capped: boolean;
}

async function recurse(
  state: RecursiveState,
  content: string,
  baseOffset: number,
  index: number,
  combinedGroups: Record<string, string>,
): Promise<void> {
  if (state.capped) return;
  const { manager, rel } = state;
  if (index === manager.matchStrings.length) {
    if (state.deps.length >= state.maxHitsPerFile) {
      state.warnings.push(
        `${rel}: capped at ${state.maxHitsPerFile} hits. Increase maxHitsPerFile to see more.`,
      );
      state.capped = true;
      return;
    }
    const line = lineNumberAt(state.originalContent, baseOffset);
    state.hits.push({
      file: rel,
      matchStringIndex: manager.matchStrings.length - 1,
      line,
      match: content,
      groups: combinedGroups,
    });
    state.deps.push(buildExtractedDep(rel, line, combinedGroups, manager));
    return;
  }
  const source = manager.matchStrings[index]!;
  const res = await runMatchAllInWorker(source, "gm", content, state.matchTimeoutMs);
  if (res.timedOut) {
    state.warnings.push(
      `${rel}: matchStrings[${index}] /${source}/ exceeded ${state.matchTimeoutMs}ms and was aborted; any matches in this file for this pattern were skipped. Simplify the regex or raise matchTimeoutMs.`,
    );
    return;
  }
  for (const m of res.matches) {
    if (state.capped) return;
    await recurse(
      state,
      m.match,
      baseOffset + m.index,
      index + 1,
      { ...combinedGroups, ...m.groups },
    );
  }
}

function buildExtractedDep(
  file: string,
  line: number,
  groups: Record<string, string>,
  manager: CustomManager,
): ExtractedDep {
  const dep: Record<string, unknown> = { file, line };
  // Named capture groups are the baseline — Renovate populates dep fields
  // directly from groups whose names match dep keys.
  for (const [, depKey] of TEMPLATE_FIELD_MAP) {
    if (depKey in groups) {
      const v = groups[depKey];
      if (v !== undefined) dep[depKey] = v;
    }
  }
  // Templates override matching named groups.
  for (const [tmplKey, depKey] of TEMPLATE_FIELD_MAP) {
    const tmpl = manager[tmplKey];
    if (typeof tmpl === "string") {
      dep[depKey] = applyTemplate(tmpl, groups);
    }
  }
  return dep as unknown as ExtractedDep;
}

/**
 * Simple `{{var}}` substitution. Renovate uses full Handlebars; we cover the
 * common case where templates reference named capture groups directly. Helpers
 * like `{{#if}}` or `{{lookup}}` are not implemented — those degrade to a
 * literal placeholder, which the user will notice in the preview.
 */
function applyTemplate(tmpl: string, groups: Record<string, string>): string {
  return tmpl.replace(/\{\{\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\}\}/g, (_, name) =>
    groups[name] ?? "",
  );
}

function validateRegex(source: string): void {
  try {
    new RegExp(source);
  } catch (err) {
    throw new Error(`Invalid regex /${source}/: ${(err as Error).message}`);
  }
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * User-supplied regex runs on its own thread with a wall-clock budget. This
 * keeps catastrophic backtracking (e.g. `(a+)+b` against `aaaa…c`) from
 * pinning the MCP server's event loop — see issue #56. Inline-eval worker
 * source avoids any build/dist resolution drift and keeps the worker
 * dependency-free.
 */
type MatchResult = { index: number; match: string; groups: Record<string, string> };
type WorkerRequest =
  | { mode: "test"; pattern: string; flags: string; paths: string[] }
  | { mode: "matchAll"; pattern: string; flags: string; content: string }
  | { mode: "evaluateJsonata"; expression: string; json: unknown };
type TestResponse = { ok: true; mode: "test"; paths: string[] };
type MatchAllResponse = { ok: true; mode: "matchAll"; matches: MatchResult[] };
type EvaluateJsonataResponse = { ok: true; mode: "evaluateJsonata"; result: unknown };
type ErrorResponse = { ok: false; error: string };
type WorkerResponse =
  | TestResponse
  | MatchAllResponse
  | EvaluateJsonataResponse
  | ErrorResponse;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { mode } = workerData;
    if (mode === 'test') {
      const re = new RegExp(workerData.pattern, workerData.flags);
      const out = [];
      for (const p of workerData.paths) {
        re.lastIndex = 0;
        if (re.test(p)) out.push(p);
      }
      parentPort.postMessage({ ok: true, mode: 'test', paths: out });
    } else if (mode === 'matchAll') {
      const re = new RegExp(workerData.pattern, workerData.flags);
      const out = [];
      for (const m of workerData.content.matchAll(re)) {
        out.push({
          index: m.index == null ? 0 : m.index,
          match: m[0],
          groups: m.groups == null ? {} : Object.assign({}, m.groups),
        });
      }
      parentPort.postMessage({ ok: true, mode: 'matchAll', matches: out });
    } else if (mode === 'evaluateJsonata') {
      const jsonata = require('jsonata');
      const expr = jsonata(workerData.expression);
      const result = await expr.evaluate(workerData.json);
      parentPort.postMessage({ ok: true, mode: 'evaluateJsonata', result });
    }
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
})();
`;

async function runWorker(
  request: WorkerRequest,
  timeoutMs: number,
): Promise<WorkerResponse | "timeout"> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: request,
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<WorkerResponse | "timeout">((resolve, reject) => {
      // Start the timeout clock when the worker thread comes online, NOT when
      // the Worker is constructed. `matchTimeoutMs` is a budget for *user work*
      // (the regex run / JSONata eval) — charging Node's worker_threads spin-up
      // and module compilation against it makes a trivial pattern spuriously
      // "time out" on a cold/slow runner (e.g. a fast fileMatch regex tripping
      // the budget purely from bootstrap latency). A pathological expression is
      // still killed `timeoutMs` after the thread is live, so the kill-on-budget
      // safety posture (ADR-0003) is unchanged. If the worker never comes online
      // it surfaces via the 'error'/'exit' handlers below.
      worker.once("online", () => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      worker.once("message", (msg: WorkerResponse) => resolve(msg));
      worker.once("error", (err) => reject(err));
      worker.once("exit", (code) => {
        if (code !== 0 && code !== 1) {
          // code 1 is the normal exit after terminate(); anything else is a
          // crash we haven't already captured via 'error'.
          reject(new Error(`Regex worker exited unexpectedly with code ${code}`));
        }
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    // terminate() is idempotent and safe to call after the worker already exited.
    await worker.terminate().catch(() => {});
  }
}

async function runTestInWorker(
  pattern: string,
  flags: string,
  paths: string[],
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; paths: string[] }> {
  const response = await runWorker(
    { mode: "test", pattern, flags, paths },
    timeoutMs,
  );
  if (response === "timeout") return { timedOut: true };
  if (!response.ok) throw new Error(`Regex worker error: ${response.error}`);
  if (response.mode !== "test") {
    throw new Error(`Regex worker returned wrong mode: ${response.mode}`);
  }
  return { timedOut: false, paths: response.paths };
}

async function runMatchAllInWorker(
  pattern: string,
  flags: string,
  content: string,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; matches: MatchResult[] }> {
  const response = await runWorker(
    { mode: "matchAll", pattern, flags, content },
    timeoutMs,
  );
  if (response === "timeout") return { timedOut: true };
  if (!response.ok) throw new Error(`Regex worker error: ${response.error}`);
  if (response.mode !== "matchAll") {
    throw new Error(`Regex worker returned wrong mode: ${response.mode}`);
  }
  return { timedOut: false, matches: response.matches };
}

// Unlike the regex helpers (runTestInWorker / runMatchAllInWorker), JSONata
// compile/eval errors are surfaced as { ok: false, error } rather than thrown —
// the main flow treats them as per-expression warnings, not internal failures.
export async function runEvaluateJsonataInWorker(
  expression: string,
  json: unknown,
  timeoutMs: number,
): Promise<
  | { timedOut: true }
  | { timedOut: false; ok: true; result: unknown }
  | { timedOut: false; ok: false; error: string }
> {
  const response = await runWorker(
    { mode: "evaluateJsonata", expression, json },
    timeoutMs,
  );
  if (response === "timeout") return { timedOut: true };
  if (!response.ok) return { timedOut: false, ok: false, error: response.error };
  if (response.mode !== "evaluateJsonata") {
    throw new Error(`Regex worker returned wrong mode: ${response.mode}`);
  }
  return { timedOut: false, ok: true, result: response.result };
}

/**
 * Honor `.gitignore` like git does: each `.gitignore` applies to the subtree it
 * lives in, patterns are resolved relative to that directory. We keep a stack
 * of `(prefix, Ignore)` levels as we descend. `.git/info/exclude` is loaded at
 * the root level. `SKIP_DIRS` stays as a safety net so `.git/` and
 * `node_modules/` get pruned even when no `.gitignore` is present (e.g. the
 * user pointed the tool at a non-git directory).
 */
interface IgnoreLevel {
  /** Prefix relative to repo root, with trailing `/` (empty string for root). */
  prefix: string;
  ig: Ignore;
}

async function readMaybe(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function loadGitignore(
  root: string,
  relDir: string,
  levels: IgnoreLevel[],
): Promise<IgnoreLevel[]> {
  const content = await readMaybe(path.join(root, relDir, ".gitignore"));
  if (!content) return levels;
  const posixPrefix = relDir === "" ? "" : `${toPosix(relDir)}/`;
  return [...levels, { prefix: posixPrefix, ig: ignore().add(content) }];
}

function isIgnored(
  relPath: string,
  isDir: boolean,
  levels: IgnoreLevel[],
): boolean {
  for (const level of levels) {
    const sub =
      level.prefix === ""
        ? relPath
        : relPath.startsWith(level.prefix)
          ? relPath.slice(level.prefix.length)
          : null;
    if (sub === null || sub === "") continue;
    // `ignore` treats a trailing slash as "this is a directory", which is what
    // lets patterns like `dist/` match directory paths.
    if (level.ig.ignores(isDir ? `${sub}/` : sub)) return true;
  }
  return false;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function* walk(root: string): AsyncGenerator<string> {
  // Seed the root level with `.gitignore` plus `.git/info/exclude` (the
  // per-clone exclude file). Both are optional.
  const rootIg = ignore();
  const rootGitignore = await readMaybe(path.join(root, ".gitignore"));
  if (rootGitignore) rootIg.add(rootGitignore);
  const infoExclude = await readMaybe(path.join(root, ".git", "info", "exclude"));
  if (infoExclude) rootIg.add(infoExclude);
  const rootLevels: IgnoreLevel[] = [{ prefix: "", ig: rootIg }];

  yield* walkDir(root, "", rootLevels);
}

async function* walkDir(
  root: string,
  relDir: string,
  levels: IgnoreLevel[],
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }

  // A nested `.gitignore` only affects this directory's subtree — add it to
  // the stack on entry. (The root `.gitignore` is already in `levels`.)
  const dirLevels = relDir === "" ? levels : await loadGitignore(root, relDir, levels);

  for (const entry of entries) {
    const relPath =
      relDir === "" ? entry.name : `${toPosix(relDir)}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (isIgnored(relPath, true, dirLevels)) continue;
      yield* walkDir(root, path.join(relDir, entry.name), dirLevels);
    } else if (entry.isFile()) {
      if (isIgnored(relPath, false, dirLevels)) continue;
      // Always emit POSIX-style paths so users on macOS/Linux/Windows write
      // the same fileMatch regexes.
      yield toPosix(relPath);
    }
  }
}
