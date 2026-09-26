import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * Runs the REAL bundled `renovate-config-validator` (no
 * RENOVATE_CONFIG_VALIDATOR_BIN override) so we catch drift in how the
 * validator interprets positional files. Without `--no-global` the validator
 * treats a positional file as GLOBAL self-hosted config, which silently
 * accepts global-only options like `token` in a repo config.
 */

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

async function validate(configContent: Record<string, unknown>) {
  // `undefined` env values are dropped by child_process, so this clears any
  // inherited override and lets resolveRenovateTool pick the bundled binary.
  session = await startServer(
    { RENOVATE_CONFIG_VALIDATOR_BIN: undefined },
    { requestTimeoutMs: 60_000 },
  );
  const res = await session.request<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>("tools/call", { name: "validate_config", arguments: { configContent } });
  return {
    isError: res.result?.isError,
    payload: JSON.parse(res.result!.content[0]!.text) as { valid: boolean; output: string },
  };
}

describe("validate_config against the real bundled validator", () => {
  it("rejects a global-only option (`token`) in a repo config", async () => {
    const { isError, payload } = await validate({
      extends: ["config:recommended"],
      token: "abc",
    });
    expect(isError).toBe(true);
    expect(payload.valid).toBe(false);
    expect(payload.output).toContain("token");
  }, 60_000);

  it("accepts a plain repo config", async () => {
    const { isError, payload } = await validate({ extends: ["config:recommended"] });
    expect(isError).toBeFalsy();
    expect(payload.valid).toBe(true);
  }, 60_000);
});
