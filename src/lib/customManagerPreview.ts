import { promises as fs } from "node:fs";
import path from "node:path";
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
  maxFilesScanned?: number;
  maxHitsPerFile?: number;
}

export interface PreviewResult {
  filesScanned: number;
  filesMatched: string[];
  hits: PreviewHit[];
  extractedDeps: ExtractedDep[];
  warnings: string[];
}

const DEFAULT_MAX_FILES_SCANNED = 2000;
const DEFAULT_MAX_HITS_PER_FILE = 100;
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
  const maxFilesScanned = options.maxFilesScanned ?? DEFAULT_MAX_FILES_SCANNED;
  const maxHitsPerFile = options.maxHitsPerFile ?? DEFAULT_MAX_HITS_PER_FILE;

  if (manager.matchStringsStrategy && manager.matchStringsStrategy !== "any") {
    warnings.push(
      `matchStringsStrategy='${manager.matchStringsStrategy}' is not yet supported by this preview tool; treating as 'any'. Run dry_run for full-fidelity behavior.`,
    );
  }

  const fileMatchRes = manager.fileMatch.map((s) => compileRegex(s));
  const matchStringRes = manager.matchStrings.map((s) => compileRegex(s, "gm"));

  const filesMatched: string[] = [];
  let filesScanned = 0;

  for await (const rel of walk(repoPath)) {
    if (filesScanned >= maxFilesScanned) {
      warnings.push(
        `Stopped after scanning ${maxFilesScanned} files. Increase maxFilesScanned to widen the search.`,
      );
      break;
    }
    filesScanned++;
    if (fileMatchRes.some((re) => re.test(rel))) {
      filesMatched.push(rel);
    }
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
    for (let i = 0; i < matchStringRes.length; i++) {
      const re = matchStringRes[i]!;
      // RegExp objects with the `g` flag are stateful — reset before iterating
      // each file so that previous calls don't shift lastIndex.
      re.lastIndex = 0;
      for (const m of content.matchAll(re)) {
        if (perFileHits >= maxHitsPerFile) {
          warnings.push(
            `${rel}: capped at ${maxHitsPerFile} hits. Increase maxHitsPerFile to see more.`,
          );
          break;
        }
        const groups = (m.groups ?? {}) as Record<string, string>;
        const line = lineNumberAt(content, m.index ?? 0);
        const matchStr = m[0];
        hits.push({ file: rel, matchStringIndex: i, line, match: matchStr, groups });
        extractedDeps.push(buildExtractedDep(rel, line, groups, manager));
        perFileHits++;
      }
      if (perFileHits >= maxHitsPerFile) break;
    }
  }

  return { filesScanned, filesMatched, hits, extractedDeps, warnings };
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

function compileRegex(source: string, extraFlags = ""): RegExp {
  try {
    // De-duplicate flags in case the source already had `g`/`m`.
    const seen = new Set<string>();
    const flags = (extraFlags).split("").filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    }).join("");
    return new RegExp(source, flags);
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
