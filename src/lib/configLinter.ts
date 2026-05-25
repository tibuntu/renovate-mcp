import { ALL_MANAGERS, CUSTOM_MANAGERS } from "../data/managers.generated.js";
import { DEPRECATED_KEYS } from "../data/migrations.generated.js";

export type LintRuleId =
  | "dead-regex-missing-slash"
  | "unwrapped-regex"
  | "matchManagers-unknown-name"
  | "deprecated-key"
  | "automerge-without-automerge-type"
  | "empty-extends"
  | "contradictory-disabled-with-package-rules"
  | "package-rule-without-action"
  | "invalid-schedule";

export interface LintFinding {
  ruleId: LintRuleId;
  severity: "error" | "warn";
  path: string;
  value: string;
  message: string;
  suggestion?: string;
}

const REGEX_AWARE_FIELDS = new Set<string>([
  "matchPackageNames",
  "matchDepNames",
  "matchSourceUrls",
  "matchCurrentVersion",
]);

const MANAGER_FIELDS = new Set<string>(["matchManagers", "excludeManagers"]);

const VALID_MANAGER_NAMES: ReadonlySet<string> = new Set([
  ...ALL_MANAGERS,
  ...CUSTOM_MANAGERS.map((m) => `custom.${m}`),
]);

const DEPRECATED_KEY_LOOKUP: ReadonlyMap<string, string> = new Map(
  DEPRECATED_KEYS.map((e) => [e.oldKey, e.newKey]),
);

// Hand-maintained snapshot of keys that count as "actions" on a packageRules entry
// (i.e. keys whose presence means the rule actually *does* something to the matched
// deps). Source of truth: `node_modules/renovate/dist/config/options/index.js` —
// entries whose `parents` array includes `"packageRules"`, plus the broader set of
// inheritable config options Renovate allows inside a packageRules entry
// (groupName, automerge, labels, schedule, …). Reconciled against renovate@43.150.0.
// Bumping the `renovate` devDep should prompt a manual re-check. We deliberately do
// NOT generate this list at build time: per CLAUDE.md, the linter must stay
// independent of the runtime `renovate` import, so this stays a curated snapshot
// — analogous to the other allow-lists under `src/data/`.
//
// Explicitly NOT in this set (kept here as documentation):
//   - `description` (metadata)
//   - every `match*` / `exclude*` key (selectors)
//   - `paths` / `excludePaths` (path-scope selectors)
//   - `matchJsonata`, `matchNewValue`, `matchCurrentAge` etc. (selectors)
//   - `changelogUrl`, `sourceDirectory`, `sourceUrl` (metadata/locator overrides —
//     treated as actions below since they actively override resolved fields)
export const PACKAGE_RULE_ACTION_KEYS: ReadonlySet<string> = new Set([
  "addLabels",
  "additionalBranchPrefix",
  "allowedVersions",
  "assignees",
  "assigneesFromCodeOwners",
  "automerge",
  "automergeSchedule",
  "automergeStrategy",
  "automergeType",
  "branchPrefix",
  "branchTopic",
  "bumpVersion",
  "changelogUrl",
  "commitMessageAction",
  "commitMessageExtra",
  "commitMessagePrefix",
  "commitMessageSuffix",
  "commitMessageTopic",
  "dependencyDashboardApproval",
  "dependencyDashboardLabels",
  "draftPR",
  "enabled",
  "extends",
  "fetchChangeLogs",
  "followTag",
  "groupName",
  "groupSlug",
  "ignoreDeps",
  "ignoreUnstable",
  "keepUpdatedLabel",
  "labels",
  "lockFileMaintenance",
  "milestone",
  "minimumReleaseAge",
  "overrideDatasource",
  "overrideDepName",
  "overridePackageName",
  "pinDigests",
  "platformAutomerge",
  "postUpdateOptions",
  "postUpgradeTasks",
  "prBodyColumns",
  "prBodyDefinitions",
  "prBodyNotes",
  "prBodyTemplate",
  "prCreation",
  "prPriority",
  "prTitle",
  "rangeStrategy",
  "rebaseLabel",
  "rebaseWhen",
  "recreateWhen",
  "registryUrls",
  "replacementName",
  "replacementNameTemplate",
  "replacementVersion",
  "replacementVersionTemplate",
  "reviewers",
  "reviewersFromCodeOwners",
  "schedule",
  "semanticCommitScope",
  "semanticCommitType",
  "separateMajorMinor",
  "separateMinorPatch",
  "separateMultipleMajor",
  "separateMultipleMinor",
  "sourceDirectory",
  "sourceUrl",
  "stopUpdatingLabel",
  "versioning",
  "vulnerabilityAlerts",
]);

const DEPRECATED_KEY_CONTAINERS = ["packageRules", "hostRules", "customManagers"] as const;

