import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export type HostRule = Record<string, unknown>;

/**
 * Write a throwaway Renovate config containing just `{ hostRules: [...] }` to
 * `os.tmpdir()` with mode 0600, and return the absolute path. The caller is
 * responsible for unlinking the file (in a `finally` block) once Renovate has
 * consumed it — we do not keep a reference here.
 *
 * Renovate merges CLI `--config-file` rules with any repo-level `hostRules`
 * (array concatenation, most-specific match wins), so callers can combine
 * per-invocation credentials with whatever the repo itself already declares.
 */
export async function writeHostRulesConfig(hostRules: HostRule[]): Promise<string> {
  const tmpPath = path.join(tmpdir(), `renovate-mcp-hostrules-${randomUUID()}.json`);
  const body = JSON.stringify({ hostRules }, null, 2);
  await fs.writeFile(tmpPath, body, { mode: 0o600 });
  return tmpPath;
}

const SECRET_KEYS = ["token", "password"] as const;

/**
 * Pull the token/password values out of the provided hostRules so callers can
 * scrub them from log output. Usernames are intentionally not treated as
 * secrets — Renovate echoes them in diagnostics and they are not typically
 * sensitive on their own.
 */
export function collectSecrets(hostRules: HostRule[]): string[] {
  const out = new Set<string>();
  for (const rule of hostRules) {
    if (!rule || typeof rule !== "object") continue;
    for (const key of SECRET_KEYS) {
      const value = rule[key];
      if (typeof value === "string" && value.length > 0) {
        out.add(value);
      }
    }
  }
  return [...out];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every literal occurrence of any secret in `text` with `[REDACTED]`.
 * No-op when `secrets` is empty.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  // Sort by length descending so that when one secret is a substring of
  // another, the longer one wins the greedy regex alternation instead of
  // being partially chewed up by the shorter one.
  const alternatives = secrets
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  if (!alternatives.length) return text;
  const pattern = new RegExp(alternatives.join("|"), "g");
  return text.replace(pattern, "[REDACTED]");
}
