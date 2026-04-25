/**
 * Validate a user-provided `endpoint` URL before any network call attaches
 * auth headers or before it is forwarded to the Renovate child as
 * `--endpoint=`. The check is intentionally string-level (no DNS): it
 * refuses non-https schemes, missing/userinfo hosts, and any RFC 1918 /
 * loopback / link-local literal. The point is to make a prompt-injected
 * `endpoint` value unable to coerce a token-bearing request to an
 * attacker-controlled or internal-only address.
 *
 * Throws `EndpointValidationError` with a user-facing reason on rejection.
 * Call sites map that to their own error shape (`{ ok: false, reason }`,
 * `isError: true`, etc.).
 */
export class EndpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointValidationError";
  }
}

export function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointValidationError(
      `Invalid endpoint \`${endpoint}\`: not a parseable URL.`,
    );
  }
  if (url.protocol !== "https:") {
    throw new EndpointValidationError(
      `Invalid endpoint \`${endpoint}\`: protocol must be https: (refused ${url.protocol}). ` +
        "Plain http would expose the auth token in cleartext; non-network schemes are not endpoints.",
    );
  }
  if (!url.hostname) {
    throw new EndpointValidationError(
      `Invalid endpoint \`${endpoint}\`: host is empty.`,
    );
  }
  if (url.username || url.password) {
    throw new EndpointValidationError(
      `Invalid endpoint \`${endpoint}\`: userinfo (\`user:password@host\`) is not allowed — it can mask the real authority and override credentials.`,
    );
  }
  const host = stripIpv6Brackets(url.hostname).toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    throw new EndpointValidationError(
      `Invalid endpoint \`${endpoint}\`: host \`${host}\` is in a private, loopback, or link-local range. ` +
        "Refused to prevent SSRF and accidental exposure of the attached auth token to internal services. " +
        "If you need a self-hosted GitHub/GitLab, use its public-DNS https URL.",
    );
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isPrivateOrLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIpv4DottedQuad(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

function isIpv4DottedQuad(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

function isPrivateIpv6(addr: string): boolean {
  // Anything starting with `::` is in the reserved ::/8 block: loopback (::1),
  // unspecified (::), IPv4-mapped (::ffff:*), and various deprecated ranges.
  // None are legitimate public endpoints, and Node's URL parser may normalise
  // ::ffff:127.0.0.1 to ::ffff:7f00:1, so a literal-by-literal check is brittle.
  if (addr.startsWith("::")) return true;
  // First-hextet checks: fc00::/7 (unique-local) and fe80::/10 (link-local).
  const firstColon = addr.indexOf(":");
  if (firstColon <= 0) return false;
  const firstHextet = addr.slice(0, firstColon);
  const value = Number.parseInt(firstHextet, 16);
  if (!Number.isFinite(value)) return false;
  if (value >= 0xfc00 && value <= 0xfdff) return true; // fc00::/7
  if (value >= 0xfe80 && value <= 0xfebf) return true; // fe80::/10
  return false;
}
