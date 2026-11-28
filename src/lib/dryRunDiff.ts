/**
 * Pure semantic diff over Renovate dry-run reports.
 *
 * The Renovate report shape is not a stable API, so we walk it defensively:
 * we extract a flat list of "proposed updates" — the entries that would
 * become PRs — keyed by `(manager, packageFile, depName)` and compare on the
 * fields that meaningfully describe what each PR would do.
 *
 * Identity: a coarse key (manager, packageFile, depName) groups version
 * bumps as `changed` rather than `removed + added` — the common case when a
 * user is iterating on config.
 */

import { isDeepStrictEqual } from "node:util";

const COMPARED_FIELDS = [
  "newValue",
  "newVersion",
  "updateType",
  "branchName",
  "groupName",
  "schedule",
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

export interface ProposedUpdate {
  manager: string;
  packageFile: string;
  depName: string;
  currentValue?: string;
  currentVersion?: string;
  newValue?: string;
  newVersion?: string;
  updateType?: string;
  branchName?: string;
  groupName?: string;
  schedule?: unknown;
}

export interface FieldChange {
  field: ComparedField;
  before: unknown;
  after: unknown;
}

export interface ChangedUpdate {
  manager: string;
  packageFile: string;
  depName: string;
  before: ProposedUpdate;
  after: ProposedUpdate;
  changes: FieldChange[];
}

export interface DryRunDiff {
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
  added: ProposedUpdate[];
  removed: ProposedUpdate[];
  changed: ChangedUpdate[];
  text: string;
}

/**
 * Accepts either a raw Renovate report (`{ repositories: {...} }`) or the
 * full `dry_run` tool summary (`{ ok, report: {...}, ... }`). If the input
 * has a `report` property we treat it as the summary form and pull the
 * report out of it; otherwise we assume the input is the report itself.
 */
export function extractReport(input: unknown): unknown {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if ("report" in obj && obj.report && typeof obj.report === "object") {
      return obj.report;
    }
  }
  return input;
}

export type ReportUpgrade = { upgrade: Record<string, unknown>; branch?: Record<string, unknown> };

/**
 * Yield every upgrade in the report. A repository with branches is read from
 * `branches[*].upgrades[]` only (what would actually become a PR), each entry
 * paired with its `branch`. A repository with no branches (e.g. a `--platform=local`
 * run, which never creates any) is read from `packageFiles[manager][].deps[].updates[]`
 * instead, flattened as `{ ...dep, manager, packageFile, ...update }` with no
 * `branch`; branch-only fields (`groupName`, `branchResult`) are absent there.
 */
export function collectReportUpgrades(
  report: unknown,
): ReportUpgrade[] {
  const out: ReportUpgrade[] = [];
  const repositories = readRecord(report, "repositories");
  if (!repositories) return out;

  for (const repo of Object.values(repositories)) {
    const branches = readArray(repo, "branches");
    if (branches && branches.length > 0) {
      for (const branch of branches) {
        const upgrades = readArray(branch, "upgrades");
        if (!upgrades) continue;
        for (const upgrade of upgrades) {
          if (!upgrade || typeof upgrade !== "object") continue;
          out.push({ upgrade: upgrade as Record<string, unknown>, branch: branch as Record<string, unknown> });
        }
      }
      continue;
    }
    const packageFiles = readRecord(repo, "packageFiles");
    if (!packageFiles) continue;
    for (const [manager, files] of Object.entries(packageFiles)) {
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        const deps = readArray(file, "deps");
        if (!deps) continue;
        const packageFile = (file as Record<string, unknown>).packageFile;
        for (const dep of deps) {
          const updates = readArray(dep, "updates");
          if (!updates) continue;
          const { updates: _omit, ...rest } = dep as Record<string, unknown>;
          for (const update of updates) {
            if (!update || typeof update !== "object") continue;
            out.push({ upgrade: { ...rest, manager, packageFile, ...(update as Record<string, unknown>) } });
          }
        }
      }
    }
  }
  return out;
}

/** Every proposed update in the report, normalised; see `collectReportUpgrades` for where they are read from. */
export function collectProposedUpdates(report: unknown): ProposedUpdate[] {
  return collectReportUpgrades(report)
    .map((e) => pickUpdate(e.upgrade))
    .filter((u): u is ProposedUpdate => u !== null);
}

function pickUpdate(raw: unknown): ProposedUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const manager = stringOr(obj.manager, "");
  const depName = stringOr(obj.depName, "");
  // `packageFile` is sometimes missing on lockfile-only updates; fall back to
  // empty string so the identity key is stable. `manager` and `depName` are
  // the load-bearing parts.
  const packageFile = stringOr(obj.packageFile, "");
  if (!manager || !depName) return null;

  return {
    manager,
    packageFile,
    depName,
    currentValue: stringOpt(obj.currentValue),
    currentVersion: stringOpt(obj.currentVersion),
    newValue: stringOpt(obj.newValue),
    newVersion: stringOpt(obj.newVersion),
    updateType: stringOpt(obj.updateType),
    branchName: stringOpt(obj.branchName),
    groupName: stringOpt(obj.groupName),
    schedule: obj.schedule,
  };
}

