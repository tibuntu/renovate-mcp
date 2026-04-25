import { describe, it, expect, afterEach } from "vitest";
import {
  checkSetup,
  describeSetup,
  inspectPlatformContext,
  startupBanner,
  unavailableTools,
  type PlatformContext,
  type SetupStatus,
} from "../../src/lib/setupCheck.js";

const originalEnv = { ...process.env };

const PLATFORM_ENV_KEYS = [
  "RENOVATE_PLATFORM",
  "RENOVATE_ENDPOINT",
  "RENOVATE_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
] as const;

afterEach(() => {
  process.env = { ...originalEnv };
});

function emptyPlatformContext(): PlatformContext {
  return {
    renovatePlatform: null,
    renovateEndpoint: null,
    tokensPresent: { RENOVATE_TOKEN: false, GITHUB_TOKEN: false, GITLAB_TOKEN: false },
    effectiveDryRunPlatform: "local",
    notes: [],
  };
}

describe("checkSetup", () => {
  it("reports both binaries missing when they ENOENT", async () => {
    process.env.RENOVATE_BIN = "/nonexistent/path/to/renovate";
    process.env.RENOVATE_CONFIG_VALIDATOR_BIN = "/nonexistent/path/to/validator";
    const status = await checkSetup();
    expect(status.ok).toBe(false);
    expect(status.renovate.found).toBe(false);
    expect(status.renovateConfigValidator.found).toBe(false);
    expect(status.hints.length).toBe(2);
  });

  it("reports found=true when the binary exits 0 on --version", async () => {
    // /bin/echo exits 0 and prints args to stdout — a reasonable proxy for
    // a real `--version` call.
    process.env.RENOVATE_BIN = "/bin/echo";
    process.env.RENOVATE_CONFIG_VALIDATOR_BIN = "/bin/echo";
    const status = await checkSetup();
    expect(status.ok).toBe(true);
    expect(status.renovate.found).toBe(true);
    expect(status.renovate.version).toBeDefined();
    expect(status.hints).toEqual([]);
  });

  it("records env overrides in the output", async () => {
    process.env.RENOVATE_BIN = "/bin/echo";
    process.env.RENOVATE_CONFIG_VALIDATOR_BIN = "/bin/echo";
    const status = await checkSetup();
    expect(status.envOverrides).toMatchObject({
      RENOVATE_BIN: "/bin/echo",
      RENOVATE_CONFIG_VALIDATOR_BIN: "/bin/echo",
    });
  });
});

describe("describeSetup", () => {
  it("includes Node version and binary versions", () => {
    const out = describeSetup({
      node: "v20.0.0",
      renovate: {
        tool: "renovate",
        command: "renovate",
        found: true,
        version: "43.0.0",
      },
      renovateConfigValidator: {
        tool: "renovate-config-validator",
        command: "renovate-config-validator",
        found: true,
        version: "43.0.0",
      },
      envOverrides: {},
      platformContext: emptyPlatformContext(),
      ok: true,
      hints: [],
    });
    expect(out).toContain("v20.0.0");
    expect(out).toContain("43.0.0");
  });

});

function buildStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  const base: SetupStatus = {
    node: "v20.0.0",
    renovate: { tool: "renovate", command: "renovate", found: true, version: "43.0.0" },
    renovateConfigValidator: {
      tool: "renovate-config-validator",
      command: "renovate-config-validator",
      found: true,
      version: "43.0.0",
    },
    envOverrides: {},
    platformContext: emptyPlatformContext(),
    ok: true,
    hints: [],
  };
  return { ...base, ...overrides };
}

describe("unavailableTools", () => {
  it("returns [] when both binaries are found", () => {
    expect(unavailableTools(buildStatus())).toEqual([]);
  });

  it("lists validate_config + write_config when only the validator is missing", () => {
    const status = buildStatus({
      renovateConfigValidator: {
        tool: "renovate-config-validator",
        command: "renovate-config-validator",
        found: false,
        error: "ENOENT",
      },
      ok: false,
    });
    expect(unavailableTools(status)).toEqual(["validate_config", "write_config"]);
  });

  it("lists dry_run when only renovate is missing", () => {
    const status = buildStatus({
      renovate: { tool: "renovate", command: "renovate", found: false, error: "ENOENT" },
      ok: false,
    });
    expect(unavailableTools(status)).toEqual(["dry_run"]);
  });

  it("lists all three CLI-backed tools when both binaries are missing", () => {
    const status = buildStatus({
      renovate: { tool: "renovate", command: "renovate", found: false, error: "ENOENT" },
      renovateConfigValidator: {
        tool: "renovate-config-validator",
        command: "renovate-config-validator",
        found: false,
        error: "ENOENT",
      },
      ok: false,
    });
    expect(unavailableTools(status)).toEqual(["validate_config", "dry_run", "write_config"]);
  });
});

