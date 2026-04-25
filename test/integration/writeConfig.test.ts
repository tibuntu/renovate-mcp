import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
  chmod,
  symlink,
} from "node:fs/promises";
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
  repo = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
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

  it("does not follow a pre-existing symlink at the legacy temp path (issue #129)", async () => {
    // Threat model: an attacker plants a symlink at the deterministic legacy
    // temp path pointing at a sentinel outside the repo. Two combined defenses
    // make this safe: (1) the temp suffix is randomized so the attacker can't
    // predict the actual write target, (2) the writeFile uses `flag: "wx"` so
    // even if they could, O_EXCL refuses to follow a pre-existing entry.
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const outside = await mkdtemp(
      path.join(
        tmpdir(),
        `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-sentinel-`,
      ),
    );
    try {
      const sentinel = path.join(outside, "sentinel.txt");
      const sentinelContent = "do-not-overwrite";
      await writeFile(sentinel, sentinelContent);
      const legacyTmp = path.join(repo, "renovate.json.renovate-mcp-tmp");
      await symlink(sentinel, legacyTmp);

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

      // The sentinel must be untouched — the LLM-shaped payload must never
      // have been written through the symlink.
      expect(await readFile(sentinel, "utf8")).toBe(sentinelContent);

      // The planted symlink itself is unrelated to the actual (randomized)
      // temp path, so it stays in place.
      const files = await readdir(repo);
      expect(files).toContain("renovate.json.renovate-mcp-tmp");
      expect(files).toContain("renovate.json");
      // No tmp file leaks under the random suffix either.
      expect(
        files.filter((f) => f.startsWith("renovate.json.renovate-mcp-tmp-")),
      ).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not collide on the temp suffix when called concurrently (issue #129)", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const calls = Array.from({ length: 5 }, (_, i) =>
      session.request<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>("tools/call", {
        name: "write_config",
        arguments: {
          repoPath: repo,
          config: { extends: ["config:recommended"], _i: i },
        },
      }),
    );
    const results = await Promise.all(calls);
    for (const res of results) {
      expect(res.result?.isError).toBeFalsy();
    }

    const files = await readdir(repo);
    expect(
      files.filter((f) => f.startsWith("renovate.json.renovate-mcp-tmp")),
    ).toHaveLength(0);
  });

  it("rejects a filename whose resolved parent escapes repoPath via a symlink", async () => {
    session = await startServer();

    const outside = await mkdtemp(
      path.join(
        tmpdir(),
        `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-outside-`,
      ),
    );
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

  it("cleans up the tmp file when the final rename fails (issue #57)", async () => {
    // Simulate a rename failure by pre-creating a non-empty directory at the
    // target path — fs.rename(tmp, target) fails with ENOTEMPTY / EISDIR on
    // POSIX. Before the fix, the .renovate-mcp-tmp file was left behind.
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const targetAsDir = path.join(repo, "renovate.json");
    await mkdir(targetAsDir);
    await writeFile(path.join(targetAsDir, "placeholder"), "x");

    await session
      .request("tools/call", {
        name: "write_config",
        arguments: {
          repoPath: repo,
          config: { extends: ["config:recommended"] },
        },
      })
      .catch(() => undefined);

    const files = await readdir(repo);
    expect(files.some((f) => f.endsWith(".renovate-mcp-tmp"))).toBe(false);
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
        confirmForce: "YES_OVERRIDE_VALIDATION",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(true);
    expect(payload.valid).toBe(false);

    const written = JSON.parse(await readFile(path.join(repo, "renovate.json"), "utf8"));
    expect(written).toMatchObject({ extends: ["config:recommended"] });
  });

  it("rejects force=true without confirmForce", async () => {
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

    expect(res.result?.isError).toBe(true);
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(false);
    expect(payload.reason).toBe("force-confirmation-missing");

    const files = await readdir(repo).catch(() => [] as string[]);
    expect(files).not.toContain("renovate.json");
    expect(files.some((f) => f.endsWith(".renovate-mcp-tmp"))).toBe(false);
  });
});
