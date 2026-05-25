import { EndpointValidationError, validateEndpoint } from "./endpointValidator.js";

/**
 * Best-effort reachability check for an `endpoint` URL. Used by `check_setup`
 * (when invoked with a `repoPath`) to surface unreachable hosts as a hint
 * *before* the user runs `dry_run` and discovers the failure later.
 *
 * Security invariant: every URL goes through `validateEndpoint` first — same
 * allowlist (`https://`-only, no userinfo, no RFC1918 / loopback / link-local
 * / cloud-metadata addresses) used by `dry_run`, `resolve_config`, and
 * `externalPresetFetcher`. The probe must not become a side channel that
 * bypasses that policy. No credentials are sent on the probe — it's a bare
 * HEAD / fallback GET with no Authorization header.
 */
export interface EndpointProbeResult {
  url: string;
  reachable: boolean;
  status?: number;
  error?: string;
  skipped?: "endpoint-blocked";
}

export async function probeEndpoint(
  url: string,
  timeoutMs = 3000,
): Promise<EndpointProbeResult> {
  try {
    validateEndpoint(url);
  } catch (err) {
    const reason = err instanceof EndpointValidationError ? err.message : String(err);
    return { url, reachable: false, skipped: "endpoint-blocked", error: reason };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let response = await fetch(url, { method: "HEAD", signal: ac.signal });
    if (response.status === 405) {
      response = await fetch(url, { method: "GET", signal: ac.signal });
    }
    return { url, reachable: response.ok || response.status < 500, status: response.status };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { url, reachable: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