describe("startupBanner", () => {
  it("returns null when the setup is fully ok", () => {
    expect(startupBanner(buildStatus())).toBeNull();
  });

  it("mentions only the blocked tools and reassures that offline tools still work", () => {
    const status = buildStatus({
      renovate: { tool: "renovate", command: "renovate", found: false, error: "ENOENT" },
      renovateConfigValidator: {
        tool: "renovate-config-validator",
        command: "renovate-config-validator",
        found: false,
        error: "ENOENT",
      },
      ok: false,
    });
    const out = startupBanner(status);
    expect(out).not.toBeNull();
    expect(out).toContain("Partial availability");
    expect(out).toContain("`read_config`");
    expect(out).toContain("`resolve_config`");
    expect(out).toContain("`preview_custom_manager`");
    expect(out).toContain("`dry_run`");
    expect(out).toContain("`validate_config`");
    expect(out).toContain("`write_config`");
    // The LLM guidance line is the whole point of the rewording.
    expect(out).toMatch(/do not flag this as a setup problem/i);
    expect(out).toContain("RENOVATE_MCP_REQUIRE_CLI=false");
  });

  it("narrows the blocked list when only the validator is missing", () => {
    const status = buildStatus({
      renovateConfigValidator: {
        tool: "renovate-config-validator",
        command: "renovate-config-validator",
        found: false,
        error: "ENOENT",
      },
      ok: false,
    });
    const out = startupBanner(status)!;
    expect(out).toContain("`validate_config`");
    expect(out).toContain("`write_config`");
    expect(out).not.toContain("`dry_run`");
  });
});

describe("describeSetup (legacy verbose diagnostic)", () => {
  it("still shows MISSING for not-found binaries and lists hints", () => {
    const out = describeSetup({
      node: "v20.0.0",
      renovate: {
        tool: "renovate",
        command: "renovate",
        found: false,
        error: "spawn renovate ENOENT",
      },
      renovateConfigValidator: {
        tool: "renovate-config-validator",
        command: "renovate-config-validator",
        found: false,
        error: "spawn renovate-config-validator ENOENT",
      },
      envOverrides: { RENOVATE_BIN: "/x" },
      platformContext: emptyPlatformContext(),
      ok: false,
      hints: ["hint A", "hint B"],
    });
    expect(out).toContain("MISSING");
    expect(out).toContain("hint A");
    expect(out).toContain("RENOVATE_BIN=/x");
  });
});

