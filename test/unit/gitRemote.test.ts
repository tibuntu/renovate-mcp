import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyRemoteHost,
  parseGitConfigOriginUrl,
  parseRemoteUrl,
  readOriginRemote,
} from "../../src/lib/gitRemote.js";

describe("parseRemoteUrl", () => {
  it.each([
    [
      "github.com SSH",
      "git@github.com:tibuntu/renovate-mcp.git",
      { host: "github.com", scheme: "ssh", owner: "tibuntu", repo: "renovate-mcp" },
    ],
    [
      "github.com HTTPS",
      "https://github.com/tibuntu/renovate-mcp.git",
      { host: "github.com", scheme: "https", owner: "tibuntu", repo: "renovate-mcp" },
    ],
    [
      "gitlab.com HTTPS",
      "https://gitlab.com/group/project.git",
      { host: "gitlab.com", scheme: "https", owner: "group", repo: "project" },
    ],
    [
      "gitlab.com SSH with nested subgroup",
      "git@gitlab.com:group/subgroup/project.git",
      { host: "gitlab.com", scheme: "ssh", owner: "group/subgroup", repo: "project" },
    ],
    [
      "self-hosted GitLab HTTPS with subgroup",
      "https://gitlab.example.com/group/sub/repo.git",
      { host: "gitlab.example.com", scheme: "https", owner: "group/sub", repo: "repo" },
    ],
    [
      "GitHub Enterprise HTTPS",
      "https://github.acme.corp/team/repo.git",
      { host: "github.acme.corp", scheme: "https", owner: "team", repo: "repo" },
    ],
    [
      "SSH without .git suffix",
      "git@github.com:owner/repo",
      { host: "github.com", scheme: "ssh", owner: "owner", repo: "repo" },
    ],
    [
      "HTTPS without .git suffix",
      "https://gitlab.com/group/project",
      { host: "gitlab.com", scheme: "https", owner: "group", repo: "project" },
    ],
    [
      "ssh:// URL form",
      "ssh://git@gitlab.example.com:2222/group/repo.git",
      { host: "gitlab.example.com", scheme: "ssh", owner: "group", repo: "repo" },
    ],
    [
      "git:// URL form",
      "git://github.com/foo/bar.git",
      { host: "github.com", scheme: "git", owner: "foo", repo: "bar" },
    ],
    [
      "host normalised to lowercase",
      "git@GitHub.com:foo/bar.git",
      { host: "github.com", scheme: "ssh", owner: "foo", repo: "bar" },
    ],
  ])("parses %s", (_label, url, expected) => {
    expect(parseRemoteUrl(url)).toMatchObject(expected);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["not a URL at all", "not-a-url"],
  ])("returns null for %s", (_label, url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});

describe("parseGitConfigOriginUrl", () => {
  it("returns the url from the [remote \"origin\"] section", () => {
    const content = `
[core]
\trepositoryformatversion = 0

[remote "origin"]
\turl = git@github.com:owner/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
    expect(parseGitConfigOriginUrl(content)).toBe("git@github.com:owner/repo.git");
  });

  it("returns null when no origin remote exists", () => {
    const content = `
[remote "upstream"]
\turl = git@github.com:other/repo.git
`;
    expect(parseGitConfigOriginUrl(content)).toBeNull();
  });

  it("ignores commented-out lines", () => {
    const content = `
[remote "origin"]
\t# url = git@github.com:wrong/repo.git
\turl = git@github.com:right/repo.git
`;
    expect(parseGitConfigOriginUrl(content)).toBe("git@github.com:right/repo.git");
  });

  it("only matches a remote section named exactly \"origin\"", () => {
    const content = `
[remote "origin-mirror"]
\turl = git@github.com:wrong/repo.git
`;
    expect(parseGitConfigOriginUrl(content)).toBeNull();
  });
});

describe("parseRemoteUrl / parseGitConfigOriginUrl edge cases", () => {
  it("parses remotes without an owner or a repo segment", () => {
    expect(parseRemoteUrl("https://github.com")).toEqual({ host: "github.com", scheme: "https", owner: undefined, repo: undefined });
    expect(parseRemoteUrl("https://github.com/widgets.git")).toEqual({ host: "github.com", scheme: "https", owner: undefined, repo: "widgets" });
    expect(parseRemoteUrl("git@github.com:widgets.git")).toEqual({ host: "github.com", scheme: "ssh", owner: undefined, repo: "widgets" });
    expect(parseRemoteUrl("https://")).toBeNull();
    expect(parseRemoteUrl("git@github.com:.git")).toBeNull();
  });

  it("skips origin lines without a value or with other keys, and treats an empty url as none", () => {
    expect(parseGitConfigOriginUrl('[remote "origin"]\n\tmirror\n\tfetch = +refs/*:refs/*\n\turl = git@github.com:acme/w.git\n')).toBe(
      "git@github.com:acme/w.git",
    );
    expect(parseGitConfigOriginUrl('[remote "origin"]\n\turl =\n')).toBeNull();
  });
});

describe("readOriginRemote", () => {
  it("returns the origin url for a valid repo", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(
      path.join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/foo/bar.git\n`,
    );
    expect(await readOriginRemote(dir)).toBe("https://github.com/foo/bar.git");
  });

  const originConfig = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;

  it("follows a .git file into a worktree's common git dir", async () => {
    const main = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(path.join(main, ".git", "config"), originConfig("https://gitlab.example.com/acme/widgets.git"));
    writeFileSync(path.join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const wt = path.join(main, "wt");
    mkdirSync(wt);
    writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/wt\n");
    expect(await readOriginRemote(wt)).toBe("https://gitlab.example.com/acme/widgets.git");
  });

  it.each([
    ["an arbitrary directory", "../../../elsewhere\n"],
    ["a bare repository", "../../../repo.git\n"],
  ])("treats a worktree whose commondir points at %s as no origin", async (_name, commondir) => {
    const main = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(path.join(main, ".git", "worktrees", "wt", "commondir"), commondir);
    for (const target of ["elsewhere", "repo.git"]) {
      mkdirSync(path.join(main, target));
      writeFileSync(path.join(main, target, "config"), originConfig("https://github.com/attacker/x.git"));
    }
    const wt = path.join(main, "wt");
    mkdirSync(wt);
    writeFileSync(path.join(wt, ".git"), "gitdir: ../.git/worktrees/wt\n");
    expect(await readOriginRemote(wt)).toBeNull();
  });

  it("follows a .git file into a submodule's own git dir", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    const moduleDir = path.join(parent, ".git", "modules", "sub");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(path.join(moduleDir, "config"), originConfig("git@github.com:acme/sub.git"));
    const sub = path.join(parent, "sub");
    mkdirSync(sub);
    writeFileSync(path.join(sub, ".git"), `gitdir: ${moduleDir}\n`);
    expect(await readOriginRemote(sub)).toBe("git@github.com:acme/sub.git");
  });

  it.each([
    ["an arbitrary directory", (root: string) => path.join(root, "elsewhere")],
    ["a directory merely named like a worktree", (root: string) => path.join(root, "worktrees", "wt")],
    ["a nested worktree path", (root: string) => path.join(root, ".git", "worktrees", "wt", "deeper")],
  ])("treats a gitdir that points at %s as no origin", async (_name, target) => {
    const root = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    const gitDir = target(root);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "config"), originConfig("https://github.com/attacker/x.git"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    writeFileSync(path.join(repo, ".git"), `gitdir: ${gitDir}\n`);
    expect(await readOriginRemote(repo)).toBeNull();
  });

  it("follows a gitdir that is another .git directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    const gitDir = path.join(root, "real", ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "config"), originConfig("https://gitlab.com/acme/w.git"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    writeFileSync(path.join(repo, ".git"), "gitdir: ../real/.git\n");
    expect(await readOriginRemote(repo)).toBe("https://gitlab.com/acme/w.git");
  });

  it("returns null for a .git file without a gitdir line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    writeFileSync(path.join(dir, ".git"), "not a pointer\n");
    expect(await readOriginRemote(dir)).toBeNull();
  });

  it("returns null for a non-git directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "git-remote-test-"));
    expect(await readOriginRemote(dir)).toBeNull();
  });
});

describe("classifyRemoteHost", () => {
  it.each([
    ["github.com", { classified: "github" }],
    ["GitHub.com", { classified: "github" }],
    ["gitlab.com", { classified: "gitlab" }],
    ["bitbucket.org", { classified: "bitbucket" }],
    ["gitea.com", { classified: "gitea" }],
    ["codeberg.org", { classified: "forgejo" }],
    ["code.forgejo.org", { classified: "forgejo" }],
    ["gitlab.example.com", { classified: "self-hosted", flavor: "gitlab" }],
    ["github.acme.corp", { classified: "self-hosted", flavor: "github" }],
    ["gitea.example.com", { classified: "self-hosted", flavor: "gitea" }],
    ["forgejo.acme.io", { classified: "self-hosted", flavor: "forgejo" }],
    ["scm.acme.io", { classified: "self-hosted", flavor: "unknown" }],
    ["code.example.com", { classified: "self-hosted", flavor: "unknown" }],
  ])("classifies %s", (host, expected) => {
    expect(classifyRemoteHost(host)).toMatchObject(expected);
  });
});
