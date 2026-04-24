import { describe, it, expect } from "vitest";
import { detectLookupProblems } from "../../src/lib/lookupProblems.js";

describe("detectLookupProblems", () => {
  it("returns [] for empty input", () => {
    expect(detectLookupProblems("")).toEqual([]);
  });

  it("returns [] when nothing looks like an auth failure", () => {
    const log = [
      '{"level":30,"msg":"packagist lookup succeeded"}',
      '{"level":30,"msg":"0 branches updated"}',
      "Renovate finished without errors",
    ].join("\n");
    expect(detectLookupProblems(log)).toEqual([]);
  });

  it("extracts Renovate JSON log entries that signal 401/403", () => {
    const log = [
      '{"level":40,"msg":"packagist registry lookup failed","datasource":"packagist","packageName":"acme/internal","err":{"message":"Response code 401 (Unauthorized)"}}',
      '{"level":30,"msg":"starting lookup"}',
      '{"level":40,"msg":"npm lookup failed","datasource":"npm","packageName":"@acme/ui","err":{"message":"403 Forbidden from registry.acme.corp"}}',
    ].join("\n");

    const problems = detectLookupProblems(log);
    expect(problems).toHaveLength(2);
    const [first, second] = problems as [typeof problems[number], typeof problems[number]];
    expect(first.message).toContain("401");
    expect(first.context).toContain("datasource=packagist");
    expect(first.context).toContain("package=acme/internal");
    expect(second.message).toContain("403 Forbidden");
    expect(second.context).toContain("datasource=npm");
  });

  it("catches 'unauthorized' / 'requires authentication' / 'invalid credentials'", () => {
    const log = [
      '{"msg":"Lookup failed","err":{"message":"Unauthorized"}}',
      '{"msg":"requires authentication"}',
      '{"msg":"Invalid credentials for registry"}',
    ].join("\n");

    const problems = detectLookupProblems(log);
    expect(problems.map((p) => p.message)).toEqual([
      "Lookup failed — Unauthorized",
      "requires authentication",
      "Invalid credentials for registry",
    ]);
  });

  it("falls back to plain-text scanning when lines aren't JSON", () => {
    const log = [
      "Some non-JSON warning line",
      "npm ERR! 401 Unauthorized - GET https://registry.acme.corp/@acme%2fui",
      "Everything is fine",
    ].join("\n");

    const problems = detectLookupProblems(log);
    expect(problems).toHaveLength(1);
    const [only] = problems as [typeof problems[number]];
    expect(only.message).toContain("401 Unauthorized");
    expect(only.context).toBeUndefined();
  });

  it("deduplicates identical messages (same context)", () => {
    const line = '{"msg":"lookup failed","datasource":"packagist","packageName":"acme/x","err":{"message":"401"}}';
    const log = Array.from({ length: 5 }, () => line).join("\n");
    expect(detectLookupProblems(log)).toHaveLength(1);
  });

  it("keeps separate entries when context differs", () => {
    const log = [
      '{"msg":"lookup failed","datasource":"packagist","packageName":"acme/x","err":{"message":"401"}}',
      '{"msg":"lookup failed","datasource":"packagist","packageName":"acme/y","err":{"message":"401"}}',
    ].join("\n");
    expect(detectLookupProblems(log)).toHaveLength(2);
  });

  it("caps output so a flood of failures can't blow up the caller's context", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      `{"msg":"lookup failed","datasource":"npm","packageName":"pkg-${i}","err":{"message":"401"}}`,
    );
    const problems = detectLookupProblems(lines.join("\n"));
    expect(problems.length).toBeLessThanOrEqual(10);
  });

  it("ignores 401 embedded inside a larger number", () => {
    const log = '{"msg":"downloaded 4011 packages"}';
    expect(detectLookupProblems(log)).toEqual([]);
  });

  it("ignores malformed JSON lines that don't match auth patterns", () => {
    const log = "{not json";
    expect(detectLookupProblems(log)).toEqual([]);
  });

  it("truncates very long messages", () => {
    const longMsg = "unauthorized: " + "x".repeat(400);
    const log = JSON.stringify({ msg: longMsg });
    const problems = detectLookupProblems(log);
    expect(problems).toHaveLength(1);
    const [only] = problems as [typeof problems[number]];
    expect(only.message.length).toBeLessThanOrEqual(300);
    expect(only.message.endsWith("…")).toBe(true);
  });
});
