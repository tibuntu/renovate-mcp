import { describe, expect, it } from "vitest";
import {
  describeSetup,
  type BinaryStatus,
  type RepoContext,
  type SetupStatus,
} from "../../src/lib/setupCheck.js";

// describeSetup is the human-readable half of check_setup's response. These
// tests pin whole rendered lines (not substrings) so a stray suffix such as
// "→ github (undefined)" or a swapped source label fails loudly.

function buildStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  const base: SetupStatus = {
    node: "v24.11.0",
    renovate: {
      tool: "renovate",
      command: "renovate",
      source: "bundled",
      found: true,
      version: "44.1.0",
    },
    // Deliberately distinct from every renovate fixture below so a
    // `renovate: …` line can never be satisfied by the validator's line.
    renovateConfigValidator: {
      tool: "renovate-config-validator",
      command: "/usr/local/bin/renovate-config-validator",
      source: "path",
      found: true,
      version: "99.0.0",
    },
    envOverrides: {},
    platformContext: {
      renovatePlatform: null,
      renovateEndpoint: null,
      tokensPresent: {
        RENOVATE_TOKEN: false,
        GITHUB_TOKEN: false,
        GITLAB_TOKEN: false,
        GITHUB_COM_TOKEN: false,
        GITEA_TOKEN: false,
        FORGEJO_TOKEN: false,
        BITBUCKET_TOKEN: false,
      },
      effectiveDryRunPlatform: "local",
      notes: [],
    },
    ok: true,
    hints: [],
    warnings: [],
  };
  return { ...base, ...overrides };
}

function buildRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  const base: RepoContext = {
    repoPath: "/repo",
    remote: {
      url: "https://github.com/acme/app.git",
      host: "github.com",
      scheme: "https",
      owner: "acme",
      repo: "app",
      classified: "github",
    },
    configFile: null,
    effectivePlatform: "github",
    effectivePlatformSource: "remote",
    inconsistencies: [],
  };
  return { ...base, ...overrides };
}

function renderLines(status: SetupStatus): string[] {
  return describeSetup(status).split("\n");
}

