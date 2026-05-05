/**
 * Detect Renovate runtime warnings emitted to stderr that callers benefit from
 * knowing about even though Renovate itself keeps running. Currently the only
 * detected condition is the RE2 native-module dlopen failure: when the bundled
 * `re2.node` was compiled against a different Node ABI than the one currently
 * running, Renovate logs a single WARN and silently falls back to JavaScript
 * `RegExp`. The fallback is functional but significantly slower for
 * regex-heavy operations (custom managers, validation, lookups), and the
 * degradation is otherwise invisible to MCP callers.
 *
 * Mirrors the parsing pattern in `lookupProblems.ts`: line-by-line scan,
 * try-JSON-then-plain-text per line, dedupe, and cap the output. We also keep
 * the parser narrow on purpose — Renovate emits many benign WARNs during
 * normal runs (preset deprecations, etc.) and a generic capture would leak
 * them into our responses.
 */

export type RuntimeWarningKind = "re2-unusable";

export interface RuntimeWarning {
  kind: RuntimeWarningKind;
  message: string;
  detail?: string;
  fix: string;
}

const MAX_DETAIL_LENGTH = 300;
const MAX_WARNINGS = 10;

const RE2_FIX_HINT =
  "The RE2 native module bundled with Renovate failed to load (likely after a Node version upgrade). Renovate is falling back to JavaScript `RegExp`, which is significantly slower for regex-heavy operations. To restore vectorized regex: `cd $(npm root -g)/renovate && npm rebuild re2`, or reinstall Renovate (`npm i -g renovate`). If `RENOVATE_BIN` points at a project-local install, run `npm rebuild re2` in that project instead.";

const RE2_MESSAGE = "Renovate's RE2 native module is unusable; falling back to JavaScript `RegExp` (slower).";

function truncate(s: string): string {
  if (s.length <= MAX_DETAIL_LENGTH) return s;
  return `${s.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

function isRe2DlopenFailure(err: unknown): { detail?: string } | null {
  if (!err || typeof err !== "object") return null;
  const obj = err as Record<string, unknown>;
  const code = typeof obj.code === "string" ? obj.code : undefined;
  const message = typeof obj.message === "string" ? obj.message : undefined;
  if (code !== "ERR_DLOPEN_FAILED") return null;
  if (!message || !/re2\.node/.test(message)) return null;
  return { detail: truncate(message) };
}

export function detectRuntimeWarnings(stderr: string): RuntimeWarning[] {
  if (!stderr) return [];

  const warnings: RuntimeWarning[] = [];
  const seen = new Set<RuntimeWarningKind>();

  const pushRe2 = (detail?: string): void => {
    if (seen.has("re2-unusable")) return;
    if (warnings.length >= MAX_WARNINGS) return;
    seen.add("re2-unusable");
    const w: RuntimeWarning = { kind: "re2-unusable", message: RE2_MESSAGE, fix: RE2_FIX_HINT };
    if (detail) w.detail = detail;
    warnings.push(w);
  };

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (warnings.length >= MAX_WARNINGS) break;

    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") {
          const msg = typeof parsed.msg === "string" ? parsed.msg : "";
          if (msg.includes("RE2 not usable")) {
            const detail =
              parsed.err && typeof parsed.err === "object" && parsed.err !== null
                ? typeof (parsed.err as Record<string, unknown>).message === "string"
                  ? truncate((parsed.err as Record<string, unknown>).message as string)
                  : undefined
                : undefined;
            pushRe2(detail);
            continue;
          }
          const re2Err = isRe2DlopenFailure(parsed.err);
          if (re2Err) {
            pushRe2(re2Err.detail);
            continue;
          }
        }
      } catch {
        // fall through to plain-text matching below
      }
    }

    if (/\bRE2 not usable\b/.test(line)) {
      pushRe2();
      continue;
    }
    if (/\bERR_DLOPEN_FAILED\b/.test(line) && /re2\.node/.test(line)) {
      pushRe2(truncate(line));
      continue;
    }
  }

  return warnings;
}

export function dedupeRuntimeWarnings(warnings: RuntimeWarning[]): RuntimeWarning[] {
  const seen = new Set<RuntimeWarningKind>();
  const out: RuntimeWarning[] = [];
  for (const w of warnings) {
    if (seen.has(w.kind)) continue;
    seen.add(w.kind);
    out.push(w);
  }
  return out;
}
