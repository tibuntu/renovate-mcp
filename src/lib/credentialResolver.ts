export interface Credential {
  envVar: string | null;
  token: string | undefined;
  triedVars: string[];
}

/**
 * Resolve a credential by checking each env var name in order and returning
 * the first one that's set. Used by both `resolve_config` (for `github>` /
 * `gitlab>` preset fetches) and `dry_run` (when picking which token to export
 * as `RENOVATE_TOKEN` to the spawned Renovate CLI). Keeping the precedence in
 * one place ensures the two tools cannot drift out of sync.
 */
export function resolveCredential(vars: string[]): Credential {
  for (const envVar of vars) {
    const value = process.env[envVar];
    if (value) return { envVar, token: value, triedVars: vars };
  }
  return { envVar: null, token: undefined, triedVars: vars };
}
