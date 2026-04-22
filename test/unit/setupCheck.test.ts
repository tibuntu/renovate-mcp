import { describe, it, expect, afterEach } from "vitest";
import { checkSetup, describeSetup } from "../../src/lib/setupCheck.js";

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

  it("shows MISSING for not-found binaries and lists hints", () => {
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
