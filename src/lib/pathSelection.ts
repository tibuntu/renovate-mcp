import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { Minimatch } from "minimatch";
import { OPTIONS } from "../data/options.generated.js";
import { explainConfig, type AnnotatedLeaf, type AnnotatedNode } from "./configExplainer.js";
import { DEFAULT_MATCH_TIMEOUT_MS, matchFilePatterns } from "./customManagerPreview.js";
import type { MergeQuality, PresetWarning, ResolveOptions, UnresolvedPreset } from "./presetResolver.js";
import { isRecord } from "./util.js";

const execFileP = promisify(execFile);

export const DEFAULT_MAX_FILES = 50_000;
const SAMPLE_SIZE = 5;
const MAX_SUBSTRING_HITS = 50;
const RENOVATE_DEFAULT = "<renovate default>";

// ---------------------------------------------------------------------------
// Renovate's own filters, mirrored from
// node_modules/renovate/dist/workers/repository/extract/file-match.js
// (`getIncludedFiles` / `filterIgnoredFiles`). Mirrored rather than
// worker-imported because they are two one-liners over minimatch (already a
// direct dep pinned to Renovate's major); test/unit/pathSelection.test.ts runs
// the real functions as an oracle so the mirror can't drift silently.
// ---------------------------------------------------------------------------

const mmCache = new Map<string, Minimatch>();
function glob(pattern: string): Minimatch {
  let mm = mmCache.get(pattern);
  if (!mm) mmCache.set(pattern, (mm = new Minimatch(pattern, { dot: true })));
  return mm;
}

/** includePaths: exact path or case-sensitive glob. */
function includeHit(file: string, pattern: string): "exact" | "glob" | null {
  if (file === pattern) return "exact";
  return glob(pattern).match(file) ? "glob" : null;
}

/** ignorePaths: substring OR case-sensitive glob. */
function ignoreHit(file: string, pattern: string): { substring: boolean; glob: boolean } {
  return { substring: file.includes(pattern), glob: glob(pattern).match(file) };
}

/** Renovate's `getFilteredFileList`: includePaths first, then ignorePaths. */
export function filterFileList(
  files: string[],
  includePaths: string[],
  ignorePaths: string[],
): string[] {
  const included = includePaths.length
    ? files.filter((f) => includePaths.some((p) => includeHit(f, p)))
    : files;
  return ignorePaths.length
    ? included.filter((f) => !ignorePaths.some((p) => {
        const h = ignoreHit(f, p);
        return h.substring || h.glob;
      }))
    : included;
}

// ---------------------------------------------------------------------------
// File list
// ---------------------------------------------------------------------------

/**
 * Renovate's local platform lists files with `git ls-files` and falls back to
 * a `**` glob (dot files included, nothing pruned) — see
 * node_modules/renovate/dist/modules/platform/local/scm.js. Mirror both so
 * `**\/node_modules/**` style ignores are visible, unlike the
 * .gitignore-honouring walk in customManagerPreview.ts.
 */
