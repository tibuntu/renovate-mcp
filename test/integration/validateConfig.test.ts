import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * validate_config shells out to renovate-config-validator; CI does not install
 * it. We stub the binary with tiny fake Node scripts that exit 0 (valid) or 1
 * (invalid), then check the MCP response shape through the real stdio +
 * handshake path.
 */

let repo: string;
let session: McpSession;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "rmcp-validate-"));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(repo, { recursive: true, force: true });
});

async function makeFakeValidator(
  dir: string,
  name: string,
  exitCode: 0 | 1,
  stderr = "",
): Promise<string> {
  const file = path.join(dir, name);
  const stderrLine = stderr
    ? `process.stderr.write(${JSON.stringify(stderr)});\n`
    : "";
  await writeFile(
    file,
    `#!/usr/bin/env node\n${stderrLine}process.exit(${exitCode});\n`,
  );
  await chmod(file, 0o755);
  return file;
}

describe("validate_config", () => {
  it("returns valid:true with no isError when the validator exits 0", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer(
      { RENOVATE_CONFIG_VALIDATOR_BIN: validator },
      { requestTimeoutMs: 30_000 },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "validate_config",
      arguments: { configContent: { extends: ["config:recommended"] } },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.valid).toBe(true);
  });

  it("returns valid:false with isError and forwards the validator's stderr when it exits 1", async () => {
    const validator = await makeFakeValidator(
      repo,
      "fake-fail.mjs",
      1,
      "ERROR: invalid config option: packageRules[0].matchFoo\n",
    );
    session = await startServer(
      { RENOVATE_CONFIG_VALIDATOR_BIN: validator },
      { requestTimeoutMs: 30_000 },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "validate_config",
      arguments: { configContent: { packageRules: [{ matchFoo: "bar" }] } },
    });

    expect(res.result?.isError).toBe(true);
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.valid).toBe(false);
    expect(payload.output).toContain("invalid config option");
  });

  it("validates a config file on disk via configPath", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    const configPath = path.join(repo, "renovate.json");
    await writeFile(configPath, JSON.stringify({ extends: ["config:recommended"] }));
    session = await startServer(
      { RENOVATE_CONFIG_VALIDATOR_BIN: validator },
      { requestTimeoutMs: 30_000 },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "validate_config",
      arguments: { configPath },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.valid).toBe(true);
  });

  it("returns isError when neither configPath nor configContent is supplied", async () => {
    session = await startServer({}, { requestTimeoutMs: 30_000 });
    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", { name: "validate_config", arguments: {} });

    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0]!.text).toContain(
      "Provide either configPath or configContent",
    );
  });

  it("wraps spawn failures via formatMissingBinaryError when the validator is not found", async () => {
    session = await startServer(
      { RENOVATE_CONFIG_VALIDATOR_BIN: "/nonexistent/path/to/validator" },
      { requestTimeoutMs: 30_000 },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "validate_config",
      arguments: { configContent: { extends: ["config:recommended"] } },
    });

    expect(res.result?.isError).toBe(true);
    const text = res.result!.content[0]!.text;
    expect(text).toContain("renovate-config-validator");
    expect(text).toContain("check_setup");
  });
});
