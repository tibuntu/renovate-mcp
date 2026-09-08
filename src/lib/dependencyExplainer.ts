import { extractReport, readArray, readRecord } from "./dryRunDiff.js";

/**
 * Pure walk over a Renovate dry_run report answering "why was/wasn't
 * dependency X updated?". Reads `repositories[*].packageFiles[manager][*].deps[]`
 * — the only place the report carries `skipReason` / `updates` / `warnings` per
 * dependency — and turns it into a one-line verdict plus remedy hints.
 * No I/O, no worker; the tool layer adds packageRules attribution on top.
 */

export interface DependencyUpdate {
  newVersion?: string;
  newValue?: string;
  updateType?: string;
  branchName?: string;
}

export interface DependencyWarning {
  topic?: string;
  message?: string;
}

export interface DependencyHit {
  repository: string;
  manager: string;
  packageFile: string;
  depName?: string;
  packageName?: string;
  currentValue?: string | null;
  currentVersion?: string;
  datasource?: string;
  depType?: string;
  skipReason?: string;
  skipStage?: string;
  /** Empty when Renovate looked the dep up and found nothing; absent in extract-only reports. */
  updates?: DependencyUpdate[];
  warnings: DependencyWarning[];
}

export interface DependencyExplanation {
  depName: string;
  hits: DependencyHit[];
  verdict: string;
  hints: string[];
  relatedProblems: Record<string, unknown>[];
}

export interface ExplainDependencyOptions {
  depName: string;
  /** Substring match instead of exact (both case-insensitive). */
  partial?: boolean;
  /** Only consider deps extracted by this manager. */
  manager?: string;
}

// ponytail: hand-maintained remedies for the common SkipReason values; anything
// else gets the generic hint. Extend when a new reason shows up in support questions.
const SKIP_HINTS: Record<string, string> = {
  ignored: "`ignored`: the dep is listed in `ignoreDeps` — remove it there to re-enable updates.",
  disabled:
    "`disabled`: a packageRule (or the manager / depType config) sets `enabled: false` for this dep — run test_package_rules to find which rule.",
  "package-rules": "`package-rules`: a packageRule excluded this dep — run test_package_rules to see which rule matched.",
  "invalid-value":
    "`invalid-value`: the current value in the file is not something Renovate can parse for this manager (template, variable, or malformed range) — check the source line.",
  "invalid-version":
    "`invalid-version`: the current version is not valid for the configured `versioning` — set `versioning` explicitly in a packageRule.",
  "unsupported-datasource":
    "`unsupported-datasource`: no datasource can look this dep up — check the `datasource` field (customManagers) or the manager's supported registries.",
  "unsupported-version":
    "`unsupported-version`: Renovate cannot handle this version/range syntax under the current `versioning` — pick a different `versioning` or pin the value.",
  "unspecified-version":
    "`unspecified-version`: the dep has no version to update from (missing or empty value) — pin a version in the file.",
  "github-token-required":
    "`github-token-required`: github.com lookups need `GITHUB_COM_TOKEN` (distinct from the platform token) — set it in the server's env.",
  "internal-package":
    "`internal-package`: the dep is part of the same monorepo/workspace — set `updateInternalDeps: true` if you want it updated anyway.",
  "is-pinned": "`is-pinned`: the value is already pinned and `rangeStrategy` produced nothing to change.",
  "contains-variable":
    "`contains-variable`: the value references a variable/template Renovate cannot resolve — hard-code the version or extract it with a customManager.",
  "local-dependency":
    "`local-dependency`: the dep points at a local path, not a registry — nothing to update.",
  "unknown-registry":
    "`unknown-registry`: Renovate does not recognise the registry URL — add a `registryUrls` override or a hostRule.",
  "invalid-config":
    "`invalid-config`: the merged config for this dep is invalid — run validate_config / lint_config on the packageRules that target it.",
  "malicious-update-proposed":
    "`malicious-update-proposed`: the only newer version is flagged malicious; Renovate deliberately keeps the current version.",
};

const NOT_FOUND_HINTS = [
  "Check `enabledManagers`: the manager that owns this dependency's file may not be enabled.",
  "Check the manager's `fileMatch` / `managerFilePatterns`: the file holding this dependency may not match the pattern.",
  "Check `ignorePaths`: the file may live under an ignored path (defaults include `**/node_modules/**`, `**/bower_components/**`, …).",
  'Re-run dry_run with `dryRunMode: "extract"` and search the report to see which files and dependencies Renovate extracted at all.',
];

const NO_LOOKUP_HINT =
  'A hit carries no `updates` array, so no lookup ran — the report is likely from `dryRunMode: "extract"`. Re-run dry_run with `dryRunMode: "lookup"` (or `"full"`) to see whether updates exist.';

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickUpdate(raw: unknown): DependencyUpdate {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    newVersion: optString(u.newVersion),
    newValue: optString(u.newValue),
    updateType: optString(u.updateType),
    branchName: optString(u.branchName),
  };
}