describe("inspectPlatformContext", () => {
  function clean(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of PLATFORM_ENV_KEYS) {
      delete env[key];
    }
    return env;
  }

  it("returns nulls and false presence flags when nothing is set", () => {
    const ctx = inspectPlatformContext(clean());
    expect(ctx.renovatePlatform).toBeNull();
    expect(ctx.renovateEndpoint).toBeNull();
    expect(ctx.tokensPresent).toEqual({
      RENOVATE_TOKEN: false,
      GITHUB_TOKEN: false,
      GITLAB_TOKEN: false,
    });
    expect(ctx.effectiveDryRunPlatform).toBe("local");
    expect(ctx.notes).toEqual([]);
  });

  it("reports tokens by presence only, never echoes values", () => {
    const ctx = inspectPlatformContext({
      ...clean(),
      RENOVATE_TOKEN: "shh-secret-1",
      GITLAB_TOKEN: "shh-secret-2",
    });
    expect(ctx.tokensPresent).toEqual({
      RENOVATE_TOKEN: true,
      GITHUB_TOKEN: false,
      GITLAB_TOKEN: true,
    });
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("shh-secret-1");
    expect(serialized).not.toContain("shh-secret-2");
  });

  it("derives effectiveDryRunPlatform from RENOVATE_PLATFORM when whitelisted", () => {
    const ctx = inspectPlatformContext({ ...clean(), RENOVATE_PLATFORM: "gitlab", GITLAB_TOKEN: "x" });
    expect(ctx.renovatePlatform).toBe("gitlab");
    expect(ctx.effectiveDryRunPlatform).toBe("gitlab");
  });

  it("warns and falls back to local when RENOVATE_PLATFORM is outside the dry_run enum", () => {
    const ctx = inspectPlatformContext({ ...clean(), RENOVATE_PLATFORM: "bitbucket" });
    expect(ctx.renovatePlatform).toBe("bitbucket");
    expect(ctx.effectiveDryRunPlatform).toBe("local");
    expect(ctx.notes.some((n) => n.includes("outside the `dry_run` schema enum"))).toBe(true);
  });

  it("warns when platform=gitlab has no GITLAB_TOKEN nor RENOVATE_TOKEN", () => {
    const ctx = inspectPlatformContext({ ...clean(), RENOVATE_PLATFORM: "gitlab" });
    expect(ctx.notes.some((n) => n.includes("`RENOVATE_PLATFORM=gitlab`") && n.includes("authenticate"))).toBe(true);
  });

  it("does NOT warn about missing token when RENOVATE_TOKEN covers the platform", () => {
    const ctx = inspectPlatformContext({ ...clean(), RENOVATE_PLATFORM: "gitlab", RENOVATE_TOKEN: "x" });
    expect(ctx.notes.some((n) => n.includes("authenticate"))).toBe(false);
  });

  it("warns when platform=github has no GITHUB_TOKEN nor RENOVATE_TOKEN", () => {
    const ctx = inspectPlatformContext({ ...clean(), RENOVATE_PLATFORM: "github" });
    expect(ctx.notes.some((n) => n.includes("`RENOVATE_PLATFORM=github`") && n.includes("authenticate"))).toBe(true);
  });

  it("surfaces an info note when GITLAB_TOKEN is set without RENOVATE_TOKEN under platform=gitlab", () => {
    const ctx = inspectPlatformContext({
      ...clean(),
      RENOVATE_PLATFORM: "gitlab",
      GITLAB_TOKEN: "x",
    });
    expect(
      ctx.notes.some((n) =>
        n.startsWith("Info:")
          && n.includes("GITLAB_TOKEN")
          && n.includes("RENOVATE_TOKEN")
          && n.includes("auto"),
      ) || ctx.notes.some((n) =>
        n.startsWith("Info:")
          && n.includes("GITLAB_TOKEN")
          && n.includes("RENOVATE_TOKEN")
          && n.includes("export"),
      ),
    ).toBe(true);
    // And the failure-mode warning should NOT fire (token IS available).
    expect(ctx.notes.some((n) => n.includes("authenticate"))).toBe(false);
  });

  it("surfaces an info note when GITHUB_TOKEN is set without RENOVATE_TOKEN under platform=github", () => {
    const ctx = inspectPlatformContext({
      ...clean(),
      RENOVATE_PLATFORM: "github",
      GITHUB_TOKEN: "x",
    });
    expect(
      ctx.notes.some((n) =>
        n.startsWith("Info:") && n.includes("GITHUB_TOKEN") && n.includes("RENOVATE_TOKEN"),
      ),
    ).toBe(true);
    expect(ctx.notes.some((n) => n.includes("authenticate"))).toBe(false);
  });

  it("does NOT surface the info note when RENOVATE_TOKEN is also set", () => {
    const ctx = inspectPlatformContext({
      ...clean(),
      RENOVATE_PLATFORM: "gitlab",
      GITLAB_TOKEN: "x",
      RENOVATE_TOKEN: "y",
    });
    expect(ctx.notes.some((n) => n.startsWith("Info:"))).toBe(false);
  });

  it("flags an endpoint that looks like a UI URL", () => {
    const ctx = inspectPlatformContext({
      ...clean(),
      RENOVATE_PLATFORM: "gitlab",
      GITLAB_TOKEN: "x",
      RENOVATE_ENDPOINT: "https://gitlab.example.com/",
    });
    expect(ctx.notes.some((n) => n.includes("looks like a UI URL"))).toBe(true);
  });

  it("does not flag an API URL endpoint", () => {
    const ctx = inspectPlatformContext({
      ...clean(),
      RENOVATE_PLATFORM: "gitlab",
      GITLAB_TOKEN: "x",
      RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4/",
    });
    expect(ctx.notes.some((n) => n.includes("looks like a UI URL"))).toBe(false);
  });
});

describe("describeSetup platform context block", () => {
  it("renders tokens by presence only and surfaces notes", () => {
    const out = describeSetup(buildStatus({
      platformContext: {
        renovatePlatform: "gitlab",
        renovateEndpoint: "https://gitlab.example.com/",
        tokensPresent: { RENOVATE_TOKEN: false, GITHUB_TOKEN: false, GITLAB_TOKEN: true },
        effectiveDryRunPlatform: "gitlab",
        notes: ["RENOVATE_ENDPOINT looks like a UI URL"],
      },
    }));
    expect(out).toContain("Platform context:");
    expect(out).toContain("RENOVATE_PLATFORM: gitlab");
    expect(out).toContain("GITLAB_TOKEN=set");
    expect(out).toContain("RENOVATE_TOKEN=unset");
    expect(out).toContain("Effective dry_run platform (when input unset): gitlab");
    expect(out).toContain("UI URL");
  });
});
