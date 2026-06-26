import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";

import { PRESETS, PRESET_NAMES } from "../data/presets.generated.js";

// ---------------------------------------------------------------------------
// Pure, offline preset search.
//
// `suggest_presets` ranks Renovate presets (the committed built-in catalogue
// plus an optional local presets repo) by lexical relevance to a free-text
// intent. The scorer never imports `renovate`, never shells out, and never
// touches the network — it operates only on already-parsed data. See ADR-0005.
// ---------------------------------------------------------------------------

export interface CorpusPreset {
  name: string;
  namespace: string;
  description: string | null;
  body: Record<string, unknown>;
  /** Set only for local presets — the source filename relative to presetsPath. */
  file?: string;
}

export interface SuggestMatch {
  name: string;
  namespace: string;
  description: string | null;
  /** 0..1 relevance score, rounded for stable output. */
  score: number;
  /** Which fields a query token matched: any of name/namespace/description/body. */
  matchedOn: string[];
  file?: string;
  body?: Record<string, unknown>;
}

export type Coverage = "strong" | "partial" | "weak";

interface CorpusEntry {
  preset: CorpusPreset;
  nameText: string;
  namespaceText: string;
  descText: string;
  bodyText: string;
  allText: string;
}

export type Corpus = CorpusEntry[];

// Conservative stopword set: true function words and natural-language filler
// that carry no Renovate signal. Ubiquitous *Renovate* tokens (group, config,
// all, …) are NOT listed here — the IDF weighting downweights them instead, so
// they still contribute when nothing rarer is present.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "my", "our", "your",
  "into", "on", "in", "is", "it", "that", "this", "then", "so", "but", "by", "as",
  "at", "be", "i", "want", "wants", "wanted", "would", "like", "please", "need",
  "needs", "should", "just", "only", "also", "when", "while", "via", "per", "do",
  "does", "me", "we", "us", "can", "could",
]);

const FIELD_WEIGHT = { name: 5, namespace: 4, description: 2, body: 1 } as const;
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_SCORE = 0.12;
const STRONG_THRESHOLD = 0.6;
const PARTIAL_THRESHOLD = 0.3;

const DEFAULT_MAX_FILES_INDEXED = 2000;
const DEFAULT_MAX_PRESETS_INDEXED = 500;
const PRESET_EXT = /\.(json|json5)$/i;