// Schedule-validation heuristic. Behavioral source of truth:
//   `node_modules/renovate/dist/workers/repository/update/branch/schedule.js`
// Renovate parses `schedule` strings via `@breejs/later` (a small natural-language
// DSL) with a cron fallback via `croner`. Cron parsing in Renovate REQUIRES the
// minutes field to be exactly `*` — non-`*` minutes are explicitly rejected
// (per the `hasValidSchedule` checks in that file). When parsing fails Renovate
// treats it as "at any time" and logs a warning, which is the silent footgun
// this rule catches.
//
// This is a hand-maintained snapshot — same pattern as PACKAGE_RULE_ACTION_KEYS
// above. We deliberately do NOT import `renovate` or `@breejs/later` at runtime
// (CLAUDE.md invariant), so the anchor-token list is curated from later's
// grammar (https://github.com/breejs/later/blob/master/src/parse/text.js) with
// a deliberate bias toward false negatives over false positives: a non-later
// string that happens to contain one of these anchor tokens gets a free pass,
// but every plausible later-text input will contain at least one of them.

// Special-cased sentinels meaning "no schedule". Renovate treats these as
// always-on.
const SCHEDULE_ANY_TIME: ReadonlySet<string> = new Set(["", "at any time"]);

// Literal phrases Renovate explicitly maps in its `scheduleMappings` table
// (see `schedule.js`). Always accepted regardless of anchor-token matching.
const SCHEDULE_MAPPING_LITERALS: ReadonlySet<string> = new Set([
  "every month",
  "monthly",
]);

// Lowercase tokens. Presence of at least one (whole-word, case-insensitive)
// makes a non-cron string plausibly-later-text. Curated from later's grammar.
const LATER_TEXT_ANCHOR_TOKENS: ReadonlySet<string> = new Set([
  // Time anchors
  "am",
  "pm",
  "noon",
  "midnight",
  "before",
  "after",
  "between",
  // Frequency
  "every",
  "on",
  "at",
  // Day names
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "tues",
  "wed",
  "thu",
  "thur",
  "thurs",
  "fri",
  "sat",
  "sun",
  // Month names (full)
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  // Month abbreviations
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  // Period words
  "day",
  "days",
  "week",
  "weeks",
  "weekday",
  "weekdays",
  "weekend",
  "weekends",
  "month",
  "months",
  "year",
  "years",
  "hour",
  "hours",
  "minute",
  "minutes",
  "morning",
  "evening",
  "night",
]);

// Cron-shape: 5 or 6 whitespace-separated fields, every char in `[0-9*/,\-]`,
// FIRST field is exactly `*` (Renovate explicitly rejects non-`*` minutes).
// 6-field form covers cron variants with a leading seconds field, which
// `croner` accepts.
const SCHEDULE_CRON_SHAPE = /^\*\s+([0-9*/,\-]+\s+){3,4}[0-9*/,\-]+$/;

function isPlausiblySchedule(value: string): boolean {
  if (SCHEDULE_ANY_TIME.has(value)) return true;
  const lower = value.toLowerCase();
  if (SCHEDULE_MAPPING_LITERALS.has(lower)) return true;
  if (SCHEDULE_CRON_SHAPE.test(value)) return true;
  // Anchor-token check: split on any run of non-letter chars, look for any
  // recognized later-grammar token.
  for (const token of lower.split(/[^a-z]+/)) {
    if (token && LATER_TEXT_ANCHOR_TOKENS.has(token)) return true;
  }
  return false;
}

export function lintConfig(config: unknown): LintFinding[] {
  const findings: LintFinding[] = [];
  walk(config, "", findings);
  checkDeprecatedKeys(config, findings);
  checkAutomergeWithoutType(config, findings);
  checkContradictoryDisabled(config, findings);
  checkPackageRuleWithoutAction(config, findings);
  return findings;
}

function isSelectorKey(key: string): boolean {
  if (PACKAGE_RULE_ACTION_KEYS.has(key)) return false;
  return (
    key.startsWith("match") ||
    key.startsWith("exclude") ||
    key === "paths" ||
    key === "excludePaths"
  );
}

