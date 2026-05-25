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
  "RENOVATE_PLATFORM",
  "RENOVATE_ENDPOINT",
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

  it("does not hint about GITHUB_TOKEN when one is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_dummy";
    const dir = makeRepo({ originUrl: "git@github.com:foo/bar.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.hints.some((h) => h.includes("GITHUB_TOKEN"))).toBe(false);
  });

  it("classifies gitlab.com origin and hints missing GITLAB_TOKEN", async () => {
    const dir = makeRepo({ originUrl: "git@gitlab.com:grp/proj.git" });
    const status = await checkSetup({ repoPath: dir, probe: fakeProbe() });
    expect(status.repoContext?.remote?.classified).toBe("gitlab");
    expect(status.hints.some((h) => h.includes("GITLAB_TOKEN"))).toBe(true);
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
