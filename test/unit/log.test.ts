import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logError } from "../../src/lib/log.js";

describe("logError", () => {
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrWrite.mockRestore();
  });

  it("writes to stderr with a recognizable prefix", () => {
    logError("hello");
    expect(stderrWrite).toHaveBeenCalledOnce();
    expect(stderrWrite.mock.calls[0]?.[0]).toBe("[renovate-mcp] hello\n");
  });

  it("appends an Error's stack when provided as reason", () => {
    const err = new Error("boom");
    logError("uncaught exception", err);
    const out = stderrWrite.mock.calls[0]?.[0] as string;
    expect(out.startsWith("[renovate-mcp] uncaught exception: ")).toBe(true);
    expect(out).toContain("boom");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("stringifies non-Error reasons", () => {
    logError("unhandled rejection", { code: 42 });
    expect(stderrWrite.mock.calls[0]?.[0]).toBe(
      `[renovate-mcp] unhandled rejection: {"code":42}\n`,
    );
  });

  it("falls back to String() for values JSON.stringify cannot handle", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    logError("unhandled rejection", circular);
    const out = stderrWrite.mock.calls[0]?.[0] as string;
    expect(out.startsWith("[renovate-mcp] unhandled rejection: ")).toBe(true);
    expect(out).toContain("[object Object]");
  });

  it("never writes to stdout", () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      logError("anything", new Error("x"));
      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});
