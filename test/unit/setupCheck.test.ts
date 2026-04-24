import { describe, it, expect, afterEach } from "vitest";
import {
  checkSetup,
  describeSetup,
  startupBanner,
  unavailableTools,
  type SetupStatus,
} from "../../src/lib/setupCheck.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

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
      ok: false,
      hints: ["hint A", "hint B"],
    });
    expect(out).toContain("MISSING");
    expect(out).toContain("hint A");
    expect(out).toContain("RENOVATE_BIN=/x");
  });
});