function checkPackageRuleWithoutAction(
  config: unknown,
  findings: LintFinding[],
): void {
  if (!isPlainObject(config)) return;
  if (!Array.isArray(config.packageRules)) return;

  config.packageRules.forEach((entry, i) => {
    if (!isPlainObject(entry)) return;
    const keys = Object.keys(entry);
    const selectors: string[] = [];
    let actionCount = 0;
    for (const key of keys) {
      if (PACKAGE_RULE_ACTION_KEYS.has(key)) {
        actionCount += 1;
      } else if (isSelectorKey(key)) {
        selectors.push(key);
      }
    }
    if (selectors.length >= 1 && actionCount === 0) {
      findings.push({
        ruleId: "package-rule-without-action",
        severity: "warn",
        path: `packageRules[${i}]`,
        value: selectors.join(", "),
        message:
          `packageRules[${i}] has selector(s) (${selectors.join(", ")}) but no action keys, so Renovate will match deps and do nothing with them. ` +
          "Add at least one action key (e.g. `enabled`, `groupName`, `automerge`, `addLabels`, `prPriority`, `schedule`, `allowedVersions`, …) " +
          "or remove the entry if it isn't needed. Note: `description` is metadata, and `matchUpdateTypes` / `paths` are selectors — none of them count as actions.",
      });
    }
  });
}

function checkContradictoryDisabled(
  config: unknown,
  findings: LintFinding[],
): void {
  if (!isPlainObject(config)) return;
  if (config.enabled !== false) return;
  if (!Array.isArray(config.packageRules)) return;

  config.packageRules.forEach((entry, i) => {
    if (!isPlainObject(entry)) return;
    if (entry.enabled !== true) return;
    findings.push({
      ruleId: "contradictory-disabled-with-package-rules",
      severity: "error",
      path: `packageRules[${i}].enabled`,
      value: "true",
      message: `Root config has \`enabled: false\`, but \`packageRules[${i}].enabled: true\` tries to re-enable a subset. Renovate does NOT re-enable specific deps from packageRules when the root is disabled — the whole repo stays off. Either remove root \`enabled: false\` and disable deps individually, or remove the packageRule's \`enabled: true\`.`,
      suggestion:
        "Remove root `enabled: false`, OR remove this packageRule's `enabled: true`.",
    });
  });
}

function makeAutomergeFinding(path: string): LintFinding {
  return {
    ruleId: "automerge-without-automerge-type",
    severity: "warn",
    path,
    value: "true",
    message:
      "`automerge: true` is set without `automergeType`. Renovate defaults to `pr` automerge here; set `automergeType` explicitly to `\"pr\"`, `\"branch\"`, or `\"platform\"` to avoid surprises when the default changes.",
    suggestion: 'automergeType: "pr"',
  };
}

function checkAutomergeWithoutType(config: unknown, findings: LintFinding[]): void {
  if (!isPlainObject(config)) return;

  if (config.automerge === true && !("automergeType" in config)) {
    findings.push(makeAutomergeFinding("automerge"));
  }

  const pkgRules = config.packageRules;
  if (Array.isArray(pkgRules)) {
    pkgRules.forEach((entry, i) => {
      if (!isPlainObject(entry)) return;
      if (entry.automerge === true && !("automergeType" in entry)) {
        findings.push(makeAutomergeFinding(`packageRules[${i}].automerge`));
      }
    });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeDeprecatedKeyFinding(
  oldKey: string,
  newKey: string,
  path: string,
): LintFinding {
  return {
    ruleId: "deprecated-key",
    severity: "warn",
    path,
    value: oldKey,
    message: `Key '${oldKey}' is deprecated; Renovate renames it to '${newKey}'. Run migrate_config to auto-apply, or rename manually.`,
    suggestion: newKey,
  };
}

function checkDeprecatedKeys(config: unknown, findings: LintFinding[]): void {
  if (!isPlainObject(config)) return;

  for (const key of Object.keys(config)) {
    const replacement = DEPRECATED_KEY_LOOKUP.get(key);
    if (replacement !== undefined) {
      findings.push(makeDeprecatedKeyFinding(key, replacement, key));
    }
  }

  for (const container of DEPRECATED_KEY_CONTAINERS) {
    const arr = (config as Record<string, unknown>)[container];
    if (!Array.isArray(arr)) continue;
    arr.forEach((entry, i) => {
      if (!isPlainObject(entry)) return;
      for (const key of Object.keys(entry)) {
        const replacement = DEPRECATED_KEY_LOOKUP.get(key);
        if (replacement !== undefined) {
          findings.push(
            makeDeprecatedKeyFinding(key, replacement, `${container}[${i}].${key}`),
          );
        }
      }
    });
  }
}

function walk(node: unknown, pathStr: string, findings: LintFinding[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${pathStr}[${i}]`, findings));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const childPath = pathStr ? `${pathStr}.${key}` : key;
      if (REGEX_AWARE_FIELDS.has(key)) {
        if (Array.isArray(value)) {
          value.forEach((entry, i) => {
            if (typeof entry === "string") {
              checkPattern(entry, `${childPath}[${i}]`, findings);
            }
          });
        } else if (typeof value === "string") {
          checkPattern(value, childPath, findings);
        }
      } else if (key === "extends" && Array.isArray(value) && value.length === 0) {
        findings.push({
          ruleId: "empty-extends",
          severity: "warn",
          path: childPath,
          value: "[]",
          message:
            "`extends: []` is empty. Renovate will inherit no presets here, which is almost always a paste error. Either populate the array (e.g. `[\"config:recommended\"]`) or remove the key entirely.",
        });
      } else if (key === "schedule") {
        if (typeof value === "string") {
          checkSchedule(value, childPath, findings);
        } else if (Array.isArray(value)) {
          value.forEach((entry, i) => {
            if (typeof entry === "string") {
              checkSchedule(entry, `${childPath}[${i}]`, findings);
            }
          });
        }
      } else if (MANAGER_FIELDS.has(key)) {
        if (Array.isArray(value)) {
          value.forEach((entry, i) => {
            if (typeof entry === "string") {
              checkManager(entry, `${childPath}[${i}]`, findings);
            }
          });
        } else if (typeof value === "string") {
          checkManager(value, childPath, findings);
        }
      } else {
        walk(value, childPath, findings);
      }
    }
  }
}

