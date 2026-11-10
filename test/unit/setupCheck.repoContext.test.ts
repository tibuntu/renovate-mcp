import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSetup } from "../../src/lib/setupCheck.js";
import type { EndpointProbeResult } from "../../src/lib/endpointProbe.js";

const ENV_KEYS = [
  "RENOVATE_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GITHUB_COM_TOKEN",
  "GITEA_TOKEN",
  "FORGEJO_TOKEN",
  "BITBUCKET_TOKEN",
  "RENOVATE_PLATFORM",
  "RENOVATE_ENDPOINT",
  "RENOVATE_MCP_HOST_TOKENS",
  "ACME_GH",
  "ACME_GL",
] as const;

const ORIGINAL: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

function makeRepo(opts: {
  originUrl?: string;
  renovateConfig?: Record<string, unknown>;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-check-repo-"));
  if (opts.originUrl) {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(
      path.join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = ${opts.originUrl}\n`,
    );
  }
  if (opts.renovateConfig) {
    writeFileSync(path.join(dir, "renovate.json"), JSON.stringify(opts.renovateConfig, null, 2));
  }
  return dir;
}

const fakeProbe = (result: Partial<EndpointProbeResult> = {}) =>
  async (url: string): Promise<EndpointProbeResult> => ({
    url,
    reachable: true,
    status: 200,
    ...result,
  });

// Keyed on the hint's prose rather than its URL: CodeQL reads
// `includes("https://…")` in a boolean as URL sanitization (js/incomplete-url-substring-sanitization).
const isForgejoEndpointHint = (hint: string): boolean => /a Forgejo host other than/.test(hint);

describe("checkSetup repoContext", () => {
  it("omits repoContext when repoPath is not provided", async () => {
    const status = await checkSetup();
    expect(status.repoContext).toBeUndefined();
  });

  it("classifies github.com origin and hints missing GITHUB_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("github");
    expect(status.repoContext?.effectivePlatform).toBe("github");
    expect(status.repoContext?.effectivePlatformSource).toBe("remote");
    expect(status.hints.some((h) => h.includes("GITHUB_TOKEN"))).toBe(true);
  });

  it("does not hint about the github-actions skip when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_dummy";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("github-token-required"))).toBe(false);
  });

  it("does not hint GITHUB_COM_TOKEN when GITHUB_TOKEN is set: a local run gets it as the github.com host rule", async () => {
    process.env.GITHUB_TOKEN = "ghp_dummy";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("GITHUB_COM_TOKEN"))).toBe(false);
  });

  it("does not hint GITHUB_COM_TOKEN when a host-token entry covers api.github.com", async () => {
    process.env.RENOVATE_MCP_HOST_TOKENS = JSON.stringify([
      { matchHost: "api.github.com", hostType: "github", tokenEnv: "ACME_GH" },
    ]);
    process.env.ACME_GH = "ghp_entry";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("GITHUB_COM_TOKEN"))).toBe(false);
  });

  it("hints GITHUB_COM_TOKEN when only RENOVATE_TOKEN is set (no GITHUB_TOKEN)", async () => {
    process.env.RENOVATE_TOKEN = "renovate_dummy";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    const hint = status.hints.find((h) => h.includes("GITHUB_COM_TOKEN"));
    expect(hint).toBeDefined();
    expect(hint).toContain("datasource");
    expect(hint).toContain("`RENOVATE_TOKEN` is bound only to the `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` host");
    expect(hint).toContain("`RENOVATE_PLATFORM=github`");
  });

  it("does not hint GITHUB_COM_TOKEN when it is already set", async () => {
    process.env.GITHUB_TOKEN = "ghp_dummy";
    process.env.GITHUB_COM_TOKEN = "ghp_datasource";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("GITHUB_COM_TOKEN"))).toBe(false);
  });

  it("hints the anonymous github.com variant when no token at all is set", async () => {
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    const hint = status.hints.find((h) => h.includes("GITHUB_COM_TOKEN"));
    expect(hint).toBeDefined();
    expect(hint).toContain("anonymously");
  });

  it("does not hint GITHUB_COM_TOKEN when RENOVATE_PLATFORM=github is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_dummy";
    process.env.RENOVATE_PLATFORM = "github";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.platformContext.effectiveDryRunPlatform).toBe("github");
    expect(status.hints.some((h) => h.includes("GITHUB_COM_TOKEN"))).toBe(false);
  });

  it("does not hint GITHUB_COM_TOKEN for a self-hosted (GHE) origin", async () => {
    process.env.GITHUB_TOKEN = "ghp_dummy";
    const dir = makeRepo({ originUrl: "git@github.example.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("GITHUB_COM_TOKEN"))).toBe(false);
  });

  it("reports GITHUB_COM_TOKEN presence in platformContext.tokensPresent", async () => {
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const without = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(without.platformContext.tokensPresent.GITHUB_COM_TOKEN).toBe(false);
    process.env.GITHUB_COM_TOKEN = "ghp_datasource";
    const withTok = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(withTok.platformContext.tokensPresent.GITHUB_COM_TOKEN).toBe(true);
  });

  it("classifies gitlab.com origin and hints missing GITLAB_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.com:grp/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("gitlab");
    const hint = status.hints.find((h) => h.includes("GITLAB_TOKEN"));
    expect(hint).toBeDefined();
    // RENOVATE_TOKEN is the home platform's token only (host-scoped tokens).
    expect(hint).toMatch(/`RENOVATE_TOKEN` counts only when `RENOVATE_PLATFORM=gitlab`/);
    expect(hint).toContain('`platform: "gitlab"` on a tool call does not bind it');
  });

  it("classifies bitbucket.org origin and hints missing BITBUCKET_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "git@bitbucket.org:ws/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("bitbucket");
    expect(status.repoContext?.effectivePlatform).toBe("bitbucket");
    const hint = status.hints.find((h) => h.includes("BITBUCKET_TOKEN"));
    expect(hint).toBeDefined();
    expect(hint).toContain('platform: "bitbucket"');
  });

  it("does not hint BITBUCKET_TOKEN when RENOVATE_TOKEN covers it", async () => {
    process.env.RENOVATE_TOKEN = "rnv_dummy";
    process.env.RENOVATE_PLATFORM = "bitbucket";
    const dir = makeRepo({ originUrl: "https://bitbucket.org/ws/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("BITBUCKET_TOKEN"))).toBe(false);
  });

  it("classifies gitea.com origin and hints missing GITEA_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "git@gitea.com:org/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("gitea");
    expect(status.hints.some((h) => h.includes("GITEA_TOKEN"))).toBe(true);
  });

  it("classifies codeberg.org origin as forgejo and hints missing FORGEJO_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "https://codeberg.org/org/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("forgejo");
    expect(status.hints.some((h) => h.includes("FORGEJO_TOKEN"))).toBe(true);
  });

  it("hints local> plus the Codeberg API endpoint, since forgejo> always means code.forgejo.org", async () => {
    const dir = makeRepo({ originUrl: "https://codeberg.org/org/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    const hint = status.hints.find(isForgejoEndpointHint);
    expect(hint).toBeDefined();
    expect(hint).toContain('endpoint: "https://codeberg.org/api/v1"');
    expect(hint).toContain('platform: "forgejo"');
    expect(hint).toContain("`local>");
    expect(hint).toMatch(/`forgejo>` presets always resolve against code\.forgejo\.org/);
  });

  it("does not hint an endpoint for code.forgejo.org itself", async () => {
    const dir = makeRepo({ originUrl: "https://code.forgejo.org/org/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isForgejoEndpointHint)).toBe(false);
  });

  it("does not hint the Codeberg endpoint when renovate.json already sets one", async () => {
    const dir = makeRepo({
      originUrl: "https://codeberg.org/org/proj.git",
      renovateConfig: { endpoint: "https://codeberg.org/api/v1" },
    });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isForgejoEndpointHint)).toBe(false);
  });

  it("treats a self-hosted gitea.* host as gitea-flavoured and hints GITEA_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "git@gitea.example.com:org/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("self-hosted");
    expect(status.repoContext?.remote?.flavor).toBe("gitea");
    expect(status.repoContext?.effectivePlatform).toBe("gitea");
    expect(status.hints.some((h) => h.includes("GITEA_TOKEN"))).toBe(true);
  });

  it("flags self-hosted gitlab without configured endpoint", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:grp/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("self-hosted");
    expect(status.repoContext?.remote?.flavor).toBe("gitlab");
    expect(
      status.hints.some((h) => h.includes("Self-hosted") && h.includes("endpoint")),
    ).toBe(true);
  });

  it("flags unknown self-hosted flavor with a disambiguation hint", async () => {
    const dir = makeRepo({ originUrl: "git@scm.acme.io:team/repo.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.flavor).toBe("unknown");
    expect(status.hints.some((h) => h.includes("RENOVATE_PLATFORM"))).toBe(true);
  });

  it("flags inconsistency between remote and config.endpoint", async () => {
    const dir = makeRepo({
      originUrl: "git@github.com:foo/bar.git",
      renovateConfig: { endpoint: "https://gitlab.example.com/api/v4/" },
    });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(
      status.repoContext?.inconsistencies.some((i) => i.includes("different hosts")),
    ).toBe(true);
  });

  it("falls back to env platform when remote is missing", async () => {
    process.env.RENOVATE_PLATFORM = "gitlab";
    const dir = makeRepo({});
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote).toBeNull();
    expect(status.repoContext?.effectivePlatform).toBe("gitlab");
    expect(status.repoContext?.effectivePlatformSource).toBe("env");
  });

  it("surfaces blocked-endpoint hint when config.endpoint fails the allowlist", async () => {
    const dir = makeRepo({
      originUrl: "git@gitlab.example.com:grp/proj.git",
      renovateConfig: { endpoint: "https://10.0.0.1/api/v4/" },
    });
    const status = await checkSetup({
      repoPath: dir,
      probe: fakeProbe({
        reachable: false,
        skipped: "endpoint-blocked",
        error: "private host",
      }),
    });
    expect(status.hints.some((h) => h.includes("Skipped reachability"))).toBe(true);
    expect(status.ok).toBe(true);
  });

  it("surfaces unreachable hint without flipping ok", async () => {
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({
      repoPath: dir,
      probe: fakeProbe({ reachable: false, error: "ENOTFOUND" }),
    });
    expect(status.hints.some((h) => h.includes("Could not reach"))).toBe(true);
    expect(status.ok).toBe(true);
  });

  it("does not probe for self-hosted with no endpoint configured", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:grp/proj.git" });
    let probed = false;
    const status = await checkSetup({
      repoPath: dir,
      probe: async (url) => {
        probed = true;
        return { url, reachable: true, status: 200 };
      },
    });
    expect(probed).toBe(false);
    expect(status.repoContext?.endpointProbe).toBeUndefined();
  });

  it("uses config.endpoint as probe url when provided", async () => {
    const dir = makeRepo({
      originUrl: "git@gitlab.example.com:grp/proj.git",
      renovateConfig: { endpoint: "https://gitlab.example.com/api/v4/" },
    });
    let probedUrl: string | null = null;
    await checkSetup({
      repoPath: dir,
      probe: async (url) => {
        probedUrl = url;
        return { url, reachable: true, status: 200 };
      },
    });
    expect(probedUrl).toBe("https://gitlab.example.com/api/v4/");
  });
});

