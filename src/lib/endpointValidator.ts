import { BlockList, isIP } from "node:net";

/**
 * Validate a user-provided `endpoint` URL before any network call attaches
 * auth headers or before it is forwarded to the Renovate child as
 * `--endpoint=`. The check is intentionally string-level (no DNS): it
 * refuses non-https schemes, missing/userinfo hosts, and any RFC 1918 /
 * loopback / link-local literal. The point is to make a prompt-injected
 * `endpoint` value unable to coerce a token-bearing request to an
 * attacker-controlled or internal-only address.
 *
 * Returns the user-facing refusal reason, or `null` when the endpoint is
 * acceptable. Call sites map the string to their own error shape
 * (`{ ok: false, reason }`, `isError: true`, etc.).
 */

/**
 * Display form for every refusal message: userinfo (everything between the
 * `//` and the last `@` before the path/query/fragment, mirroring WHATWG
 * authority parsing) becomes `<redacted>@`. String-level so it also covers
 * input that `new URL()` rejects. Over-redacts on exotic non-URL input, which
 * is the safe direction — these messages land in logs and tool output.
 */
function redactUserinfo(endpoint: string): string {
  return endpoint.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/?#]*@/i, "$1<redacted>@");
}

// Private, loopback, link-local (incl. cloud metadata) and unique-local
// ranges. `BlockList` also checks an IPv6 literal's IPv4-mapped form against
// the IPv4 rules, so `::ffff:10.0.0.1` is covered by 10/8.
const PRIVATE_RANGES = new BlockList();
PRIVATE_RANGES.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
PRIVATE_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_RANGES.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
PRIVATE_RANGES.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (incl. cloud metadata)
PRIVATE_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_RANGES.addSubnet("fc00::", 7, "ipv6"); // unique-local
PRIVATE_RANGES.addSubnet("fe80::", 10, "ipv6"); // link-local

export function validateEndpoint(endpoint: string): string | null {
  const shown = redactUserinfo(endpoint);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `Invalid endpoint \`${shown}\`: not a parseable URL.`;
  }
  if (url.protocol !== "https:") {
    return (
      `Invalid endpoint \`${shown}\`: protocol must be https: (refused ${url.protocol}). ` +
      "Plain http would expose the auth token in cleartext; non-network schemes are not endpoints."
    );
  }
  if (!url.hostname) {
    return `Invalid endpoint \`${shown}\`: host is empty.`;
  }
  if (url.username || url.password) {
    return `Invalid endpoint \`${shown}\`: userinfo (\`user:password@host\`) is not allowed — it can mask the real authority and override credentials.`;
  }
  const host = stripIpv6Brackets(url.hostname).toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    return (
      `Invalid endpoint \`${shown}\`: host \`${host}\` is in a private, loopback, or link-local range. ` +
      "Refused to prevent SSRF and accidental exposure of the attached auth token to internal services. " +
      "If you need a self-hosted GitHub/GitLab, use its public-DNS https URL."
    );
  }
  return null;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isPrivateOrLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // Anything starting with `::` is in the reserved ::/8 block: loopback (::1),
  // unspecified (::), IPv4-mapped (::ffff:*), and various deprecated ranges.
  // None are legitimate public endpoints. Kept as a prefix check rather than a
  // `::/8` BlockList rule, because that rule would also match every IPv4
  // address through its mapped form.
  if (host.startsWith("::")) return true;
  const family = isIP(host);
  return family !== 0 && PRIVATE_RANGES.check(host, family === 6 ? "ipv6" : "ipv4");
}
