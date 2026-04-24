import { promises as fs } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import ignore, { type Ignore } from "ignore";

export interface CustomManager {
  customType: string;
  fileMatch: string[];
  matchStrings: string[];
  matchStringsStrategy?: string;
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
}

export interface PreviewResult {
  filesWalked: number;
  filesMatched: string[];
  hits: PreviewHit[];
  extractedDeps: ExtractedDep[];
  warnings: string[];
}

const DEFAULT_MAX_FILES_WALKED = 2000;
const DEFAULT_MAX_FILES_MATCHED = 500;
const DEFAULT_MAX_HITS_PER_FILE = 100;
const DEFAULT_MATCH_TIMEOUT_MS = 2000;
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
  const warnings: string[] = [];
  const maxFilesWalked = options.maxFilesWalked ?? DEFAULT_MAX_FILES_WALKED;
  const maxFilesMatched = options.maxFilesMatched ?? DEFAULT_MAX_FILES_MATCHED;
  const maxHitsPerFile = options.maxHitsPerFile ?? DEFAULT_MAX_HITS_PER_FILE;
  const matchTimeoutMs = options.matchTimeoutMs ?? DEFAULT_MATCH_TIMEOUT_MS;

  if (manager.matchStringsStrategy && manager.matchStringsStrategy !== "any") {
    warnings.push(
      `matchStringsStrategy='${manager.matchStringsStrategy}' is not yet supported by this preview tool; treating as 'any'. Run dry_run for full-fidelity behavior.`,
    );
  }

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
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      warnings.push(`Could not read ${rel}: ${(err as Error).message}`);
      continue;
    }

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
        extractedDeps.push(buildExtractedDep(rel, line, m.groups, manager));
        perFileHits++;
      }
      if (perFileHits >= maxHitsPerFile) break;
    }
  }

  return { filesWalked, filesMatched, hits, extractedDeps, warnings };
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
  | { mode: "matchAll"; pattern: string; flags: string; content: string };
type TestResponse = { ok: true; mode: "test"; paths: string[] };
type MatchAllResponse = { ok: true; mode: "matchAll"; matches: MatchResult[] };
type ErrorResponse = { ok: false; error: string };
type WorkerResponse = TestResponse | MatchAllResponse | ErrorResponse;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { mode, pattern, flags } = workerData;
  const re = new RegExp(pattern, flags);
  if (mode === 'test') {
    const out = [];
    for (const p of workerData.paths) {
      re.lastIndex = 0;
      if (re.test(p)) out.push(p);
    }
    parentPort.postMessage({ ok: true, mode: 'test', paths: out });
  } else {
    const out = [];
    for (const m of workerData.content.matchAll(re)) {
      out.push({
        index: m.index == null ? 0 : m.index,
        match: m[0],
        groups: m.groups == null ? {} : Object.assign({}, m.groups),
      });
    }
    parentPort.postMessage({ ok: true, mode: 'matchAll', matches: out });
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
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
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
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