describe("checkSetup repoContext — the missing-token hint follows the bound host", () => {
  const isSetHint = (h: string) => h.includes("Set `GITLAB_TOKEN`");

  it("hints GITLAB_TOKEN when RENOVATE_TOKEN is bound to another platform", async () => {
    process.env.RENOVATE_TOKEN = "rnv_dummy";
    process.env.RENOVATE_PLATFORM = "github";
    const dir = makeRepo({ originUrl: "git@gitlab.com:grp/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isSetHint)).toBe(true);
  });

  it("hints GITLAB_TOKEN when RENOVATE_TOKEN is bound to another GitLab host", async () => {
    process.env.RENOVATE_TOKEN = "rnv_dummy";
    process.env.RENOVATE_PLATFORM = "gitlab";
    process.env.RENOVATE_ENDPOINT = "https://gitlab.example.com/api/v4/";
    const dir = makeRepo({ originUrl: "git@gitlab.com:grp/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isSetHint)).toBe(true);
  });

  it("does not hint when RENOVATE_PLATFORM binds RENOVATE_TOKEN to the origin", async () => {
    process.env.RENOVATE_TOKEN = "rnv_dummy";
    process.env.RENOVATE_PLATFORM = "gitlab";
    const dir = makeRepo({ originUrl: "git@gitlab.com:grp/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isSetHint)).toBe(false);
  });

  it("does not hint when a host-token entry covers the origin", async () => {
    process.env.RENOVATE_MCP_HOST_TOKENS = JSON.stringify([
      { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME_GL" },
    ]);
    process.env.ACME_GL = "glpat_entry";
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isSetHint)).toBe(false);
  });

  it("leaves a set but unbound GITLAB_TOKEN to the binding hint", async () => {
    process.env.GITLAB_TOKEN = "glpat_dummy";
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isSetHint)).toBe(false);
    expect(status.hints.some((h) => /bound to gitlab\.com/.test(h))).toBe(true);
  });

  it("checks the env endpoint when there is no origin", async () => {
    process.env.RENOVATE_PLATFORM = "gitlab";
    process.env.RENOVATE_ENDPOINT = "https://gitlab.example.com/api/v4/";
    const dir = makeRepo({});
    expect((await checkSetup({ repoPath: dir, probe: fakeProbe() })).hints.some(isSetHint)).toBe(true);
    process.env.RENOVATE_TOKEN = "rnv_dummy";
    expect((await checkSetup({ repoPath: dir, probe: fakeProbe() })).hints.some(isSetHint)).toBe(false);
  });

  it("checks the config endpoint when there is no origin", async () => {
    process.env.RENOVATE_MCP_HOST_TOKENS = JSON.stringify([
      { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME_GL" },
    ]);
    process.env.ACME_GL = "glpat_entry";
    const dir = makeRepo({ renovateConfig: { platform: "gitlab", endpoint: "https://gitlab.example.com/api/v4/" } });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.effectivePlatform).toBe("gitlab");
    expect(status.hints.some(isSetHint)).toBe(false);
  });

  it("checks the public host when there is neither origin nor endpoint", async () => {
    process.env.RENOVATE_PLATFORM = "gitlab";
    const dir = makeRepo({});
    expect((await checkSetup({ repoPath: dir, probe: fakeProbe() })).hints.some(isSetHint)).toBe(true);
    process.env.GITLAB_TOKEN = "glpat_dummy";
    expect((await checkSetup({ repoPath: dir, probe: fakeProbe() })).hints.some(isSetHint)).toBe(false);
  });
});

describe("checkSetup repoContext — per-platform token on a self-hosted origin", () => {
  const isBindingHint = (h: string) => /bound to gitlab\.com/.test(h);

  it("hints that GITLAB_TOKEN is bound to gitlab.com when the self-hosted host is not the home endpoint", async () => {
    process.env.GITLAB_TOKEN = "glpat_dummy";
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    const hint = status.hints.find(isBindingHint);
    expect(hint).toBeDefined();
    expect(hint).toContain("`GITLAB_TOKEN`");
    expect(hint).toContain("gitlab.example.com");
    expect(hint).toContain("RENOVATE_MCP_HOST_TOKENS");
    expect(hint).not.toContain("glpat_dummy");
  });

  it("does not hint when RENOVATE_PLATFORM + RENOVATE_ENDPOINT make the host the home", async () => {
    process.env.GITLAB_TOKEN = "glpat_dummy";
    process.env.RENOVATE_PLATFORM = "gitlab";
    process.env.RENOVATE_ENDPOINT = "https://gitlab.example.com/api/v4/";
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isBindingHint)).toBe(false);
  });

  it("does not hint when a host-token entry covers the host", async () => {
    process.env.GITLAB_TOKEN = "glpat_dummy";
    process.env.RENOVATE_MCP_HOST_TOKENS = JSON.stringify([
      { matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME_GL" },
    ]);
    process.env.ACME_GL = "glpat_entry";
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isBindingHint)).toBe(false);
  });

  it("does not hint when GITLAB_TOKEN is unset", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isBindingHint)).toBe(false);
  });

  it("does not hint for an unknown self-hosted flavor", async () => {
    process.env.GITLAB_TOKEN = "glpat_dummy";
    const dir = makeRepo({ originUrl: "git@code.example.com:acme/widgets.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some(isBindingHint)).toBe(false);
  });
});

