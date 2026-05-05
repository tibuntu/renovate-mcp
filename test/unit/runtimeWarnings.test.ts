import { describe, it, expect } from "vitest";
import {
  detectRuntimeWarnings,
  dedupeRuntimeWarnings,
} from "../../src/lib/runtimeWarnings.js";

describe("detectRuntimeWarnings", () => {
  it("returns [] for empty input", () => {
    expect(detectRuntimeWarnings("")).toEqual([]);
  });

  it("returns [] when stderr contains nothing matching", () => {
    const stderr = [
      "starting Renovate",
      "{\"level\":30,\"msg\":\"detected manifest\"}",
      "0 branches updated",
    ].join("\n");
    expect(detectRuntimeWarnings(stderr)).toEqual([]);
  });

  it("detects the pretty Renovate WARN line (matches the bug-report format)", () => {
    const stderr = [
      ' WARN: RE2 not usable, falling back to RegExp',
      '       "err": {',
      '         "code": "ERR_DLOPEN_FAILED",',
      "       }",
    ].join("\n");
    const warnings = detectRuntimeWarnings(stderr);
    expect(warnings).toHaveLength(1);
    const [w] = warnings as [typeof warnings[number]];
    expect(w.kind).toBe("re2-unusable");
    expect(w.message).toMatch(/RE2/);
    expect(w.fix).toMatch(/npm rebuild re2/);
  });

  it("detects pino-JSON line where msg includes 'RE2 not usable'", () => {
    const stderr = JSON.stringify({
      level: 40,
      msg: "RE2 not usable, falling back to RegExp",
      err: { code: "ERR_DLOPEN_FAILED", message: "/path/to/re2.node was compiled against …" },
    });
    const warnings = detectRuntimeWarnings(stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("re2-unusable");
    expect(warnings[0]?.detail).toMatch(/re2\.node/);
  });

  it("detects pino-JSON line where err.code is ERR_DLOPEN_FAILED for re2.node (no msg match)", () => {
    const stderr = JSON.stringify({
      level: 40,
      msg: "Some unrelated WARN message",
      err: {
        code: "ERR_DLOPEN_FAILED",
        message: "The module '/Users/x/node_modules/re2/build/Release/re2.node' was compiled against a different Node.js version",
      },
    });
    const warnings = detectRuntimeWarnings(stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("re2-unusable");
  });

  it("ignores ERR_DLOPEN_FAILED for unrelated native modules", () => {
    const stderr = JSON.stringify({
      level: 40,
      msg: "loader error",
      err: {
        code: "ERR_DLOPEN_FAILED",
        message: "The module '/path/to/some-other-binding.node' could not be loaded",
      },
    });
    expect(detectRuntimeWarnings(stderr)).toEqual([]);
  });

  it("dedupes multiple RE2 lines into a single warning", () => {
    const stderr = [
      "WARN: RE2 not usable, falling back to RegExp",
      JSON.stringify({ msg: "RE2 not usable, falling back to RegExp" }),
      "WARN: RE2 not usable, falling back to RegExp",
    ].join("\n");
    const warnings = detectRuntimeWarnings(stderr);
    expect(warnings).toHaveLength(1);
  });

  it("only surfaces RE2 — leaves unrelated WARN lines alone (narrow scope)", () => {
    const stderr = [
      JSON.stringify({ level: 40, msg: "Preset is deprecated" }),
      JSON.stringify({ level: 40, msg: "Repository config-warning" }),
      "WARN: RE2 not usable, falling back to RegExp",
      JSON.stringify({ level: 40, msg: "Yet another benign WARN" }),
    ].join("\n");
    const warnings = detectRuntimeWarnings(stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("re2-unusable");
  });

  it("truncates very long error detail", () => {
    const stderr = JSON.stringify({
      msg: "RE2 not usable, falling back to RegExp",
      err: {
        code: "ERR_DLOPEN_FAILED",
        message: "re2.node " + "x".repeat(500),
      },
    });
    const warnings = detectRuntimeWarnings(stderr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail?.length ?? 0).toBeLessThanOrEqual(300);
    expect(warnings[0]?.detail?.endsWith("…")).toBe(true);
  });

  it("ignores malformed JSON lines that don't trip the plain-text matcher", () => {
    expect(detectRuntimeWarnings("{not json")).toEqual([]);
  });
});

describe("dedupeRuntimeWarnings", () => {
  it("collapses by kind, preserving first occurrence", () => {
    const out = dedupeRuntimeWarnings([
      { kind: "re2-unusable", message: "first", fix: "fix-A" },
      { kind: "re2-unusable", message: "second", fix: "fix-B" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toBe("first");
  });

  it("returns an empty array unchanged", () => {
    expect(dedupeRuntimeWarnings([])).toEqual([]);
  });
});
