import { describe, it, expect } from "vitest";
import {
  extractRenovateLogMsg,
  buildDryRunHeartbeatMessage,
  DEFAULT_MAX_LOG_MSG_LEN,
} from "../../src/lib/dryRunProgress.js";

describe("extractRenovateLogMsg", () => {
  it("returns the msg field from a JSON log line", () => {
    const line = JSON.stringify({ level: 30, msg: "Fetching manifests" });
    expect(extractRenovateLogMsg(line)).toBe("Fetching manifests");
  });

  it("trims whitespace around the msg", () => {
    const line = JSON.stringify({ msg: "  Scanning npm  \n" });
    expect(extractRenovateLogMsg(line)).toBe("Scanning npm");
  });

  it("truncates very long messages to the configured cap", () => {
    const long = "x".repeat(500);
    const line = JSON.stringify({ msg: long });
    expect(extractRenovateLogMsg(line, 50)).toBe("x".repeat(50));
    // Default cap is the exported constant.
    expect(extractRenovateLogMsg(line)).toHaveLength(DEFAULT_MAX_LOG_MSG_LEN);
  });

  it("returns undefined for non-JSON lines", () => {
    expect(extractRenovateLogMsg("not json at all")).toBeUndefined();
    expect(extractRenovateLogMsg("")).toBeUndefined();
  });

  it("returns undefined when JSON has no string msg", () => {
    expect(extractRenovateLogMsg(JSON.stringify({ level: 30 }))).toBeUndefined();
    expect(extractRenovateLogMsg(JSON.stringify({ msg: 42 }))).toBeUndefined();
    expect(extractRenovateLogMsg(JSON.stringify({ msg: "   " }))).toBeUndefined();
    expect(extractRenovateLogMsg(JSON.stringify(null))).toBeUndefined();
    expect(extractRenovateLogMsg(JSON.stringify("a string"))).toBeUndefined();
  });
});

describe("buildDryRunHeartbeatMessage", () => {
  it("falls back to generic elapsed message when no log msg has been seen", () => {
    expect(buildDryRunHeartbeatMessage(0, undefined)).toBe(
      "Dry-run in progress (0s elapsed)",
    );
    expect(buildDryRunHeartbeatMessage(12_400, undefined)).toBe(
      "Dry-run in progress (12s elapsed)",
    );
  });

  it("enriches with the latest Renovate log msg when available", () => {
    expect(
      buildDryRunHeartbeatMessage(30_000, "Looking up npm package lodash"),
    ).toBe("Dry-run in progress (30s) — Looking up npm package lodash");
  });

  it("rounds elapsed time to the nearest second and never goes negative", () => {
    expect(buildDryRunHeartbeatMessage(1_400, undefined)).toBe(
      "Dry-run in progress (1s elapsed)",
    );
    expect(buildDryRunHeartbeatMessage(1_600, undefined)).toBe(
      "Dry-run in progress (2s elapsed)",
    );
    // Clock skew defensive check — Date.now() drift shouldn't produce "-1s".
    expect(buildDryRunHeartbeatMessage(-5, undefined)).toBe(
      "Dry-run in progress (0s elapsed)",
    );
  });
});