describe("checkSetup repoContext — edge inputs", () => {
  it("has no remote when the origin URL cannot be parsed, and defaults to local", async () => {
    const dir = makeRepo({ originUrl: "/srv/git/widgets" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote).toBeNull();
    expect(status.repoContext?.effectivePlatform).toBe("local");
    expect(status.repoContext?.effectivePlatformSource).toBe("default");
    expect(status.repoContext?.endpointProbe).toBeUndefined();
  });

  it("takes the platform from the repo config when origin does not decide it", async () => {
    const dir = makeRepo({ renovateConfig: { platform: "gitea", endpoint: "" } });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.configPlatform).toBe("gitea");
    expect(status.repoContext?.configEndpoint).toBeUndefined();
    expect(status.repoContext?.effectivePlatform).toBe("gitea");
    expect(status.repoContext?.effectivePlatformSource).toBe("config");
  });

  it("ignores a config platform Renovate-mcp does not know and a non-string endpoint", async () => {
    const dir = makeRepo({ renovateConfig: { platform: "azure", endpoint: 42 } });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.configPlatform).toBeUndefined();
    expect(status.repoContext?.configEndpoint).toBeUndefined();
  });

  it("uses the real probe when none is injected, which refuses a blocked endpoint without a request", async () => {
    const dir = makeRepo({ renovateConfig: { endpoint: "http://127.0.0.1/api/v4/" } });
    const status = await checkSetup({ repoPath: dir });
    expect(status.repoContext?.endpointProbe).toMatchObject({ reachable: false, skipped: "endpoint-blocked" });
  });

  it("falls back to generic wording when a probe result carries no error", async () => {
    const dir = makeRepo({ renovateConfig: { endpoint: "https://gitlab.example.com/api/v4/" } });
    const blocked = await checkSetup({
      repoPath: dir,
      probe: fakeProbe({ reachable: false, skipped: "endpoint-blocked" }),
    });
    expect(blocked.hints.some((h) => h.includes("blocked by endpoint allowlist"))).toBe(true);
    const unreachable = await checkSetup({ repoPath: dir, probe: fakeProbe({ reachable: false }) });
    expect(unreachable.hints.some((h) => h.includes("no response"))).toBe(true);
  });

  it("flags RENOVATE_PLATFORM naming another platform than the origin", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.com:acme/widgets.git" });
    process.env.RENOVATE_PLATFORM = "github";
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.inconsistencies).toEqual([
      expect.stringContaining("Remote origin classifies as `gitlab` but `RENOVATE_PLATFORM=github`"),
    ]);
  });

  it("flags no inconsistency when RENOVATE_PLATFORM agrees with the origin or is local", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.com:acme/widgets.git" });
    process.env.RENOVATE_PLATFORM = "gitlab";
    const agree = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(agree.repoContext?.inconsistencies).toEqual([]);
    process.env.RENOVATE_PLATFORM = "local";
    const local = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(local.repoContext?.inconsistencies).toEqual([]);
  });

  it("flags no inconsistency for an unclassifiable host: RENOVATE_PLATFORM is how the user names it", async () => {
    const dir = makeRepo({ originUrl: "git@code.example.com:acme/widgets.git" });
    process.env.RENOVATE_PLATFORM = "gitlab";
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.inconsistencies).toEqual([]);
  });
});
