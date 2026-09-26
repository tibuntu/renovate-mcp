/**
 * Scan Renovate's log output for signals that a lookup silently failed due to
 * registry auth. Renovate does not always fail loudly when a private registry
 * rejects a request — managers are detected, but the `updates` array comes
 * back empty with no warning on the structured report. This heuristic catches
 * the common cases so the caller can distinguish "no updates available" from
 * "couldn't auth to the registry."
 *
 * We try to parse each line as a Renovate JSON log entry (emitted when
 * LOG_FORMAT=json) and also fall back to plain-text scanning, since some
 * errors surface as uncaught messages on stderr before the JSON logger takes
 * over. Output is deduplicated and capped so this never blows up the caller's
 * context.
 */

import { truncate } from "./util.js";

const AUTH_PATTERNS: RegExp[] = [
  // A bare status code: not glued to other digits, and not a segment of a
  // dotted version like `1.403.0` (a trailing sentence period is still fine).
  /(?<![\d.])(?:401|403)(?!\d|\.\d)/,
  /\bunauthori[sz]ed\b/i,
  /\bauthentication (?:required|failed)\b/i,
  /\brequires authentication\b/i,
  /\binvalid credentials\b/i,
  /\bcould not authenticate\b/i,
  /\baccess denied\b/i,
];

const MAX_MESSAGE_LENGTH = 300;
const MAX_PROBLEMS = 10;

export interface LookupProblem {
  message: string;
  context?: string;
}

function matchesAuthPattern(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

function extractContext(parsed: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const datasource = parsed.datasource;
  const packageName = parsed.packageName ?? parsed.depName;
  const hostname = parsed.hostname ?? parsed.host ?? parsed.url;
  if (typeof datasource === "string") parts.push(`datasource=${datasource}`);
  if (typeof packageName === "string") parts.push(`package=${packageName}`);
  if (typeof hostname === "string") parts.push(`host=${hostname}`);
  return parts.length ? parts.join(" ") : undefined;
}

export function detectLookupProblems(log: string): LookupProblem[] {
  const problems: LookupProblem[] = [];
  const seen = new Set<string>();

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (problems.length >= MAX_PROBLEMS) break;

    let parsed: Record<string, unknown> | null = null;
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") {
          parsed = obj as Record<string, unknown>;
        }
      } catch {
        // Fall through to plain-text handling.
      }
    }

    let message: string;
    let context: string | undefined;

    if (parsed) {
      const msg = typeof parsed.msg === "string" ? parsed.msg : "";
      const err = parsed.err as Record<string, unknown> | undefined;
      const errMsg = err && typeof err.message === "string" ? err.message : "";
      const combined = [msg, errMsg].filter(Boolean).join(" — ");
      if (!combined || !matchesAuthPattern(combined)) continue;
      message = truncate(combined, MAX_MESSAGE_LENGTH);
      context = extractContext(parsed);
    } else {
      if (!matchesAuthPattern(line)) continue;
      message = truncate(line, MAX_MESSAGE_LENGTH);
    }

    const dedupeKey = context ? `${context}::${message}` : message;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    problems.push(context ? { message, context } : { message });
  }

  return problems;
}
