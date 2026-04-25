import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * The happy path for renovate.json and the missing-config path are already
 * covered by mcpServer.test.ts. This file adds the package.json#renovate and
 * JSON5 paths that were previously only exercised at the unit level — the
 * issue #59 audit flagged these as untested through the real MCP response
 * layer.
 *
 * All tests here use the default env, so we share one server across the whole
 * file to keep concurrent startup pressure low when the full suite runs.
 */

let session: McpSession;
let repo: string;

beforeAll(async () => {
  session = await startServer({}, { requestTimeoutMs: 30_000 });
});

afterAll(async () => {
  if (session) await session.close();
});

beforeEach(async () => {
  repo = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function readConfig(repoPath: string) {
  const res = await session.request<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>("tools/call", { name: "read_config", arguments: { repoPath } });
  return res.result!;
}

describe("read_config", () => {
  it("returns the renovate field from package.json when no dedicated file exists", async () => {
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "example",
        renovate: { extends: ["config:recommended"], schedule: ["weekly"] },
      }),
    );

    const result = await readConfig(repo);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.path).toBe("package.json");
    expect(parsed.format).toBe("package.json");
    expect(parsed.config).toMatchObject({
      extends: ["config:recommended"],
      schedule: ["weekly"],
    });
  });

  it("treats a non-object renovate field in package.json as no config found", async () => {
    // Renovate only recognises package.json#renovate when it's an object.
    // An array / string / number is silently ignored — read_config should
    // report the config as missing rather than surfacing a parse error.
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "example", renovate: ["not", "an", "object"] }),
    );

    const result = await readConfig(repo);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("No Renovate configuration found");
  });

  it("parses a renovate.json5 config with comments and trailing commas", async () => {
    await writeFile(
      path.join(repo, "renovate.json5"),
      [
        "// Renovate config authored in JSON5",
        "{",
        "  extends: ['config:recommended'],",
        "  schedule: ['before 6am on monday',],",
        "}",
        "",
      ].join("\n"),
    );

    const result = await readConfig(repo);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.path).toBe("renovate.json5");
    expect(parsed.format).toBe("json5");
    expect(parsed.config).toMatchObject({
      extends: ["config:recommended"],
      schedule: ["before 6am on monday"],
    });
  });

  it("prefers renovate.json over .github/renovate.json when both exist", async () => {
    await mkdir(path.join(repo, ".github"));
    await writeFile(
      path.join(repo, ".github", "renovate.json"),
      JSON.stringify({ extends: ["config:base"] }),
    );
    await writeFile(
      path.join(repo, "renovate.json"),
      JSON.stringify({ extends: ["config:recommended"] }),
    );

    const result = await readConfig(repo);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.path).toBe("renovate.json");
    expect(parsed.config).toMatchObject({ extends: ["config:recommended"] });
  });
});
