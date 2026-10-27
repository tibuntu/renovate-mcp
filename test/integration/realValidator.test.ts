import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { resolveBundledBinary } from "../../src/lib/renovateCli.js";

/**
 * Runs the REAL bundled `renovate-config-validator` (no
 * RENOVATE_CONFIG_VALIDATOR_BIN override) so we catch drift in how the
 * validator interprets positional files. Without `--no-global` the validator
 * treats a positional file as GLOBAL self-hosted config, which silently
 * accepts global-only options like `token` in a repo config.
 *
 * The write_config block covers the full temp-file → validate → rename path:
 * the validator must accept the temp file's name (it dispatches on the
 * extension) and its bytes (a round-trip edit hands it JSONC with comments).
 * Fake validators never see either, which is how the suffix bug fixed in
 * 1.5.0 shipped (issue #422).
 */

// Skip, don't fail, when the bundled binary is absent so the fake-binary
// suite still runs on a machine without Renovate.
const hasValidator = resolveBundledBinary("renovate-config-validator") !== null;

// In CI `renovate` is installed as a runtime dependency, so a failed lookup
// there is a regression — fail loudly instead of hiding it as a silent skip.
it.runIf(process.env.CI)("bundled renovate-config-validator resolves", () => {
  expect(hasValidator).toBe(true);
});

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

async function start() {
  // `undefined` env values are dropped by child_process, so this clears any
  // inherited override and lets resolveRenovateTool pick the bundled binary.
  session = await startServer(
    { RENOVATE_CONFIG_VALIDATOR_BIN: undefined },
    { requestTimeoutMs: 60_000 },
  );
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await session.request<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>("tools/call", { name, arguments: args });
  return {
    isError: res.result?.isError,
    payload: JSON.parse(res.result!.content[0]!.text) as Record<string, unknown>,
  };
}

describe.skipIf(!hasValidator)("validate_config against the real bundled validator", () => {
  beforeEach(start);

  it("rejects a global-only option (`token`) in a repo config", async () => {
    const { isError, payload } = await call("validate_config", {
      configContent: { extends: ["config:recommended"], token: "abc" },
    });
    expect(isError).toBe(true);
    expect(payload.valid).toBe(false);
    expect(payload.output).toContain("token");
  }, 60_000);

  it("accepts a plain repo config", async () => {
    const { isError, payload } = await call("validate_config", {
      configContent: { extends: ["config:recommended"] },
    });
    expect(isError).toBeFalsy();
    expect(payload.valid).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasValidator)("write_config against the real bundled validator", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(
      path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
    );
    await start();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("writes a fresh renovate.json and leaves no temp file behind", async () => {
    const { isError, payload } = await call("write_config", {
      repoPath: repo,
      config: { extends: ["config:recommended"] },
    });
    expect(isError).toBeFalsy();
    expect(payload).toMatchObject({ wrote: true, valid: true, mode: "fresh-write", path: "renovate.json" });
    expect(JSON.parse(await readFile(path.join(repo, "renovate.json"), "utf8"))).toEqual({
      extends: ["config:recommended"],
    });
    expect(await readdir(repo)).toEqual(["renovate.json"]);
  }, 60_000);

  it("round-trips an existing commented renovate.json (the validator is handed JSONC)", async () => {
    const target = path.join(repo, "renovate.json");
    await writeFile(target, '// keep me\n{ "extends": ["config:recommended"] }\n');

    const { isError, payload } = await call("write_config", {
      repoPath: repo,
      config: { extends: ["config:recommended"], automerge: false },
    });
    expect(isError).toBeFalsy();
    expect(payload).toMatchObject({ wrote: true, valid: true, mode: "round-trip" });
    const written = await readFile(target, "utf8");
    expect(written).toContain("// keep me");
    expect(written).toContain('"automerge": false');
    expect(await readdir(repo)).toEqual(["renovate.json"]);
  }, 60_000);

  it("refuses a global-only option (`token`) and leaves the existing file untouched", async () => {
    const target = path.join(repo, "renovate.json");
    const before = '{ "extends": ["config:recommended"] }\n';
    await writeFile(target, before);

    const { isError, payload } = await call("write_config", {
      repoPath: repo,
      config: { extends: ["config:recommended"], token: "abc" },
    });
    expect(isError).toBe(true);
    expect(payload).toMatchObject({ wrote: false, reason: "validation-failed" });
    expect(payload.validationOutput).toContain("token");
    expect(await readFile(target, "utf8")).toBe(before);
    expect(await readdir(repo)).toEqual(["renovate.json"]);
  }, 60_000);
});
