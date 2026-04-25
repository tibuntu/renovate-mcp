import { ALL_MANAGERS, CUSTOM_MANAGERS } from "../data/managers.generated.js";

export type LintRuleId =
  | "dead-regex-missing-slash"
  | "unwrapped-regex"
  | "matchManagers-unknown-name";

export interface LintFinding {
  ruleId: LintRuleId;
  path: string;
  value: string;
  message: string;
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

export function lintConfig(config: unknown): LintFinding[] {
  const findings: LintFinding[] = [];
  walk(config, "", findings);
  return findings;
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
      path,
      value: raw,
      message: `Value contains regex metacharacters but is not wrapped in '/…/'. Renovate will treat it as an exact-match string. Wrap it as '/${stripped}/' (or '!/${stripped}/' to negate) if a regex match was intended.`,
    });
  }
}

function checkManager(raw: string, path: string, findings: LintFinding[]): void {
  if (VALID_MANAGER_NAMES.has(raw)) return;

  const suggestion = nearestManager(raw);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
  findings.push({
    ruleId: "matchManagers-unknown-name",
    path,
    value: raw,
    message: `'${raw}' is not a known Renovate manager. Renovate will silently apply this rule to zero packages.${hint}`,
  });
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
