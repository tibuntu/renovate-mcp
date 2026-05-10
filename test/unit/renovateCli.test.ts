import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveRenovateTool,
  formatMissingBinaryError,
  run,
} from "../../src/lib/renovateCli.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveRenovateTool", () => {
  it("resolves the bundled `renovate` binary when RENOVATE_BIN is unset", () => {
    delete process.env.RENOVATE_BIN;
    const resolved = resolveRenovateTool("renovate");
    // Renovate is a runtime dep, so the bundled lookup should always succeed
    // in the test environment. The returned cmd is `node`, with the JS path
    // prefix-arg pointing at the renovate package's `bin.renovate` entry.
    expect(resolved.source).toBe("bundled");
    expect(resolved.cmd).toBe(process.execPath);
    expect(resolved.prefixArgs).toHaveLength(1);
    expect(resolved.prefixArgs[0]).toMatch(/renovate\/dist\/renovate\.js$/);
    // `command` is the raw tool name — the `(bundled)` label is composed by
    // formatters using `source`, so callers can render hints cleanly without
    // nested parens.
    expect(resolved.command).toBe("renovate");
  });

  it("respects RENOVATE_BIN as an explicit override", () => {
    process.env.RENOVATE_BIN = "/opt/custom/renovate";
    expect(resolveRenovateTool("renovate")).toEqual({
      cmd: "/opt/custom/renovate",
      prefixArgs: [],
      source: "env",
      command: "/opt/custom/renovate",
    });
  });

  it("resolves the bundled validator when RENOVATE_CONFIG_VALIDATOR_BIN is unset", () => {
    delete process.env.RENOVATE_CONFIG_VALIDATOR_BIN;
    const resolved = resolveRenovateTool("renovate-config-validator");
    expect(resolved.source).toBe("bundled");
    expect(resolved.cmd).toBe(process.execPath);
    expect(resolved.prefixArgs[0]).toMatch(/renovate\/dist\/config-validator\.js$/);
    expect(resolved.command).toBe("renovate-config-validator");
  });

  it("respects RENOVATE_CONFIG_VALIDATOR_BIN as an explicit override", () => {
    process.env.RENOVATE_CONFIG_VALIDATOR_BIN = "/opt/custom/validator";
    expect(resolveRenovateTool("renovate-config-validator")).toEqual({
      cmd: "/opt/custom/validator",
      prefixArgs: [],
      source: "env",
      command: "/opt/custom/validator",
    });
  });
});

describe("run() streaming observers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(
      path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeScript(contents: string): Promise<string> {
    const file = path.join(dir, "emit.mjs");
    await writeFile(file, `#!/usr/bin/env node\n${contents}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it("emits stdout lines split on newline (including chunks that split a line)", async () => {
    // Small sleeps force the runtime to deliver the stdout in two `data`
    // events so we also exercise the cross-chunk buffering.
    const script = await makeScript(`
      process.stdout.write("alpha\\nbeta");
      await new Promise(r => setTimeout(r, 30));
      process.stdout.write("-continued\\ngamma\\n");
    `);

    const lines: string[] = [];
    const res = await run(process.execPath, [script], {
      onStdoutLine: (l) => lines.push(l),
    });

    expect(res.exitCode).toBe(0);
    expect(lines).toEqual(["alpha", "beta-continued", "gamma"]);
    expect(res.stdout).toBe("alpha\nbeta-continued\ngamma\n");
  });

  it("flushes a trailing non-newline-terminated line on process close", async () => {
    const script = await makeScript(`process.stdout.write("no-newline-here");`);

    const lines: string[] = [];
    await run(process.execPath, [script], {
      onStdoutLine: (l) => lines.push(l),
    });

    expect(lines).toEqual(["no-newline-here"]);
  });

  it("routes stderr lines through onStderrLine independently", async () => {
    const script = await makeScript(`
      process.stdout.write("to-out\\n");
      process.stderr.write("to-err-1\\nto-err-2\\n");
    `);

    const out: string[] = [];
    const err: string[] = [];
    await run(process.execPath, [script], {
      onStdoutLine: (l) => out.push(l),
      onStderrLine: (l) => err.push(l),
    });

    expect(out).toEqual(["to-out"]);
    expect(err).toEqual(["to-err-1", "to-err-2"]);
  });

  it("swallows exceptions thrown by observers without losing later lines", async () => {
    const script = await makeScript(`
      process.stdout.write("a\\nb\\nc\\n");
    `);

    const seen: string[] = [];
    await run(process.execPath, [script], {
      onStdoutLine: (l) => {
        seen.push(l);
        if (l === "b") throw new Error("observer boom");
      },
    });

    // All three lines were delivered even though one observer call threw.
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("populates RunResult.runtimeWarnings when stderr contains the RE2 WARN", async () => {
    const script = await makeScript(`
      process.stderr.write("WARN: RE2 not usable, falling back to RegExp\\n");
      process.stdout.write("99.0.0\\n");
    `);
    const result = await run(process.execPath, [script]);
    expect(result.exitCode).toBe(0);
    expect(result.runtimeWarnings).toHaveLength(1);
    expect(result.runtimeWarnings[0]?.kind).toBe("re2-unusable");
  });

  it("returns an empty runtimeWarnings array when stderr is clean", async () => {
    const script = await makeScript(`process.stdout.write("ok\\n");`);
    const result = await run(process.execPath, [script]);
    expect(result.runtimeWarnings).toEqual([]);
  });
});

describe("formatMissingBinaryError", () => {
  it("names the tool, the env var, mentions the bundled fallback, and points at check_setup", () => {
    const msg = formatMissingBinaryError(
      "renovate",
      new Error("spawn renovate ENOENT"),
    );
    expect(msg).toContain("renovate");
    expect(msg).toContain("RENOVATE_BIN");
    expect(msg).toContain("check_setup");
    expect(msg).toContain("bundled");
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
