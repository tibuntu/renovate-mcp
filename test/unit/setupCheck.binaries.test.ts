import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../../src/lib/renovateCli.js";

// checkBinary's spawn path and the bundled package.json reads are the only
// parts of setupCheck that need a controlled `run` / filesystem; everything
// else is covered with real inputs in the sibling setupCheck test files.
const runMock = vi.fn<(...args: unknown[]) => Promise<RunResult>>();
const resolveMock = vi.fn();
vi.mock("../../src/lib/renovateCli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/renovateCli.js")>()),
  run: (...args: unknown[]) => runMock(...args),
  resolveRenovateTool: (...args: unknown[]) => resolveMock(...args),
}));

const { checkSetup, checkRenovateEnginesMatch } = await import("../../src/lib/setupCheck.js");

const realReadFileSync = fs.readFileSync;
/** Replace the bundled renovate/package.json with `body` (a string, or an Error to throw). */
function stubRenovatePackageJson(body: string | Error): void {
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).endsWith("renovate/package.json")) {
      if (body instanceof Error) throw body;
      return body;
    }
    return (realReadFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
}

const result = (overrides: Partial<RunResult>): RunResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  runtimeWarnings: [],
  truncated: false,
  ...overrides,
});

beforeEach(() => {
  resolveMock.mockImplementation((tool: string) => ({
    cmd: "/fake/node",
    prefixArgs: ["/fake/cli.js"],
    source: "bundled",
    command: tool,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  runMock.mockReset();
  resolveMock.mockReset();
});

describe("checkBinary via checkSetup", () => {
  it("reads the bundled version from package.json without spawning", async () => {
    stubRenovatePackageJson(JSON.stringify({ version: "44.0.0" }));
    const status = await checkSetup();
    expect(status.renovate).toMatchObject({ found: true, version: "44.0.0", source: "bundled" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("falls back to spawning when the bundled package.json has no usable version", async () => {
    stubRenovatePackageJson(JSON.stringify({ version: 44 }));
    runMock.mockResolvedValue(result({ stdout: "44.1.0\n" }));
    const status = await checkSetup();
    expect(status.renovate).toMatchObject({ found: true, version: "44.1.0" });
    expect(runMock).toHaveBeenCalled();
  });

  it("falls back to spawning when the bundled package.json cannot be read", async () => {
    stubRenovatePackageJson(new Error("EACCES"));
    runMock.mockResolvedValue(result({ stdout: "" }));
    const status = await checkSetup();
    // An empty --version output still counts as found, just without a version.
    expect(status.renovate).toMatchObject({ found: true, version: undefined });
  });

  it.each([
    ["stderr", { stderr: "boom\n", stdout: "ignored" }, "boom"],
    ["stdout when stderr is empty", { stdout: "usage error\n" }, "usage error"],
    ["the exit code when both are empty", {}, "exit code 2"],
  ])("reports a non-zero exit with %s as the error", async (_name, streams, error) => {
    resolveMock.mockImplementation((tool: string) => ({ cmd: "/x", prefixArgs: [], source: "env", command: tool }));
    runMock.mockResolvedValue(result({ exitCode: 2, ...streams }));
    const status = await checkSetup();
    expect(status.renovate).toMatchObject({ found: false, error });
    expect(status.renovate.runtimeWarnings).toBeUndefined();
  });

  it("keeps runtime warnings from a failed probe", async () => {
    resolveMock.mockImplementation((tool: string) => ({ cmd: "/x", prefixArgs: [], source: "path", command: tool }));
    const warning = { kind: "re2", message: "RE2 unavailable", fix: "reinstall" };
    runMock.mockResolvedValue(result({ exitCode: 1, stderr: "x", runtimeWarnings: [warning] as RunResult["runtimeWarnings"] }));
    const status = await checkSetup();
    expect(status.renovate.runtimeWarnings).toEqual([warning]);
  });
});

describe("checkRenovateEnginesMatch", () => {
  it("returns null when Renovate's package.json cannot be read", () => {
    stubRenovatePackageJson(new Error("ENOENT"));
    expect(checkRenovateEnginesMatch("v18.0.0")).toBeNull();
  });

  it("returns null when Renovate declares no engines.node", () => {
    stubRenovatePackageJson(JSON.stringify({ version: "44.0.0" }));
    expect(checkRenovateEnginesMatch("v18.0.0")).toBeNull();
  });

  it("surfaces the mismatch as a checkSetup hint", async () => {
    stubRenovatePackageJson(JSON.stringify({ version: "44.0.0", engines: { node: ">=999.0.0" } }));
    const status = await checkSetup();
    expect(status.hints.some((h) => h.includes("Renovate requires Node `>=999.0.0`"))).toBe(true);
  });
});
