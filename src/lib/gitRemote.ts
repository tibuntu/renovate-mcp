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

export type RemoteClassification = "github" | "gitlab" | "self-hosted" | "unknown";
export type SelfHostedFlavor = "github" | "gitlab" | "unknown";

export interface ClassifiedRemote {
  classified: RemoteClassification;
  flavor?: SelfHostedFlavor;
}

export function classifyRemoteHost(host: string): ClassifiedRemote {
  const h = host.toLowerCase();
  if (h === "github.com" || h === "www.github.com") return { classified: "github" };
  if (h === "gitlab.com" || h === "www.gitlab.com") return { classified: "gitlab" };
  // Heuristics for self-hosted: hostname prefix/suffix conventions.
  let flavor: SelfHostedFlavor = "unknown";
  if (/(^|\.)gitlab\./.test(h) || h.startsWith("gitlab-") || h.startsWith("gitlab.")) {
    flavor = "gitlab";
  } else if (/(^|\.)github\./.test(h) || h.startsWith("github-") || h.startsWith("github.")) {
    flavor = "github";
  }
  return { classified: "self-hosted", flavor };
}
