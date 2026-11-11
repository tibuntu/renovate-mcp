import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeConfig } from "./configWriter.js";
import { REPO_COPY_MAX_BYTES, REPO_COPY_MAX_FILES } from "./inputLimits.js";
import { listRepoFiles } from "./pathSelection.js";

/**
 * `dry_run`'s temporary repository copy for local-preset flattening
 * (ADR-0009). The copy holds the files Renovate's local platform would list
 * (`git ls-files`, else every file), so the spawned Renovate sees the same
 * tree with the flattened config written in. The original is only read.
 * Files Renovate reads from disk without listing them (an untracked or
 * gitignored `.npmrc`) are not in a git-listed copy.
 */

export type CopyResult =
  | { ok: true; dir: string; source: "git" | "walk"; warnings: string[] }
  | { ok: false; reason: string };

export interface CopyLimits {
  maxFiles?: number;
  maxBytes?: number;
}

const COPY_CONCURRENCY = 32;

const isInside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

type Entry = { rel: string; kind: "file"; size: number } | { rel: string; kind: "symlink"; target: string };

/** Run `fn` over `items`, at most COPY_CONCURRENCY at a time. */
async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += COPY_CONCURRENCY) {
    // allSettled: on a failure the whole batch has stopped before the caller
    // removes the copy, so nothing is still writing into it.
    const results = await Promise.allSettled(items.slice(i, i + COPY_CONCURRENCY).map(fn));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}

/**
 * Copy `repoPath` into a fresh `mkdtemp` directory (mode 0700, realpath, so
 * Renovate's own view of its cwd matches). Never copies `.git`; skips paths
 * that no longer exist, directories (gitlinks), files whose directory
 * resolves outside the repo, and relative symlinks pointing outside it (with
 * a warning). Absolute symlinks into the repo are rewritten as relative links
 * to the same place inside the copy; other symlinks are recreated verbatim. Refuses before copying
 * when the listing or the lstat sum is over the caps, and removes a partial
 * copy when copying fails.
 */
export async function copyRepo(repoPath: string, limits: CopyLimits = {}): Promise<CopyResult> {
  const maxFiles = limits.maxFiles ?? REPO_COPY_MAX_FILES;
  const maxBytes = limits.maxBytes ?? REPO_COPY_MAX_BYTES;
  const realRepo = await fs.realpath(repoPath);
  const givenRepo = path.resolve(repoPath);
  const { files, source } = await listRepoFiles(realRepo);
  const listed = files.filter((rel) => !rel.split("/").includes(".git"));
  if (listed.length > maxFiles) {
    return {
      ok: false,
      reason: `The repository has ${listed.length} files to copy, over the limit of ${maxFiles} files for dry_run's temporary copy.`,
    };
  }

  const warnings: string[] = [];
  const parents = new Map<string, Promise<string | null>>();
  const realParent = (dir: string) => {
    if (!parents.has(dir)) parents.set(dir, fs.realpath(dir).catch(() => null));
    return parents.get(dir)!;
  };
  const entries: Entry[] = [];
  await eachLimited(listed, async (rel) => {
    const abs = path.join(realRepo, rel);
    const parent = await realParent(path.dirname(abs));
    if (parent === null) return;
    if (!isInside(parent, realRepo)) {
      warnings.push(`Skipped \`${rel}\` in the temporary copy: its directory resolves outside the repository.`);
      return;
    }
    const st = await fs.lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) {
      let target = await fs.readlink(abs);
      if (!path.isAbsolute(target) && !isInside(path.resolve(parent, target), realRepo)) {
        warnings.push(`Skipped \`${rel}\` in the temporary copy: it is a relative symlink pointing outside the repository.`);
        return;
      }
      // An absolute link into the repo would lead the run back into repoPath:
      // point it at the same place inside the copy, relative to the link.
      const root = [realRepo, givenRepo].find((r) => path.isAbsolute(target) && isInside(target, r));
      if (root) target = path.relative(path.dirname(path.join(root, rel)), target) || ".";
      entries.push({ rel, kind: "symlink", target });
    } else if (st?.isFile()) {
      entries.push({ rel, kind: "file", size: st.size });
    }
  });
  const bytes = entries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0);
  if (bytes > maxBytes) {
    return {
      ok: false,
      reason: `The repository has ${bytes} bytes to copy, over the limit of ${maxBytes} bytes for dry_run's temporary copy.`,
    };
  }

  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "renovate-mcp-dryrun-")));
  try {
    await eachLimited(entries, async (entry) => {
      const dest = path.join(dir, entry.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (entry.kind === "symlink") await fs.symlink(entry.target, dest);
      else await fs.copyFile(path.join(realRepo, entry.rel), dest, constants.COPYFILE_FICLONE);
    });
  } catch (err) {
    await removeRepoCopy(dir);
    return { ok: false, reason: `Could not copy the repository for dry_run's temporary copy: ${(err as Error).message}` };
  }
  // ponytail: only the root `.npmrc` is checked. Renovate reads other
  // untracked files from disk too (docs/tools.md lists the limit); warn per
  // file when one of them turns out to matter.
  if (source === "git" && !listed.includes(".npmrc") && (await fs.stat(path.join(realRepo, ".npmrc")).catch(() => null))) {
    warnings.push(
      "`.npmrc` is not tracked by git, so it is not in the temporary copy this run uses: npm lookups run without its registries and credentials and may report no updates. Pass the credentials as `hostRules` or set them on the MCP server instead.",
    );
  }
  warnings.sort();
  return { ok: true, dir, source, warnings };
}

/**
 * Write the flattened config at `relPath` inside the copy `dir`. The parent
 * directory must resolve inside the copy (a symlinked directory could point
 * anywhere). The existing entry is unlinked first, so a symlinked config is
 * replaced, never written through: other configs get fresh JSON bytes, and
 * `package.json` gets its `renovate` key round-tripped with the siblings kept.
 */
export async function writeFlattenedConfig(
  dir: string,
  relPath: string,
  config: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const target = path.join(dir, relPath);
  const parent = await fs.realpath(path.dirname(target)).catch(() => null);
  if (parent === null || !isInside(parent, await fs.realpath(dir))) {
    return {
      ok: false,
      reason: `Refusing to write the flattened config: the directory of \`${relPath}\` is missing or resolves outside the temporary copy.`,
    };
  }
  const fail = (why: string) => ({ ok: false as const, reason: `Could not write the flattened config into \`${relPath}\`: ${why}.` });
  try {
    const existing = path.basename(relPath) === "package.json" ? await fs.readFile(target, "utf8") : undefined;
    const serialized = serializeConfig({ targetPath: target, nextConfig: config, existing });
    if ("refuse" in serialized) return fail(serialized.reason);
    await fs.rm(target, { force: true });
    await fs.writeFile(target, serialized.bytes, { flag: "wx" });
  } catch (err) {
    // The caller's catch would report it as a missing Renovate binary.
    return fail((err as Error).message);
  }
  return { ok: true };
}

/** Remove a copy made by `copyRepo`; a missing directory is fine. */
export async function removeRepoCopy(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
