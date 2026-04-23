import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type McpSession } from "../helpers/mcpSession.js";

/**
 * write_config's rollback contract: a failed validation must never leave
 * renovate.json (or the .renovate-mcp-tmp temp file) on disk. We exercise this
 * by pointing RENOVATE_CONFIG_VALIDATOR_BIN at fake binaries that we know
 * will pass or fail, then calling the tool via stdio.
 */

let repo: string;
let session: McpSession;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "rmcp-write-"));
});

afterEach(async () => {
  if (session) await session.close();
  await rm(repo, { recursive: true, force: true });
});

async function makeFakeValidator(
  dir: string,
  name: string,
  exitCode: 0 | 1,
): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(
    file,
    `#!/usr/bin/env node\n${exitCode === 0 ? "" : "console.error('fake validation error');"}\nprocess.exit(${exitCode});\n`,
  );
  await chmod(file, 0o755);
  return file;
}

describe("write_config", () => {
  it("writes the file when validation passes", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: { extends: ["config:recommended"] },
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(true);
    expect(payload.path).toBe("renovate.json");

    const written = JSON.parse(await readFile(path.join(repo, "renovate.json"), "utf8"));
    expect(written).toMatchObject({ extends: ["config:recommended"] });
  });

  it("refuses to write and leaves no files behind when validation fails", async () => {
    const validator = await makeFakeValidator(repo, "fake-fail.mjs", 1);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: { extends: ["config:recommended"] },
      },
    });

    expect(res.result?.isError).toBe(true);
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(false);
    expect(payload.reason).toBe("validation-failed");

    const files = await readdir(repo);
    expect(files).not.toContain("renovate.json");
    expect(files.some((f) => f.endsWith(".renovate-mcp-tmp"))).toBe(false);
  });

  it("rejects a filename whose resolved parent escapes repoPath via a symlink", async () => {
    session = await startServer();

    const outside = await mkdtemp(path.join(tmpdir(), "rmcp-outside-"));
    try {
      await symlink(outside, path.join(repo, "escape"));

      const res = await session.request<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>("tools/call", {
        name: "write_config",
        arguments: {
          repoPath: repo,
          filename: "escape/renovate.json",
          config: { extends: ["config:recommended"] },
        },
      });

      expect(res.result?.isError).toBe(true);
      expect(res.result!.content[0]!.text).toContain("escapes repoPath");

      const leaked = await readdir(outside);
      expect(leaked).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes anyway when force=true and validation fails", async () => {
    const validator = await makeFakeValidator(repo, "fake-fail.mjs", 1);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: { extends: ["config:recommended"] },
        force: true,
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(true);
    expect(payload.valid).toBe(false);

    const written = JSON.parse(await readFile(path.join(repo, "renovate.json"), "utf8"));
    expect(written).toMatchObject({ extends: ["config:recommended"] });
  });
});