describe("describeSetup repo-context block", () => {
  it("renders every populated field of a self-hosted repo, between Platform context and Hints", () => {
    const lines = renderLines(
      buildStatus({
        hints: ["set GITEA_TOKEN before running dry_run"],
        repoContext: buildRepoContext({
          remote: {
            url: "git@git.example.com:acme/app.git",
            host: "git.example.com",
            scheme: "ssh",
            owner: "acme",
            repo: "app",
            classified: "self-hosted",
            flavor: "gitea",
          },
          configFile: { path: "renovate.json", format: "json" },
          configEndpoint: "https://git.example.com/api/v1",
          configPlatform: "gitea",
          effectivePlatform: "gitea",
          effectivePlatformSource: "config",
          endpointProbe: {
            url: "https://git.example.com/api/v1",
            reachable: true,
            status: 200,
            derivedFrom: "config",
          },
          inconsistencies: ["first mismatch", "second mismatch"],
        }),
      }),
    );

    const start = lines.indexOf("Repo context (/repo):");
    const end = lines.indexOf("Hints:");
    expect(lines.indexOf("Platform context:")).toBeLessThan(start);
    expect(start).toBeLessThan(end);
    // The block's exact content, in order, sandwiched by blank separators.
    expect(lines.slice(start, end)).toEqual([
      "Repo context (/repo):",
      "  origin: git@git.example.com:acme/app.git",
      "  host: git.example.com → self-hosted (gitea)",
      "  config: renovate.json (json)",
      "  config.endpoint: https://git.example.com/api/v1",
      "  config.platform: gitea",
      "  effective platform: gitea (from config)",
      "  endpoint probe (config): https://git.example.com/api/v1 → 200",
      "  Inconsistencies:",
      "    - first mismatch",
      "    - second mismatch",
      "",
    ]);
  });

  it("renders a sparse hosted repo without flavor suffix, optional config lines or inconsistencies", () => {
    const lines = renderLines(
      buildStatus({
        repoContext: buildRepoContext({
          endpointProbe: {
            url: "https://api.github.com/",
            reachable: false,
            derivedFrom: "default",
          },
        }),
      }),
    );

    const start = lines.indexOf("Repo context (/repo):");
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start)).toEqual([
      "Repo context (/repo):",
      "  origin: https://github.com/acme/app.git",
      "  host: github.com → github",
      "  config: (no renovate config found)",
      "  effective platform: github (from remote)",
      "  endpoint probe (default): https://api.github.com/ → UNREACHABLE (no response)",
    ]);
  });

  it.each<{ name: string; ctx: Partial<RepoContext>; line: string }>([
    {
      name: "a missing git remote",
      ctx: { remote: null },
      line: "  origin: (no git remote found)",
    },
    {
      // Same shape probeEndpoint returns for an allowlist-blocked URL
      // (reachable:false + skipped + error); derivedFrom differs from
      // effectivePlatformSource so the two fields cannot be confused.
      name: "a skipped (allowlist-blocked) probe",
      ctx: {
        effectivePlatformSource: "remote",
        endpointProbe: {
          url: "http://10.0.0.1/api",
          reachable: false,
          skipped: "endpoint-blocked",
          error: "endpoint must use https://",
          derivedFrom: "env",
        },
      },
      line: "  endpoint probe (env): SKIPPED — endpoint-blocked",
    },
    {
      name: "an unreachable probe with an error",
      ctx: {
        endpointProbe: {
          url: "https://gitlab.example.com/api/v4",
          reachable: false,
          error: "ECONNREFUSED",
          derivedFrom: "env",
        },
      },
      line: "  endpoint probe (env): https://gitlab.example.com/api/v4 → UNREACHABLE (ECONNREFUSED)",
    },
    {
      name: "a reachable probe with no HTTP status",
      ctx: {
        endpointProbe: {
          url: "https://api.github.com/",
          reachable: true,
          derivedFrom: "default",
        },
      },
      line: "  endpoint probe (default): https://api.github.com/ → ?",
    },
  ])("renders $name", ({ ctx, line }) => {
    const lines = renderLines(buildStatus({ repoContext: buildRepoContext(ctx) }));
    expect(lines).toContain(line);
  });
});

describe("describeSetup renovate binary line", () => {
  it.each<{ name: string; bin: Omit<BinaryStatus, "tool">; line: string }>([
    {
      name: "found via env override",
      bin: { command: "/opt/renovate", source: "env", found: true, version: "44.1.0" },
      line: "renovate: 44.1.0 (env: /opt/renovate)",
    },
    {
      name: "found on PATH",
      bin: { command: "renovate", source: "path", found: true, version: "44.1.0" },
      line: "renovate: 44.1.0 (PATH: renovate)",
    },
    {
      name: "found bundled",
      bin: { command: "/app/node_modules/.bin/renovate", source: "bundled", found: true, version: "44.1.0" },
      line: "renovate: 44.1.0 (bundled)",
    },
    {
      name: "found without a parsed version",
      bin: { command: "/app/node_modules/.bin/renovate", source: "bundled", found: true },
      line: "renovate: (version unknown) (bundled)",
    },
    {
      name: "missing bundled",
      bin: { command: "/app/node_modules/.bin/renovate", source: "bundled", found: false, error: "ENOENT" },
      line: "renovate: MISSING — ENOENT (bundled)",
    },
    {
      name: "missing env override",
      bin: { command: "/opt/renovate", source: "env", found: false, error: "spawn x ENOENT" },
      line: "renovate: MISSING — spawn x ENOENT (/opt/renovate)",
    },
    {
      name: "missing with no error message",
      bin: { command: "renovate", source: "path", found: false },
      line: "renovate: MISSING — unknown error (renovate)",
    },
  ])("renders $name", ({ bin, line }) => {
    const lines = renderLines(buildStatus({ renovate: { tool: "renovate", ...bin } }));
    expect(lines).toContain(line);
  });
});
