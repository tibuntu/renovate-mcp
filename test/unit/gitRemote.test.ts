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
    ["gitlab.example.com", { classified: "self-hosted", flavor: "gitlab" }],
    ["github.acme.corp", { classified: "self-hosted", flavor: "github" }],
    ["scm.acme.io", { classified: "self-hosted", flavor: "unknown" }],
    ["code.example.com", { classified: "self-hosted", flavor: "unknown" }],
  ])("classifies %s", (host, expected) => {
    expect(classifyRemoteHost(host)).toMatchObject(expected);
  });
});
