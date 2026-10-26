import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

describe("tool annotations", () => {
  it("annotates every tool; only write_config writes, and network-capable tools are open-world", async () => {
    session = await startServer();
    const res = await session.request<{ tools: Array<{ name: string; annotations?: ToolAnnotations }> }>(
      "tools/list",
    );
    const tools = res.result?.tools ?? [];
    expect(tools).toHaveLength(17);

    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof t.annotations?.[hint], `${t.name}.${hint}`).toBe("boolean");
      }
    }

    const names = (pred: (a: ToolAnnotations) => boolean) =>
      tools.filter((t) => pred(t.annotations!)).map((t) => t.name).sort();

    expect(names((a) => a.readOnlyHint === false)).toEqual(["write_config"]);
    expect(names((a) => a.destructiveHint === true)).toEqual(["write_config"]);
    expect(names((a) => a.openWorldHint === true)).toEqual([
      "annotate_dry_run",
      "check_setup",
      "dry_run",
      "explain_config",
      "resolve_config",
      "resolve_config_diff",
      "test_package_rules",
    ]);
  });
});
