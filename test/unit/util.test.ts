import { describe, it, expect } from "vitest";
import { isRecord, truncate } from "../../src/lib/util.js";

describe("isRecord", () => {
  it("accepts plain objects (including null-prototype and class instances)", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date())).toBe(true);
  });

  it("rejects null, arrays and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("", 5)).toBe("");
  });

  it("cuts to max characters including the ellipsis", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(truncate("abcdefgh", 5)).toHaveLength(5);
  });

  it("trims trailing whitespace before the ellipsis", () => {
    expect(truncate("abcd efgh", 6)).toBe("abcd…");
  });
});
