import { describe, it, expect, afterEach } from "vitest";
import {
  resolveRenovateTool,
  formatMissingBinaryError,
} from "../../src/lib/renovateCli.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveRenovateTool", () => {
  it("falls back to 'renovate' when RENOVATE_BIN is unset", () => {
    delete process.env.RENOVATE_BIN;
    expect(resolveRenovateTool("renovate")).toBe("renovate");
  });

  it("respects RENOVATE_BIN", () => {
    process.env.RENOVATE_BIN = "/opt/custom/renovate";
    expect(resolveRenovateTool("renovate")).toBe("/opt/custom/renovate");
  });

  it("falls back to 'renovate-config-validator' when RENOVATE_CONFIG_VALIDATOR_BIN is unset", () => {
    delete process.env.RENOVATE_CONFIG_VALIDATOR_BIN;
    expect(resolveRenovateTool("renovate-config-validator")).toBe(
      "renovate-config-validator",
    );
  });

  it("respects RENOVATE_CONFIG_VALIDATOR_BIN", () => {
    process.env.RENOVATE_CONFIG_VALIDATOR_BIN = "/opt/custom/validator";
    expect(resolveRenovateTool("renovate-config-validator")).toBe(
      "/opt/custom/validator",
    );
  });
});

describe("formatMissingBinaryError", () => {
  it("names the tool, the env var, and points at check_setup", () => {
    const msg = formatMissingBinaryError(
      "renovate",
      new Error("spawn renovate ENOENT"),
    );
    expect(msg).toContain("renovate");
    expect(msg).toContain("RENOVATE_BIN");
    expect(msg).toContain("check_setup");
    expect(msg).toContain("spawn renovate ENOENT");
  });

  it("references RENOVATE_CONFIG_VALIDATOR_BIN for the validator tool", () => {
    const msg = formatMissingBinaryError(
      "renovate-config-validator",
      new Error("spawn ENOENT"),
    );
    expect(msg).toContain("RENOVATE_CONFIG_VALIDATOR_BIN");
  });
});
