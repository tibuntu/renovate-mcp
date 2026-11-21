import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { resolveBundledBinary } from "../../src/lib/renovateCli.js";

/**
 * Renovate's global-config loader picks up `config.js` from its working
 * directory unless `RENOVATE_CONFIG_FILE` names another file, and the
 * validator runs the same loader. Every spawn must load only config it was
 * pointed at. Uses the REAL bundled binaries: a fake binary never runs the
 * loader. The fixture `config.js` only drops a marker file next to itself.
 */

const validatorBin = resolveBundledBinary("renovate-config-validator");
const renovateBin = resolveBundledBinary("renovate");

const MARKER = "config-js-loaded";
const markerScript = (name: string) =>
  `require("node:fs").writeFileSync(require("node:path").join(__dirname, ${JSON.stringify(name)}), "");\nmodule.exports = {};\n`;

let repo: string;
let session: McpSession | undefined;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), `rmcp-spawn-isolation-${process.pid}-`));
  await writeFile(path.join(repo, "config.js"), markerScript(MARKER));
  await writeFile(path.join(repo, "renovate.json"), "{}\n");
});

afterEach(async () => {
  await session?.close();
  session = undefined;
  await rm(repo, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await session!.request<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>("tools/call", { name, arguments: args });
  return { isError: res.result?.isError, text: res.result!.content[0]!.text };
}

describe.skipIf(!validatorBin)("validator spawns ignore the server's working directory", () => {
  beforeEach(async () => {
    session = await startServer(
      { RENOVATE_CONFIG_VALIDATOR_BIN: undefined },
      { cwd: repo, requestTimeoutMs: 60_000 },
    );
  });

  it("validate_config does not load config.js from the server cwd", async () => {
    const { isError } = await call("validate_config", { configContent: { extends: ["config:recommended"] } });
    expect(isError).toBeFalsy();
    expect(existsSync(path.join(repo, MARKER))).toBe(false);
  }, 60_000);

  it("write_config does not load config.js from the server cwd", async () => {
    const { isError } = await call("write_config", { repoPath: repo, config: { extends: ["config:recommended"] } });
    expect(isError).toBeFalsy();
    expect(existsSync(path.join(repo, MARKER))).toBe(false);
  }, 60_000);
});

describe.skipIf(!validatorBin)("check_setup's version probe ignores the server's working directory", () => {
  it("does not load config.js when the validator binary is overridden", async () => {
    // An override (not the bundled fast path) makes the probe spawn; the
    // validator runs the config loader before it handles --version.
    session = await startServer(
      { RENOVATE_CONFIG_VALIDATOR_BIN: validatorBin! },
      { cwd: repo, requestTimeoutMs: 60_000 },
    );
    await call("check_setup", {});
    expect(existsSync(path.join(repo, MARKER))).toBe(false);
  }, 60_000);
});
