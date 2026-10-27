import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Parsed origin remote URL. Both SSH (`git@host:owner/repo.git`) and HTTPS
 * (`https://host/owner/repo.git`) forms are supported; nested GitLab subgroup
 * paths are preserved verbatim in `owner` (the leading path segments) so
 * `parseRemoteUrl("git@gitlab.example.com:group/sub/repo.git")` yields
 * `{ host: "gitlab.example.com", owner: "group/sub", repo: "repo" }`.
 */
export interface ParsedRemote {
  host: string;
  scheme: "ssh" | "https" | "git";
  owner?: string;
  repo?: string;
}

const SSH_RE = /^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/]+(.+?)(?:\.git)?\/?$/;

export function parseRemoteUrl(url: string): ParsedRemote | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (/^(https?|git|ssh):\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      return null;
    }
    const scheme: ParsedRemote["scheme"] =
      u.protocol === "git:" ? "git" : u.protocol === "ssh:" ? "ssh" : "https";
    const pathname = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
    const segments = pathname.split("/").filter(Boolean);
    const repo = segments.length ? segments[segments.length - 1] : undefined;
    const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;
    return {
      host: u.hostname.toLowerCase(),
      scheme,
      owner,
      repo,
    };
  }

  const m = SSH_RE.exec(trimmed);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = rest.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const repo = segments[segments.length - 1];
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;
  return { host, scheme: "ssh", owner, repo };
}

/**
 * Read the `[remote "origin"] url = …` field from a repo's `.git/config`
 * without spawning `git`. Returns `null` for non-git directories, missing
 * config, missing origin remote, or unreadable files (no exceptions thrown).
 */
export async function readOriginRemote(repoPath: string): Promise<string | null> {
  const configPath = path.join(repoPath, ".git", "config");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  return parseGitConfigOriginUrl(raw);
}

export function parseGitConfigOriginUrl(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let inOrigin = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]\s*$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (key !== "url") continue;
    const value = line.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * Git platforms this server knows how to talk to: `resolve_config` can fetch
 * presets from each over HTTPS, and `check_setup` classifies origin hosts
 * against the same list so its token hints line up with the fetcher.
 */
export const HOSTED_PLATFORMS = ["github", "gitlab", "gitea", "forgejo", "bitbucket"] as const;
export type HostedPlatform = (typeof HOSTED_PLATFORMS)[number];

export type RemoteClassification = HostedPlatform | "self-hosted" | "unknown";
export type SelfHostedFlavor = "github" | "gitlab" | "gitea" | "forgejo" | "unknown";

export interface ClassifiedRemote {
  classified: RemoteClassification;
  flavor?: SelfHostedFlavor;
}

const HOSTED_BY_HOSTNAME: Record<string, HostedPlatform> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "gitea.com": "gitea",
  "codeberg.org": "forgejo",
  "code.forgejo.org": "forgejo",
};

// Self-hosted flavours we can infer from hostname conventions. Bitbucket is
// deliberately absent: a self-hosted Bitbucket is Server/Data Center, whose
// API differs from the Cloud one the preset fetcher speaks.
const SELF_HOSTED_FLAVORS = ["gitlab", "github", "gitea", "forgejo"] as const;

export function classifyRemoteHost(host: string): ClassifiedRemote {
  const h = host.toLowerCase();
  const hosted = HOSTED_BY_HOSTNAME[h];
  if (hosted) return { classified: hosted };
  // Heuristics for self-hosted: hostname prefix/suffix conventions.
  const flavor: SelfHostedFlavor =
    SELF_HOSTED_FLAVORS.find((name) => new RegExp(`(^|\\.)${name}[.-]`).test(h)) ?? "unknown";
  return { classified: "self-hosted", flavor };
}