function splitCamel(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/**
 * Lowercase, split camelCase identifiers, split on non-alphanumeric runs, and
 * drop short tokens + stopwords. Returns tokens in order (may contain dupes;
 * callers dedupe as needed).
 */
export function tokenize(text: string): string[] {
  const spaced = splitCamel(text).toLowerCase();
  const out: string[] = [];
  for (const part of spaced.split(/[^a-z0-9]+/)) {
    if (part.length < 2) continue;
    if (STOPWORDS.has(part)) continue;
    out.push(part);
  }
  return out;
}

export function buildCorpus(presets: CorpusPreset[]): Corpus {
  return presets.map((preset) => {
    const nameText = preset.name.toLowerCase();
    const namespaceText = preset.namespace.toLowerCase();
    const descText = (preset.description ?? "").toLowerCase();
    let bodyText = "";
    try {
      bodyText = JSON.stringify(preset.body ?? {}).toLowerCase();
    } catch {
      bodyText = "";
    }
    return {
      preset,
      nameText,
      namespaceText,
      descText,
      bodyText,
      allText: `${nameText} ${namespaceText} ${descText} ${bodyText}`,
    };
  });
}

export interface RankOptions {
  namespace?: string;
  limit?: number;
  minScore?: number;
  includeBody?: boolean;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Rank a corpus against a free-text query.
 *
 * Score = Σ (field-weight × IDF) over distinct query tokens, normalized by the
 * maximum achievable (every token hitting the name). Field weighting favors
 * name > namespace > description > body; the load-of-the-pool IDF downweights
 * tokens that appear in many presets (e.g. "group"), so a preset matching a
 * rare, specific token outranks one that only shares a ubiquitous one. Matching
 * is substring-based (handles camelCase names like `automergeMinor`); this is a
 * recall aid, not a stemmed IR engine.
 */
export function rankCorpus(query: string, corpus: Corpus, opts: RankOptions = {}): SuggestMatch[] {
  const includeBody = opts.includeBody ?? false;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  const tokens = Array.from(new Set(tokenize(query)));
  const pool = opts.namespace
    ? corpus.filter((e) => e.preset.namespace === opts.namespace)
    : corpus;
  if (tokens.length === 0 || pool.length === 0) return [];

  const N = pool.length;
  const idf = new Map<string, number>();
  for (const t of tokens) {
    let df = 0;
    for (const e of pool) if (e.allText.includes(t)) df++;
    idf.set(t, Math.log(1 + N / (1 + df)));
  }
  const maxPossible = tokens.reduce((sum, t) => sum + FIELD_WEIGHT.name * idf.get(t)!, 0);

  const scored: SuggestMatch[] = [];
  for (const e of pool) {
    const matchedOn = new Set<string>();
    let raw = 0;
    let nameHits = 0;
    for (const t of tokens) {
      let w = 0;
      if (e.nameText.includes(t)) {
        w = Math.max(w, FIELD_WEIGHT.name);
        matchedOn.add("name");
        nameHits++;
      }
      if (e.namespaceText.includes(t)) {
        w = Math.max(w, FIELD_WEIGHT.namespace);
        matchedOn.add("namespace");
      }
      if (e.descText.includes(t)) {
        w = Math.max(w, FIELD_WEIGHT.description);
        matchedOn.add("description");
      }
      if (e.bodyText.includes(t)) {
        w = Math.max(w, FIELD_WEIGHT.body);
        matchedOn.add("body");
      }
      raw += w * idf.get(t)!;
    }
    let score = maxPossible > 0 ? raw / maxPossible : 0;
    // Name-overlap confidence boost: a preset whose NAME contains several of the
    // query's terms is very likely the one the user means, even when the query
    // carries filler words ("automerge minor updates" → automergeMinor). Pull the
    // score toward 1 in proportion to how many distinct query tokens hit the name.
    if (nameHits >= 2) {
      score += (1 - score) * Math.min(0.15 * nameHits, 0.45);
    }
    if (score < minScore) continue;
    const match: SuggestMatch = {
      name: e.preset.name,
      namespace: e.preset.namespace,
      description: e.preset.description,
      score: round(score),
      matchedOn: Array.from(matchedOn).sort(),
    };
    if (e.preset.file) match.file = e.preset.file;
    if (includeBody) match.body = e.preset.body;
    scored.push(match);
  }

  scored.sort(
    (a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return scored.slice(0, limit);
}

export function coverageOf(bestScore: number): Coverage {
  if (bestScore >= STRONG_THRESHOLD) return "strong";
  if (bestScore >= PARTIAL_THRESHOLD) return "partial";
  return "weak";
}

export interface IndexOptions {
  maxFilesIndexed?: number;
  maxPresetsIndexed?: number;
}

export interface IndexResult {
  presets: CorpusPreset[];
  warnings: string[];
}

function deriveDescription(body: Record<string, unknown>): string | null {
  const top = body.description;
  if (typeof top === "string") return top;
  if (Array.isArray(top) && top.every((x) => typeof x === "string")) return top.join(" ");
  const rules = body.packageRules;
  if (Array.isArray(rules)) {
    for (const r of rules) {
      if (r && typeof r === "object") {
        const d = (r as Record<string, unknown>).description;
        if (typeof d === "string") return d;
      }
    }
  }
  return null;
}

/**
 * Index a local presets repo: flat `*.json`/`*.json5` files, one preset per
 * file. Name = filename without extension; namespace = "local"; description =
 * top-level `description` → first `packageRules[].description` → null. Parses
 * with JSON5 (parse-only side of the json5/jsonc-parser split). Malformed files
 * become warnings, never crashes. Subdirectories are not recursed.
 */
export async function indexLocalPresets(
  presetsPath: string,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const maxFiles = opts.maxFilesIndexed ?? DEFAULT_MAX_FILES_INDEXED;
  const maxPresets = opts.maxPresetsIndexed ?? DEFAULT_MAX_PRESETS_INDEXED;
  const warnings: string[] = [];

  const entries = await readdir(presetsPath, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && PRESET_EXT.test(e.name))
    .map((e) => e.name)
    .sort();

  let scanned = files;
  if (files.length > maxFiles) {
    warnings.push(
      `Found ${files.length} preset files; only the first ${maxFiles} were scanned (maxFilesIndexed cap).`,
    );
    scanned = files.slice(0, maxFiles);
  }

  const presets: CorpusPreset[] = [];
  for (const file of scanned) {
    if (presets.length >= maxPresets) {
      warnings.push(
        `Indexed ${maxPresets} presets; remaining files skipped (maxPresetsIndexed cap).`,
      );
      break;
    }
    const full = path.join(presetsPath, file);
    let raw: string;
    try {
      raw = await readFile(full, "utf8");
    } catch (err) {
      warnings.push(`Could not read ${file}: ${(err as Error).message}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      warnings.push(`Could not parse ${file} as JSON/JSON5: ${(err as Error).message}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`Skipped ${file}: not a JSON object.`);
      continue;
    }
    const body = parsed as Record<string, unknown>;
    presets.push({
      name: file.replace(PRESET_EXT, ""),
      namespace: "local",
      description: deriveDescription(body),
      body,
      file,
    });
  }

  return { presets, warnings };
}

let builtInCorpus: Corpus | null = null;

/** The committed built-in preset catalogue, built into a searchable corpus once. */
export function getBuiltInCorpus(): Corpus {
  if (!builtInCorpus) {
    const presets: CorpusPreset[] = PRESET_NAMES.map((name) => {
      const p = PRESETS[name]!;
      return { name, namespace: p.namespace, description: p.description, body: p.body };
    });
    builtInCorpus = buildCorpus(presets);
  }
  return builtInCorpus;
}

// ---------------------------------------------------------------------------
// Facet taxonomy + draft skeleton assembly.
//
// This is the ONLY curated map in the suggester — a small, hand-maintained set
// of common Renovate intents → config fragments / recommended built-in presets.
// It is a deliberately bounded maintenance surface (see ADR-0005), analogous to
// the project's other hand-maintained allow-lists. Drafts are NEVER validated
// here (that would require the CLI / merge worker); they are explicitly marked
// unvalidated and compose into validate_config / lint_config.
// ---------------------------------------------------------------------------

export interface DraftContribution {
  extends?: string[];
  packageRules?: Record<string, unknown>[];
  topLevel?: Record<string, unknown>;
  note?: string;
}

export interface Facet {
  id: string;
  /** Tested against the lowercased raw query (substring match, so phrases work). */
  test: (q: string) => boolean;
  build: (q: string) => DraftContribution;
}

function has(q: string, ...subs: string[]): boolean {
  return subs.some((s) => q.includes(s));
}

export const FACETS: Facet[] = [
  {
    id: "automerge",
    test: (q) => has(q, "automerge", "auto-merge", "auto merge"),
    build: (q) => {
      if (has(q, "all", "everything")) return { extends: [":automergeAll"] };
      if (has(q, "major"))
        return {
          extends: [":automergeMajor"],
          note: "Automerging major updates is risky — confirm with dry_run first.",
        };
      if (has(q, "minor")) return { extends: [":automergeMinor"] };
      if (has(q, "patch")) return { extends: [":automergePatch"] };
      return {
        extends: [":automergeMinor"],
        note: "Defaulted to minor+patch automerge; use :automergePatch to restrict to patch only.",
      };
    },
  },
  {
    id: "groupDevDeps",
    // Require "dev" adjacent to "dep" so "development"/"devops"/"developer"
    // don't spuriously trigger a devDependencies grouping rule.
    test: (q) =>
      has(q, "group", "combine", "batch", "bundle") &&
      has(q, "devdep", "dev dep", "dev-dep", "dev dependenc", "devdependenc"),
    build: () => ({
      packageRules: [
        {
          description: "Group devDependency updates into a single PR.",
          matchDepTypes: ["devDependencies"],
          groupName: "dev dependencies",
        },
      ],
    }),
  },
  {
    id: "groupNonMajor",
    test: (q) =>
      has(q, "group", "combine", "batch", "bundle") && has(q, "non-major", "nonmajor", "non major"),
    build: () => ({ extends: ["group:allNonMajor"] }),
  },
  {
    id: "groupMonorepo",
    test: (q) => has(q, "monorepo"),
    build: () => ({
      extends: ["group:recommended"],
      note: "group:recommended pulls in Renovate's curated monorepo groupings.",
    }),
  },
  {
    id: "schedule",
    test: (q) =>
      has(
        q,
        "schedule", "weekend", "weekly", "monthly", "off hours", "off-hours", "nonoffice",
        "non-office", "office hours", "business hours", "after hours", "out of hours",
      ),
    build: (q) => {
      if (has(q, "monthly")) return { extends: ["schedule:monthly"] };
      // Renovate only ships schedule:nonOfficeHours (runs OUTSIDE work hours).
      // Match only clearly-outside-work phrasings — bare "office hours" /
      // "business hours" mean DURING work, which has no preset, so let them
      // fall through to the weekly default rather than returning the opposite.
      if (
        has(
          q,
          "non-office", "nonoffice", "off hours", "off-hours", "after hours",
          "out of hours", "outside office", "outside business",
        )
      )
        return { extends: ["schedule:nonOfficeHours"] };
      if (has(q, "weekend", "weekly")) return { extends: ["schedule:weekly"] };
      return {
        extends: ["schedule:weekly"],
        note: "Defaulted to weekly; see the schedule:* presets for other cadences (no preset exists for 'during office hours').",
      };
    },
  },
  {
    id: "pinDigests",
    test: (q) => has(q, "pin") && has(q, "digest", "sha"),
    build: (q) => {
      if (has(q, "action", "github", "workflow"))
        return { extends: ["helpers:pinGitHubActionDigests"] };
      if (has(q, "docker", "image", "container")) return { extends: ["docker:pinDigests"] };
      return {
        extends: ["docker:pinDigests", "helpers:pinGitHubActionDigests"],
        note: "Digest pinning is datasource-specific; included Docker + GitHub Actions presets — keep the ones you need.",
      };
    },
  },
  {
    id: "semanticCommits",
    test: (q) => has(q, "semantic", "conventional") && has(q, "commit"),
    build: () => ({ topLevel: { semanticCommits: "enabled" } }),
  },
  {
    id: "disableMajor",
    test: (q) => has(q, "disable", "without", "skip", "ignore") && has(q, "major"),
    build: () => ({ extends: [":disableMajorUpdates"] }),
  },
  {
    id: "separateMajor",
    test: (q) => has(q, "separate", "split") && has(q, "major"),
    build: () => ({ extends: [":separateMajorReleases"] }),
  },
  {
    id: "lockfileMaintenance",
    test: (q) =>
      has(q, "lockfile", "lock file", "lock-file") ||
      (has(q, "lock") && has(q, "maintenance", "maintain", "refresh")),
    build: () => ({ extends: [":maintainLockFilesWeekly"] }),
  },
  {
    id: "labels",
    test: (q) => has(q, "label"),
    build: () => ({
      topLevel: { labels: ["dependencies"] },
      note: "Placeholder label 'dependencies' — rename to match your repo's convention.",
    }),
  },
];

export function detectFacets(query: string): { id: string; contribution: DraftContribution }[] {
  const q = query.toLowerCase();
  const out: { id: string; contribution: DraftContribution }[] = [];
  for (const facet of FACETS) {
    if (facet.test(q)) out.push({ id: facet.id, contribution: facet.build(q) });
  }
  return out;
}

export interface Draft {
  config: Record<string, unknown>;
  unvalidated: true;
  hint: string;
  facets: string[];
  notes: string[];
}

const DRAFT_HINT =
  "Unvalidated starting point. Pass draft.config to validate_config, then lint_config, before adopting it.";

/**
 * Assemble an unvalidated draft Renovate config from the facets a query
 * triggers. `config` is the pasteable/validatable Renovate config; the
 * surrounding fields (`unvalidated`, `hint`, `facets`, `notes`) are metadata —
 * pass `draft.config` (not the whole draft) to validate_config.
 */
export function assembleDraft(query: string): Draft {
  const detected = detectFacets(query);
  const extendsList: string[] = [];
  const packageRules: Record<string, unknown>[] = [];
  const topLevel: Record<string, unknown> = {};
  const notes: string[] = [];
  const facets: string[] = [];

  for (const { id, contribution } of detected) {
    facets.push(id);
    if (contribution.extends) {
      for (const e of contribution.extends) if (!extendsList.includes(e)) extendsList.push(e);
    }
    if (contribution.packageRules) packageRules.push(...contribution.packageRules);
    if (contribution.topLevel) Object.assign(topLevel, contribution.topLevel);
    if (contribution.note) notes.push(contribution.note);
  }

  const config: Record<string, unknown> = {};
  if (extendsList.length) config.extends = extendsList;
  Object.assign(config, topLevel);
  if (packageRules.length) config.packageRules = packageRules;

  // Cross-facet sanity: disabling and separating major updates are mutually
  // exclusive. validate_config/lint_config won't flag this (it's schema-valid),
  // so surface it in the draft notes.
  if (facets.includes("disableMajor") && facets.includes("separateMajor")) {
    notes.push(
      ":disableMajorUpdates and :separateMajorReleases conflict — you can't separate major updates you've disabled. Keep one.",
    );
  }

  if (facets.length === 0) {
    notes.push(
      "Couldn't infer preset structure from this query. Describe the intent in more detail (mention automerge, grouping, scheduling, digest pinning, semantic commits, etc.), or browse renovate://presets.",
    );
  }

  return { config, unvalidated: true, hint: DRAFT_HINT, facets, notes };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface SuggestOptions {
  presetsPath?: string;
  namespace?: string;
  limit?: number;
  minScore?: number;
  includeBody?: boolean;
  includeDraft?: boolean;
  maxFilesIndexed?: number;
  maxPresetsIndexed?: number;
}

export interface SuggestResult {
  query: string;
  builtIn: SuggestMatch[];
  local: SuggestMatch[];
  bestScore: number;
  coverage: Coverage;
  draft?: Draft;
  warnings: string[];
}

export async function suggestPresets(
  query: string,
  opts: SuggestOptions = {},
): Promise<SuggestResult> {
  const rankOpts: RankOptions = {
    namespace: opts.namespace,
    limit: opts.limit,
    minScore: opts.minScore,
    includeBody: opts.includeBody,
  };
  const warnings: string[] = [];

  const builtIn = rankCorpus(query, getBuiltInCorpus(), rankOpts);

  let local: SuggestMatch[] = [];
  if (opts.presetsPath) {
    const idx = await indexLocalPresets(opts.presetsPath, {
      maxFilesIndexed: opts.maxFilesIndexed,
      maxPresetsIndexed: opts.maxPresetsIndexed,
    });
    warnings.push(...idx.warnings);
    local = rankCorpus(query, buildCorpus(idx.presets), rankOpts);
  }

  const bestScore = Math.max(builtIn[0]?.score ?? 0, local[0]?.score ?? 0);
  const coverage = coverageOf(bestScore);

  const result: SuggestResult = { query, builtIn, local, bestScore, coverage, warnings };
  if (opts.includeDraft ?? true) {
    const draft = assembleDraft(query);
    // Emit the draft when it adds something a single top match can't: a gap to
    // fill (coverage not strong) OR genuine composition (>=2 facets). A single
    // strongly-covered facet needs no draft — the top match already says it.
    if (coverage !== "strong" || draft.facets.length >= 2) {
      result.draft = draft;
    }
  }
  return result;
}