function checkPattern(raw: string, path: string, findings: LintFinding[]): void {
  // `!` is Renovate's exclusion prefix; strip it before checking regex wrapping.
  const stripped = raw.startsWith("!") ? raw.slice(1) : raw;

  // Too short to meaningfully be a /…/ regex or trigger a metachar rule.
  if (stripped.length < 2) return;

  const startsSlash = stripped.startsWith("/");
  const endsSlash = stripped.endsWith("/");

  if (startsSlash !== endsSlash) {
    findings.push({
      ruleId: "dead-regex-missing-slash",
      severity: "error",
      path,
      value: raw,
      message: startsSlash
        ? "Value starts with '/' but does not end with '/'. Renovate will treat this as an exact-match string, not a regex. Add the trailing '/' if a regex match was intended, otherwise remove the leading '/'."
        : "Value ends with '/' but does not start with '/'. Renovate will treat this as an exact-match string, not a regex. Add the leading '/' if a regex match was intended, otherwise remove the trailing '/'.",
    });
    return;
  }

  if (startsSlash && endsSlash) return;

  if (hasStrongRegexSignal(stripped)) {
    findings.push({
      ruleId: "unwrapped-regex",
      severity: "warn",
      path,
      value: raw,
      message: `Value contains regex metacharacters but is not wrapped in '/…/'. Renovate will treat it as an exact-match string. Wrap it as '/${stripped}/' (or '!/${stripped}/' to negate) if a regex match was intended.`,
    });
  }
}

function checkSchedule(value: string, path: string, findings: LintFinding[]): void {
  if (isPlausiblySchedule(value)) return;
  findings.push({
    ruleId: "invalid-schedule",
    severity: "error",
    path,
    value,
    message:
      `'${value}' is not a recognizable Renovate schedule. Schedules must be either ` +
      "later-text (e.g. `\"before 5am every weekday\"`, `\"every weekend\"`) or cron with " +
      "a `*` minutes field (e.g. `\"* 0-3 * * *\"`); Renovate explicitly rejects cron with " +
      "a non-`*` minutes field. Renovate silently falls back to \"at any time\" when " +
      "parsing fails, so this footgun goes undetected at runtime. Check " +
      "https://docs.renovatebot.com/configuration-options/#schedule or use a `schedule:*` " +
      "preset such as `schedule:earlyMondays`.",
  });
}

function checkManager(raw: string, path: string, findings: LintFinding[]): void {
  if (VALID_MANAGER_NAMES.has(raw)) return;

  const suggestion = nearestManager(raw);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
  const finding: LintFinding = {
    ruleId: "matchManagers-unknown-name",
    severity: "error",
    path,
    value: raw,
    message: `'${raw}' is not a known Renovate manager. Renovate will silently apply this rule to zero packages.${hint}`,
  };
  if (suggestion) finding.suggestion = suggestion;
  findings.push(finding);
}

function nearestManager(name: string): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of VALID_MANAGER_NAMES) {
    const d = damerauLevenshtein(name, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Tolerate up to ~30 % of the typed length (min 2) — keeps "nmp" → "npm"
  // but avoids suggesting an unrelated name for something wildly off.
  const threshold = Math.max(2, Math.floor(name.length * 0.3));
  return bestDistance <= threshold ? best : null;
}

// Optimal String Alignment distance: like Levenshtein but counts a single
// adjacent-character transposition (e.g. "nmp" ↔ "npm") as one edit instead
// of two — important for catching common keystroke typos.
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[m]![n]!;
}

function hasStrongRegexSignal(s: string): boolean {
  return (
    /\\[dwsbDWSB]/.test(s) ||
    /\.[+*?]/.test(s) ||
    /\\\./.test(s) ||
    /\(\?[:!=<]/.test(s) ||
    /\[[^\]]+\]/.test(s)
  );
}
