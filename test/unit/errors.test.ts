import { describe, it, expect } from "vitest";
import { toMessage, toError } from "../../src/lib/errors.js";

describe("toMessage", () => {
  it("extracts message from Error instances", () => {
    expect(toMessage(new Error("boom"))).toBe("boom");
  });

  it("returns strings as-is", () => {
    expect(toMessage("nope")).toBe("nope");
  });

  it("JSON-stringifies plain objects", () => {
    expect(toMessage({ code: "ENOENT" })).toBe('{"code":"ENOENT"}');
  });

  it("handles values that are not JSON-serializable (circular)", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(toMessage(obj)).toBe("[object Object]");
  });

  it("handles undefined and null without crashing", () => {
    expect(toMessage(undefined)).toBe("undefined");
    expect(toMessage(null)).toBe("null");
  });

  it("extracts message from Error subclasses", () => {
    class MyErr extends Error {
      constructor() {
        super("subclass-msg");
        this.name = "MyErr";
      }
    }
    expect(toMessage(new MyErr())).toBe("subclass-msg");
  });
});

describe("toError", () => {
  it("returns Error instances unchanged", () => {
    const e = new Error("x");
    expect(toError(e)).toBe(e);
  });

  it("wraps non-Error values into Error with toMessage() text", () => {
    const wrapped = toError("oops");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("oops");
  });

  it("wraps plain objects via JSON.stringify", () => {
    expect(toError({ a: 1 }).message).toBe('{"a":1}');
  });
});