export async function listRepoFiles(
  repoPath: string,
): Promise<{ files: string[]; source: "git" | "walk" }> {
  try {
    const { stdout } = await execFileP("git", ["ls-files", "-z"], {
      cwd: repoPath,
      maxBuffer: 512 * 1024 * 1024,
    });
    return { files: stdout.split("\0").filter(Boolean), source: "git" };
  } catch {
    const entries = await fs.readdir(repoPath, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => path.relative(repoPath, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
      // ponytail: Renovate's glob would include .git/ internals too; they only add noise.
      .filter((f) => !f.startsWith(".git/"))
      .sort();
    return { files, source: "walk" };
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface PathPattern {
  field: "includePaths" | "ignorePaths";
  index: number;
  pattern: string;
  /** `<own>`, `<renovate default>`, or the preset reference that set it. */
  source: string;
  via: string[];
  /** How the matched files were hit; `none` when nothing matched. */
  matchKind: "exact" | "substring" | "glob" | "none";
  matchedCount: number;
  sampleFiles: string[];
}

export interface SubstringOnlyHit {
  file: string;
  pattern: string;
  /** The glob the bare pattern was probably meant as. */
  suggestedGlob: string;
  /** False = the suggestion would NOT drop this file, so the hit is likely a surprise. */
  suggestedGlobMatches: boolean;
}

export interface MatchFileNamesEntry {
  rule: number;
  description?: string;
  source: string;
  index: number;
  pattern: string;
  matchedCount: number;
  sampleFiles: string[];
}

export interface DeadPattern {
  field: string;
  index: number;
  pattern: string;
  source: string;
}

export interface PathSelectionResult {
  patterns: PathPattern[];
  deadPatterns: DeadPattern[];
  substringOnlyHits: SubstringOnlyHit[];
  matchFileNames: MatchFileNamesEntry[];
  summary: {
    fileListSource: "git" | "walk";
    totalFiles: number;
    evaluatedFiles: number;
    truncated: boolean;
    keptCount: number;
    excludedByIncludePaths: number;
    excludedByIgnorePaths: number;
    substringOnlyHitCount: number;
  };
  mergeQuality: MergeQuality;
  presetsUnresolved: UnresolvedPreset[];
  warnings: string[];
}

export interface PathSelectionOptions extends ResolveOptions {
  maxFiles?: number;
}

function isLeaf(node: AnnotatedNode | undefined): node is AnnotatedLeaf {
  return isRecord(node) && "setBy" in node && Array.isArray(node.setBy);
}

/** Last contribution whose (array) value contains `el` — works for overwritten and concatenated arrays. */
function sourceOf(leaf: AnnotatedLeaf, el: unknown): { source: string; via: string[] } {
  for (let i = leaf.setBy.length - 1; i >= 0; i--) {
    const c = leaf.setBy[i]!;
    if (Array.isArray(c.value) ? c.value.some((v) => isDeepStrictEqual(v, el)) : isDeepStrictEqual(c.value, el)) {
      return { source: c.source, via: c.via };
    }
  }
  return { source: "<unknown>", via: [] };
}

function stringList(leaf: AnnotatedLeaf | undefined): string[] {
  return Array.isArray(leaf?.value) ? leaf.value.filter((v): v is string => typeof v === "string") : [];
}

// ponytail: naive "what was meant" heuristic; only offered for bare (non-glob) patterns.
function suggestGlob(pattern: string): string {
  const p = pattern.replace(/\/+$/, "");
  if (p.includes("/")) return `${p}/**`;
  if (p.includes(".")) return `**/${p}`;
  return `**/${p}/**`;
}

/** Only the user's own config and external presets can be edited; built-in/default dead globs are just noise. */
function userOwned(source: string): boolean {
  return source === "<own>" || (!source.startsWith("<") && source.includes(">"));
}

export async function explainPaths(
  repoPath: string,
  config: Record<string, unknown>,
  options: PathSelectionOptions = {},
): Promise<PathSelectionResult> {
  const warnings: string[] = [];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const explained = await explainConfig(config, options);
  const tree = explained.explanation;
  // Only the merge-fallback warning matters here; the rest are about Handlebars
  // templates, irrelevant to paths (unresolved presets have their own field).
  warnings.push(
    ...explained.warnings.filter((w: PresetWarning) => w.preset === "<merge>").map((w) => w.message),
  );

  const includeLeaf = isLeaf(tree.includePaths) ? tree.includePaths : undefined;
  const ignoreLeaf = isLeaf(tree.ignorePaths) ? tree.ignorePaths : undefined;
  const includePaths = stringList(includeLeaf);
  // ignorePaths is non-mergeable with a non-empty default: unset → Renovate's default applies.
  const ignorePaths = ignoreLeaf ? stringList(ignoreLeaf) : [...(OPTIONS.ignorePaths!.default as string[])];
  const attribute = (leaf: AnnotatedLeaf | undefined, p: string) =>
    leaf ? sourceOf(leaf, p) : { source: RENOVATE_DEFAULT, via: [] };

  for (const [key, node] of Object.entries(tree)) {
    if (isLeaf(node) || !isRecord(node)) continue;
    for (const field of ["includePaths", "ignorePaths"]) {
      if (field in node) {
        warnings.push(
          `${key}.${field} is a manager-level override (it replaces the top-level list for the ${key} manager only) and is not evaluated here.`,
        );
      }
    }
  }

  const listed = await listRepoFiles(repoPath);
  if (listed.source === "walk") {
    warnings.push(
      "repoPath is not a git work tree (or git is unavailable), so the file list comes from a full directory walk — Renovate's own fallback. In a git repo Renovate scans only `git ls-files` output.",
    );
  }
  const truncated = listed.files.length > maxFiles;
  const files = listed.files.slice(0, maxFiles);
  if (truncated) {
    warnings.push(
      `The repo lists ${listed.files.length} files; only the first ${maxFiles} were evaluated. Raise maxFiles for exact counts.`,
    );
  }

  const patterns: PathPattern[] = [];

  // includePaths, against the full list.
  includePaths.forEach((pattern, index) => {
    const matched = files.filter((f) => includeHit(f, pattern));
    patterns.push({
      field: "includePaths",
      index,
      pattern,
      ...attribute(includeLeaf, pattern),
      matchKind: matched.length === 0 ? "none" : matched.includes(pattern) ? "exact" : "glob",
      matchedCount: matched.length,
      sampleFiles: matched.slice(0, SAMPLE_SIZE),
    });
  });
  const included = filterFileList(files, includePaths, []);

  // ignorePaths, against the include-filtered list (Renovate's order).
  const globIgnored = new Set<string>();
  const substringHits = new Map<string, string[]>(); // file → patterns that hit it by substring only
  ignorePaths.forEach((pattern, index) => {
    const matched: string[] = [];
    let anyGlob = false;
    for (const f of included) {
      const h = ignoreHit(f, pattern);
      if (h.glob) {
        anyGlob = true;
        globIgnored.add(f);
      } else if (h.substring) {
        substringHits.set(f, [...(substringHits.get(f) ?? []), pattern]);
      }
      if (h.glob || h.substring) matched.push(f);
    }
    patterns.push({
      field: "ignorePaths",
      index,
      pattern,
      ...attribute(ignoreLeaf, pattern),
      matchKind: matched.length === 0 ? "none" : anyGlob ? "glob" : "substring",
      matchedCount: matched.length,
      sampleFiles: matched.slice(0, SAMPLE_SIZE),
    });
  });
  const kept = filterFileList(included, [], ignorePaths);

  const allSubstringOnly: SubstringOnlyHit[] = [];
  for (const [file, pats] of substringHits) {
    if (globIgnored.has(file)) continue;
    for (const pattern of pats) {
      const suggestedGlob = suggestGlob(pattern);
      allSubstringOnly.push({
        file,
        pattern,
        suggestedGlob,
        suggestedGlobMatches: new Minimatch(suggestedGlob, { dot: true }).match(file),
      });
    }
  }
  // Likely surprises first.
  allSubstringOnly.sort((a, b) => Number(a.suggestedGlobMatches) - Number(b.suggestedGlobMatches));
  if (allSubstringOnly.length > MAX_SUBSTRING_HITS) {
    warnings.push(
      `${allSubstringOnly.length} substring-only ignorePaths hits; listing the first ${MAX_SUBSTRING_HITS}.`,
    );
  }

  // packageRules[].matchFileNames, against the kept files (matchRegexOrGlob, case-insensitive).
  const matchFileNames: MatchFileNamesEntry[] = [];
  const rulesLeaf = isLeaf(tree.packageRules) ? tree.packageRules : undefined;
  const rules = Array.isArray(rulesLeaf?.value) ? rulesLeaf.value : [];
  for (const [rule, r] of rules.entries()) {
    if (!isRecord(r) || !Array.isArray(r.matchFileNames)) continue;
    const { source } = sourceOf(rulesLeaf!, r);
    for (const [index, pattern] of r.matchFileNames.entries()) {
      if (typeof pattern !== "string") continue;
      let matched: string[] = [];
      try {
        matched = await matchFilePatterns(kept, [pattern], DEFAULT_MATCH_TIMEOUT_MS, warnings);
      } catch (err) {
        warnings.push(`packageRules[${rule}].matchFileNames[${index}] ${pattern}: ${(err as Error).message}`);
      }
      matchFileNames.push({
        rule,
        ...(typeof r.description === "string" ? { description: r.description } : {}),
        source,
        index,
        pattern,
        matchedCount: matched.length,
        sampleFiles: matched.slice(0, SAMPLE_SIZE),
      });
    }
  }

  const deadPatterns: DeadPattern[] = [
    ...patterns
      .filter((p) => p.matchedCount === 0 && userOwned(p.source))
      .map(({ field, index, pattern, source }) => ({ field, index, pattern, source })),
    ...matchFileNames
      .filter((m) => m.matchedCount === 0 && userOwned(m.source))
      .map(({ rule, index, pattern, source }) => ({
        field: `packageRules[${rule}].matchFileNames`,
        index,
        pattern,
        source,
      })),
  ];

  return {
    patterns,
    deadPatterns,
    substringOnlyHits: allSubstringOnly.slice(0, MAX_SUBSTRING_HITS),
    matchFileNames,
    summary: {
      fileListSource: listed.source,
      totalFiles: listed.files.length,
      evaluatedFiles: files.length,
      truncated,
      keptCount: kept.length,
      excludedByIncludePaths: files.length - included.length,
      excludedByIgnorePaths: included.length - kept.length,
      substringOnlyHitCount: allSubstringOnly.length,
    },
    mergeQuality: explained.mergeQuality,
    presetsUnresolved: explained.presetsUnresolved,
    warnings,
  };
}
