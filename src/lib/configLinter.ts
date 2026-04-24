export type LintRuleId = "dead-regex-missing-slash" | "unwrapped-regex";

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

function hasStrongRegexSignal(s: string): boolean {
  return (
    /\\[dwsbDWSB]/.test(s) ||
    /\.[+*?]/.test(s) ||
    /\\\./.test(s) ||
    /\(\?[:!=<]/.test(s) ||
    /\[[^\]]+\]/.test(s)
  );
}