export function readRecord(node: unknown, key: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readArray(node: unknown, key: string): unknown[] | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function identityKey(u: { manager: string; packageFile: string; depName: string }): string {
  return `${u.manager}\u0000${u.packageFile}\u0000${u.depName}`;
}

type IdentityFields = { manager: string; packageFile: string; depName: string; updateType?: string };

/**
 * Index both sides on a shared pairing key. The coarse `identityKey` is used
 * while neither side holds more than one entry for it (so a version bump
 * pairs as `changed`); otherwise every entry of that group is keyed on
 * `identityKey + updateType` so a dep's minor and major updates stay apart.
 * First entry wins on a repeat (a dep listed in two branches counts once).
 */
function indexForPairing<T extends IdentityFields>(
  before: T[],
  after: T[],
): [Map<string, T>, Map<string, T>] {
  const count = (list: T[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const u of list) m.set(identityKey(u), (m.get(identityKey(u)) ?? 0) + 1);
    return m;
  };
  const bc = count(before);
  const ac = count(after);
  const index = (list: T[]): Map<string, T> => {
    const map = new Map<string, T>();
    for (const u of list) {
      const k = identityKey(u);
      const coarse = (bc.get(k) ?? 0) <= 1 && (ac.get(k) ?? 0) <= 1;
      const key = coarse ? k : `${k}\u0000${u.updateType ?? ""}`;
      if (!map.has(key)) map.set(key, u);
    }
    return map;
  };
  return [index(before), index(after)];
}

function diffFields(before: ProposedUpdate, after: ProposedUpdate): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of COMPARED_FIELDS) {
    const a = before[field];
    const b = after[field];
    // Mostly strings; `schedule` may be an array of strings.
    if (!isDeepStrictEqual(a, b)) {
      changes.push({ field, before: a, after: b });
    }
  }
  return changes;
}

export function diffDryRunReports(beforeInput: unknown, afterInput: unknown): DryRunDiff {
  const beforeReport = extractReport(beforeInput);
  const afterReport = extractReport(afterInput);
  const beforeUpdates = collectProposedUpdates(beforeReport);
  const afterUpdates = collectProposedUpdates(afterReport);

  const [beforeIdx, afterIdx] = indexForPairing(beforeUpdates, afterUpdates);

  const added: Array<[string, ProposedUpdate]> = [];
  const removed: Array<[string, ProposedUpdate]> = [];
  const changed: Array<[string, ChangedUpdate]> = [];
  let unchanged = 0;

  for (const [key, after] of afterIdx) {
    const before = beforeIdx.get(key);
    if (!before) {
      added.push([key, after]);
      continue;
    }
    const changes = diffFields(before, after);
    if (changes.length === 0) {
      unchanged += 1;
    } else {
      changed.push([key, {
        manager: after.manager,
        packageFile: after.packageFile,
        depName: after.depName,
        before,
        after,
        changes,
      }]);
    }
  }
  for (const [key, before] of beforeIdx) {
    if (!afterIdx.has(key)) removed.push([key, before]);
  }

  // Stable ordering for deterministic output, on the key each entry paired on.
  const byKey = (a: [string, unknown], b: [string, unknown]): number => a[0].localeCompare(b[0]);
  added.sort(byKey);
  removed.sort(byKey);
  changed.sort(byKey);
  const addedU = added.map(([, u]) => u);
  const removedU = removed.map(([, u]) => u);
  const changedU = changed.map(([, c]) => c);

  const summary = {
    added: addedU.length,
    removed: removedU.length,
    changed: changedU.length,
    unchanged,
  };

  return {
    summary,
    added: addedU,
    removed: removedU,
    changed: changedU,
    text: renderText(summary, addedU, removedU, changedU),
  };
}

function renderText(
  summary: DryRunDiff["summary"],
  added: ProposedUpdate[],
  removed: ProposedUpdate[],
  changed: ChangedUpdate[],
): string {
  if (summary.added === 0 && summary.removed === 0 && summary.changed === 0) {
    return summary.unchanged === 0
      ? "No proposed updates in either report."
      : `No differences. ${summary.unchanged} proposed update${summary.unchanged === 1 ? "" : "s"} unchanged.`;
  }

  const lines: string[] = [];
  lines.push(
    `${summary.added} added · ${summary.removed} removed · ${summary.changed} changed · ${summary.unchanged} unchanged`,
  );

  if (added.length > 0) {
    lines.push("", "Added:");
    for (const u of added) lines.push(`  + ${formatUpdate(u)}`);
  }
  if (removed.length > 0) {
    lines.push("", "Removed:");
    for (const u of removed) lines.push(`  - ${formatUpdate(u)}`);
  }
  if (changed.length > 0) {
    lines.push("", "Changed:");
    for (const c of changed) {
      lines.push(`  ~ ${identityLabel(c)}${c.after.updateType && c.before.updateType === c.after.updateType ? ` [${c.after.updateType}]` : ""}`);
      for (const ch of c.changes) {
        lines.push(`      ${ch.field}: ${formatValue(ch.before)} → ${formatValue(ch.after)}`);
      }
    }
  }
  return lines.join("\n");
}

function identityLabel(u: { manager: string; packageFile: string; depName: string }): string {
  const file = u.packageFile ? ` ${u.packageFile}` : "";
  return `${u.manager}${file} :: ${u.depName}`;
}

function formatUpdate(u: ProposedUpdate): string {
  const target =
    u.newVersion ?? u.newValue ?? "(no target)";
  const current = u.currentVersion ?? u.currentValue;
  const arrow = current ? `${current} → ${target}` : target;
  const type = u.updateType ? ` [${u.updateType}]` : "";
  return `${identityLabel(u)} ${arrow}${type}`;
}

function formatValue(value: unknown): string {
  return value === undefined ? "(unset)" : JSON.stringify(value);
}