function pickWarning(raw: unknown): DependencyWarning {
  const w = (raw ?? {}) as Record<string, unknown>;
  return { topic: optString(w.topic), message: optString(w.message) };
}

function matches(name: string | undefined, needle: string, partial: boolean): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return partial ? lower.includes(needle) : lower === needle;
}

/** Walk repositories[*].packageFiles[manager][*].deps[] and lift matching deps. */
function collectHits(report: unknown, needle: string, partial: boolean, manager?: string): DependencyHit[] {
  const hits: DependencyHit[] = [];
  const repositories = readRecord(report, "repositories");
  if (!repositories) return hits;

  for (const [repository, repo] of Object.entries(repositories)) {
    const packageFiles = readRecord(repo, "packageFiles");
    if (!packageFiles) continue;
    for (const [managerName, files] of Object.entries(packageFiles)) {
      if (manager && managerName !== manager) continue;
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        const deps = readArray(file, "deps");
        if (!deps) continue;
        const packageFile = optString((file as Record<string, unknown>).packageFile) ?? "";
        for (const raw of deps) {
          if (!raw || typeof raw !== "object") continue;
          const d = raw as Record<string, unknown>;
          const depName = optString(d.depName);
          const packageName = optString(d.packageName);
          if (!matches(depName, needle, partial) && !matches(packageName, needle, partial)) continue;
          hits.push({
            repository,
            manager: managerName,
            packageFile,
            depName,
            packageName,
            currentValue: d.currentValue === null ? null : optString(d.currentValue),
            currentVersion: optString(d.currentVersion),
            datasource: optString(d.datasource),
            depType: optString(d.depType),
            skipReason: optString(d.skipReason),
            skipStage: optString(d.skipStage),
            updates: Array.isArray(d.updates) ? d.updates.map(pickUpdate) : undefined,
            warnings: Array.isArray(d.warnings) ? d.warnings.map(pickWarning) : [],
          });
        }
      }
    }
  }
  return hits;
}

function verdictFor(hits: DependencyHit[]): string {
  if (hits.length === 0) return "not found in report";
  const parts: string[] = [];
  for (const reason of new Set(hits.map((h) => h.skipReason).filter((r): r is string => !!r))) {
    parts.push(`skipped: ${reason}`);
  }
  const live = hits.filter((h) => !h.skipReason);
  const updateCount = live.reduce((n, h) => n + (h.updates?.length ?? 0), 0);
  if (updateCount > 0) parts.push(`${updateCount} update${updateCount === 1 ? "" : "s"} available`);
  else if (live.length > 0) parts.push("up to date");
  return parts.join("; ");
}

function hintsFor(hits: DependencyHit[]): string[] {
  if (hits.length === 0) return [...NOT_FOUND_HINTS];
  const hints: string[] = [];
  for (const reason of new Set(hits.map((h) => h.skipReason).filter((r): r is string => !!r))) {
    hints.push(
      SKIP_HINTS[reason] ??
        `\`${reason}\`: no specific remedy known — search Renovate's docs / source for this skipReason and check the dependency's \`warnings\`.`,
    );
  }
  if (hits.some((h) => !h.skipReason && h.updates === undefined)) hints.push(NO_LOOKUP_HINT);
  return hints;
}

/** Bunyan log records mention a dep in `msg` and/or as structured `depName` / `packageName` meta. */
function mentions(problem: Record<string, unknown>, needle: string, partial: boolean): boolean {
  const text = `${optString(problem.msg) ?? ""} ${optString(problem.message) ?? ""}`.toLowerCase();
  return (
    text.includes(needle) ||
    matches(optString(problem.depName), needle, partial) ||
    matches(optString(problem.packageName), needle, partial)
  );
}

function collectRelatedProblems(report: unknown, needle: string, partial: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const isRecord = (p: unknown): p is Record<string, unknown> => !!p && typeof p === "object" && !Array.isArray(p);
  for (const p of readArray(report, "problems") ?? []) {
    if (isRecord(p) && mentions(p, needle, partial)) out.push(p);
  }
  for (const [repository, repo] of Object.entries(readRecord(report, "repositories") ?? {})) {
    for (const p of readArray(repo, "problems") ?? []) {
      if (isRecord(p) && mentions(p, needle, partial)) out.push({ repository, ...p });
    }
  }
  return out;
}

export function explainDependency(reportInput: unknown, options: ExplainDependencyOptions): DependencyExplanation {
  const report = extractReport(reportInput);
  const needle = options.depName.toLowerCase();
  const partial = options.partial ?? false;
  const hits = collectHits(report, needle, partial, options.manager);
  return {
    depName: options.depName,
    hits,
    verdict: verdictFor(hits),
    hints: hintsFor(hits),
    relatedProblems: collectRelatedProblems(report, needle, partial),
  };
}
