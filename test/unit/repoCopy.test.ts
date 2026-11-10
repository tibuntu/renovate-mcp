import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyRepo, removeRepoCopy, writeFlattenedConfig } from "../../src/lib/repoCopy.js";
import { REPO_COPY_MAX_BYTES, REPO_COPY_MAX_FILES } from "../../src/lib/inputLimits.js";

let root: string;
let repo: string;
let outside: string;
let tmp: string;
const copies: string[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rmcp-repocopy-")));
  repo = path.join(root, "repo");
  outside = path.join(root, "outside");
  tmp = path.join(root, "tmp");
  await Promise.all([mkdir(repo), mkdir(outside), mkdir(tmp)]);
  await writeFile(path.join(outside, "secret.json"), '{"outside": true}\n');
  // os.tmpdir() reads TMPDIR on every call: copies land where the test can see them.
  vi.stubEnv("TMPDIR", tmp);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of copies.splice(0)) await removeRepoCopy(dir);
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content = `${rel}\n`): Promise<void> {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), content);
}

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
}

/** Path -> content hash (or link target) of every entry under `dir`, `.git` included. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, abs);
    if (e.isSymbolicLink()) out[rel] = `-> ${await readlink(abs)}`;
    else if (e.isFile()) out[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
    else out[rel] = "dir";
  }
  return out;
}

async function copy(limits?: { maxFiles?: number; maxBytes?: number }) {
  const res = await copyRepo(repo, limits);
  if (res.ok) copies.push(res.dir);
  return res;
}

describe("copyRepo", () => {
  it("defaults its caps to the inputLimits constants", () => {
    expect(REPO_COPY_MAX_FILES).toBe(50_000);
    expect(REPO_COPY_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it("copies the tracked files of a git repo into a fresh 0700 temp dir and leaves the original byte-identical", async () => {
    await put("renovate.json", '{"extends": ["local>acme/widgets"]}\n');
    await put("pkg/package.json", '{"name": "x"}\n');
    await put("gone.txt");
    await put(".gitignore", "ignored.txt\n");
    await symlink("pkg/package.json", path.join(repo, "inside-link"));
    await symlink(path.join(outside, "secret.json"), path.join(repo, "abs-link"));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    await rm(path.join(repo, "gone.txt"));
    await put("untracked.txt");
    await put("ignored.txt");
    const before = await snapshot(repo);

    const res = await copy();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.source).toBe("git");
    expect(res.warnings).toEqual([]);
    expect(path.dirname(res.dir)).toBe(tmp);
    expect(path.basename(res.dir)).toMatch(/^renovate-mcp-dryrun-/);
    expect((await stat(res.dir)).mode & 0o777).toBe(0o700);
    expect(Object.keys(await snapshot(res.dir)).sort()).toEqual(
      [".gitignore", "abs-link", "inside-link", "pkg", "pkg/package.json", "renovate.json"].sort(),
    );
    expect(await readFile(path.join(res.dir, "renovate.json"), "utf8")).toBe('{"extends": ["local>acme/widgets"]}\n');
    // Symlinks are recreated verbatim.
    expect(await readlink(path.join(res.dir, "inside-link"))).toBe("pkg/package.json");
    expect(await readlink(path.join(res.dir, "abs-link"))).toBe(path.join(outside, "secret.json"));
    expect(await snapshot(repo)).toEqual(before);
  });

  it("walks every file of a non-git directory except .git, node_modules included", async () => {
    await put("renovate.json", "{}\n");
    await put("node_modules/dep/package.json");
    await put(".git/config", "[core]\n");

    const res = await copy();

    expect(res.ok && res.source).toBe("walk");
    if (!res.ok) return;
    expect(Object.keys(await snapshot(res.dir)).sort()).toEqual(
      ["node_modules", "node_modules/dep", "node_modules/dep/package.json", "renovate.json"].sort(),
    );
  });

  it("rewrites an absolute symlink into the repo to the same place inside the copy, never back into repoPath", async () => {
    await put("renovate.json", "{}\n");
    await put("pkg/package.json", '{"name": "x"}\n');
    await symlink(path.join(repo, "pkg/package.json"), path.join(repo, "abs-inside"));
    await symlink(path.join(repo, "pkg"), path.join(repo, "nested-abs-dir"));
    await mkdir(path.join(repo, "deep"));
    await symlink(path.join(repo, "renovate.json"), path.join(repo, "deep/abs-config"));
    await symlink(repo, path.join(repo, "self"));
    git("init", "-q");
    git("add", "-A");
    const before = await snapshot(repo);

    const res = await copy();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await readlink(path.join(res.dir, "abs-inside"))).toBe("pkg/package.json");
    expect(await readlink(path.join(res.dir, "nested-abs-dir"))).toBe("pkg");
    expect(await readlink(path.join(res.dir, "deep/abs-config"))).toBe("../renovate.json");
    expect(await readlink(path.join(res.dir, "self"))).toBe(".");
    expect(await realpath(path.join(res.dir, "abs-inside"))).toBe(path.join(res.dir, "pkg/package.json"));
    expect(res.warnings).toEqual([]);
    expect(await snapshot(repo)).toEqual(before);
  });

  it("rewrites an absolute symlink that names the repo through a symlinked path", async () => {
    const alias = path.join(root, "alias");
    await symlink(repo, alias);
    await put("renovate.json", "{}\n");
    await symlink(path.join(alias, "renovate.json"), path.join(repo, "via-alias"));

    const res = await copyRepo(alias);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    copies.push(res.dir);
    expect(await readlink(path.join(res.dir, "via-alias"))).toBe("renovate.json");
  });

  it("skips a relative symlink that escapes the repo, with a warning", async () => {
    await put("renovate.json", "{}\n");
    await symlink("../outside/secret.json", path.join(repo, "escape.json"));
    await symlink("../outside/secret.json", path.join(repo, "renovate.json5"));

    const res = await copy();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(await snapshot(res.dir))).toEqual(["renovate.json"]);
    expect(res.warnings).toEqual([
      "Skipped `escape.json` in the temporary copy: it is a relative symlink pointing outside the repository.",
      "Skipped `renovate.json5` in the temporary copy: it is a relative symlink pointing outside the repository.",
    ]);
  });

  it.each([
    ["absolute", () => path.join(outside)],
    ["relative", () => "../outside"],
  ])("skips tracked files under a parent directory replaced by an %s symlink to outside the repo", async (_kind, target) => {
    await put("sub/secret.json", '{"inside": true}\n');
    await put("renovate.json", "{}\n");
    git("init", "-q");
    git("add", "-A");
    await rm(path.join(repo, "sub"), { recursive: true });
    await symlink(target(), path.join(repo, "sub"));

    const res = await copy();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(await snapshot(res.dir))).toEqual(["renovate.json"]);
    expect(res.warnings).toEqual([
      "Skipped `sub/secret.json` in the temporary copy: its directory resolves outside the repository.",
    ]);
  });

  it("skips gitlinks (submodule directories) and paths under a missing directory", async () => {
    await put("renovate.json", "{}\n");
    await put("vendor/lib/file.txt");
    git("init", "-q");
    git("add", "renovate.json", "vendor");
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},submodule`);
    await mkdir(path.join(repo, "submodule"));
    await rm(path.join(repo, "vendor"), { recursive: true });

    const res = await copy();

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(await snapshot(res.dir))).toEqual(["renovate.json"]);
  });

  it("refuses before copying when the file count exceeds the cap", async () => {
    await put("a.txt");
    await put("b.txt");
    const res = await copy({ maxFiles: 1 });
    expect(res).toEqual({
      ok: false,
      reason: expect.stringMatching(/2 files .* limit of 1 /),
    });
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses before copying when the total size exceeds the cap", async () => {
    await put("a.txt", "12345");
    await put("b.txt", "12345");
    const res = await copy({ maxBytes: 9 });
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/10 bytes .* limit of 9 bytes/) });
    expect(await readdir(tmp)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("removes the partial copy when copying fails", async () => {
    await put("renovate.json", "{}\n");
    await put("unreadable.txt");
    await chmod(path.join(repo, "unreadable.txt"), 0o000);
    try {
      const res = await copy();
      expect(res).toEqual({ ok: false, reason: expect.stringMatching(/^Could not copy the repository .*EACCES/) });
      expect(await readdir(tmp)).toEqual([]);
    } finally {
      await chmod(path.join(repo, "unreadable.txt"), 0o644);
    }
  });
});

describe("writeFlattenedConfig", () => {
  const flattened = { extends: [":semanticCommits"], labels: ["flat"] };
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmp, "copy-")));
  });

  it("replaces the config with fresh JSON bytes, JSON5-only syntax included", async () => {
    await writeFile(path.join(dir, "renovate.json5"), "{ unquoted: 'json5', }\n");
    expect(await writeFlattenedConfig(dir, "renovate.json5", flattened)).toEqual({ ok: true });
    expect(await readFile(path.join(dir, "renovate.json5"), "utf8")).toBe(JSON.stringify(flattened, null, 2) + "\n");
  });

  it("writes a config that is absent in the copy", async () => {
    await mkdir(path.join(dir, ".github"));
    expect(await writeFlattenedConfig(dir, ".github/renovate.json", flattened)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(path.join(dir, ".github/renovate.json"), "utf8"))).toEqual(flattened);
  });

  it("replaces a symlinked config file with a regular file and leaves the link target untouched", async () => {
    await symlink(path.join(outside, "secret.json"), path.join(dir, "renovate.json"));
    expect(await writeFlattenedConfig(dir, "renovate.json", flattened)).toEqual({ ok: true });
    expect((await lstat(path.join(dir, "renovate.json"))).isFile()).toBe(true);
    expect(await readFile(path.join(outside, "secret.json"), "utf8")).toBe('{"outside": true}\n');
  });

  it("round-trips package.json, keeping every sibling key", async () => {
    await writeFile(path.join(dir, "package.json"), '{\n  "name": "x",\n  "renovate": { "extends": ["local>acme/w"] },\n  "version": "1.0.0"\n}\n');
    expect(await writeFlattenedConfig(dir, "package.json", flattened)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))).toEqual({
      name: "x",
      renovate: flattened,
      version: "1.0.0",
    });
  });

  it("replaces a symlinked package.json with a regular file and leaves the link target untouched", async () => {
    const target = path.join(outside, "package.json");
    const original = '{ "name": "outside", "renovate": { "extends": ["local>acme/w"] } }\n';
    await writeFile(target, original);
    await symlink(target, path.join(dir, "package.json"));
    expect(await writeFlattenedConfig(dir, "package.json", flattened)).toEqual({ ok: true });
    expect((await lstat(path.join(dir, "package.json"))).isFile()).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))).toEqual({ name: "outside", renovate: flattened });
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("refuses a package.json it cannot round-trip", async () => {
    await writeFile(path.join(dir, "package.json"), "not json");
    expect(await writeFlattenedConfig(dir, "package.json", flattened)).toEqual({
      ok: false,
      reason: expect.stringContaining("existing-file-unparseable"),
    });
    expect(await readFile(path.join(dir, "package.json"), "utf8")).toBe("not json");
  });

  it.each([
    ["absolute", () => outside],
    ["relative", () => path.relative(dir, outside)],
  ])("refuses to write through a parent directory that is an %s symlink out of the copy", async (_kind, target) => {
    await symlink(target(), path.join(dir, ".github"));
    await writeFile(path.join(outside, "renovate.json"), "original\n");
    const res = await writeFlattenedConfig(dir, ".github/renovate.json", flattened);
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("resolves outside the temporary copy") });
    expect(await readFile(path.join(outside, "renovate.json"), "utf8")).toBe("original\n");
  });

  it("writes through a parent directory symlink that stays inside the copy", async () => {
    await mkdir(path.join(dir, "real"));
    await symlink("real", path.join(dir, ".github"));
    expect(await writeFlattenedConfig(dir, ".github/renovate.json", flattened)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(path.join(dir, "real/renovate.json"), "utf8"))).toEqual(flattened);
  });

  it.each(["renovate.json", "package.json"])(
    "reports a file-system error on %s as a refusal instead of throwing",
    async (name) => {
      await mkdir(path.join(dir, name, "child"), { recursive: true });
      expect(await writeFlattenedConfig(dir, name, flattened)).toEqual({
        ok: false,
        reason: expect.stringContaining(`Could not write the flattened config into \`${name}\``),
      });
    },
  );

  it("refuses when the parent directory does not exist", async () => {
    const res = await writeFlattenedConfig(dir, "missing/renovate.json", flattened);
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("missing/renovate.json") });
  });
});

describe("removeRepoCopy", () => {
  it("removes the directory and tolerates one that is already gone", async () => {
    const dir = await mkdtemp(path.join(tmp, "copy-"));
    await writeFile(path.join(dir, "f"), "x");
    await removeRepoCopy(dir);
    await removeRepoCopy(dir);
    expect(await readdir(tmp)).toEqual([]);
  });
});
