import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

export type HostRule = Record<string, unknown>;

/**
 * Write a throwaway Renovate config containing just `{ hostRules: [...] }` and
 * return its absolute path. The file sits alone in a fresh `mkdtemp`
 * directory (mode 0700) under `os.tmpdir()` and is created with `wx` and mode
 * 0600: it holds env tokens on most runs, so no other local user may read it
 * or plant a file at the path first. The caller removes it with
 * `removeHostRulesConfig` (in a `finally` block) once Renovate has consumed it.
 *
 * The caller points Renovate at this file via the `RENOVATE_CONFIG_FILE` (or
 * `RENOVATE_ADDITIONAL_CONFIG_FILE`) env var, not a CLI flag — `--config-file`
 * is not a real Renovate option. Renovate concatenates its rules with any
 * other `hostRules`, so callers can combine per-invocation credentials with
 * whatever the repo itself already declares.
 */
export async function writeHostRulesConfig(hostRules: HostRule[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "renovate-mcp-hostrules-"));
  const tmpPath = path.join(dir, "config.json");
  await fs.writeFile(tmpPath, JSON.stringify({ hostRules }, null, 2), { flag: "wx", mode: 0o600 });
  return tmpPath;
}

/** Remove a file written by `writeHostRulesConfig` together with its directory. */
export async function removeHostRulesConfig(filePath: string): Promise<void> {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true });
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

/**
 * Secrets shorter than this are not scrubbed: redacting a 1-char "token"
 * would blank every occurrence of that character in the log.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Replace every literal occurrence of any secret (of at least
 * MIN_SECRET_LENGTH characters) in `text` with `[REDACTED]`. No-op when
 * `secrets` is empty.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  // Sort by length descending so that when one secret is a substring of
  // another, the longer one wins the greedy regex alternation instead of
  // being partially chewed up by the shorter one. Each secret is also matched
  // in its `encodeURIComponent` form so a token that ends up embedded in a URL
  // (e.g. as a query parameter in a redirect Renovate logs) still gets
  // redacted; when a secret has no encodable characters, the two forms
  // collapse and the dedup below drops the duplicate.
  const alternatives = [
    ...new Set(
      secrets
        .filter((s) => s.length >= MIN_SECRET_LENGTH)
        .flatMap((s) => [s, encodeURIComponent(s)]),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((s) => RegExp.escape(s));
  if (!alternatives.length) return text;
  const pattern = new RegExp(alternatives.join("|"), "g");
  return text.replace(pattern, "[REDACTED]");
}
