import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * check_setup never shells out to the real Renovate CLI in tests — CI doesn't
 * install it. We stub both binaries with `/bin/echo` (exits 0 on --version) for
 * the happy path, or point them at nonexistent paths for the failure path, and
 * verify the MCP response shape end-to-end.
 */

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

// The tool response is `${summary}\n\n${JSON.stringify(status, null, 2)}` —
// the summary itself contains blank lines (hints block), so extract the
// trailing JSON by finding the last `{` that starts a line.
function extractTrailingJson(text: string): string {
  const idx = text.lastIndexOf("\n{");
  if (idx === -1) throw new Error(`no JSON payload in response:\n${text}`);
  return text.slice(idx + 1);
}

describe("check_setup", () => {
  it("reports ok with no isError when both binaries are discoverable", async () => {
    session = await startServer(
      {
        RENOVATE_BIN: "/bin/echo",
        RENOVATE_CONFIG_VALIDATOR_BIN: "/bin/echo",
      },
      { requestTimeoutMs: 30_000 },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", { name: "check_setup", arguments: {} });

    expect(res.result?.isError).toBeFalsy();

    const text = res.result!.content[0]!.text;
    expect(text).toContain("Node: v");
    expect(text).toContain("renovate:");
    expect(text).toContain("renovate-config-validator:");

    const status = JSON.parse(extractTrailingJson(text)) as {
      ok: boolean;
      renovate: { found: boolean };
      renovateConfigValidator: { found: boolean };
      envOverrides: Record<string, string>;
    };
    expect(status.ok).toBe(true);
    expect(status.renovate.found).toBe(true);
    expect(status.renovateConfigValidator.found).toBe(true);
    expect(status.envOverrides).toMatchObject({
      RENOVATE_BIN: "/bin/echo",
      RENOVATE_CONFIG_VALIDATOR_BIN: "/bin/echo",
    });
  });

  it("returns isError with MISSING markers when both binaries are absent", async () => {
    session = await startServer(
      {
        RENOVATE_BIN: "/nonexistent/path/to/renovate",
        RENOVATE_CONFIG_VALIDATOR_BIN: "/nonexistent/path/to/validator",
        // Keep the startup banner out of the way so the instructions check in
        // mcpServer.test.ts still passes; it has no effect on check_setup
        // itself.
        RENOVATE_MCP_REQUIRE_CLI: "false",
      },
      { requestTimeoutMs: 30_000 },
    );

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", { name: "check_setup", arguments: {} });

    expect(res.result?.isError).toBe(true);

    const text = res.result!.content[0]!.text;
    expect(text).toContain("MISSING");
    expect(text).toContain("Hints:");

    const status = JSON.parse(extractTrailingJson(text)) as {
      ok: boolean;
      renovate: { found: boolean };
      renovateConfigValidator: { found: boolean };
      hints: string[];
    };
    expect(status.ok).toBe(false);
    expect(status.renovate.found).toBe(false);
    expect(status.renovateConfigValidator.found).toBe(false);
    expect(status.hints.length).toBe(2);
  });
});
