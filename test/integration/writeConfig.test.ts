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
  /** When set, the fake writes `{ file, content }` of the path it was handed here. */
  recordPath?: string,
): Promise<string> {
  const file = path.join(dir, name);
  const record = recordPath
    ? `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ file: process.argv[2], content: readFileSync(process.argv[2], "utf8") }));\n`
    : "";
  await writeFile(
    file,
    `#!/usr/bin/env node\n${record}${exitCode === 0 ? "" : "console.error('fake validation error');"}\nprocess.exit(${exitCode});\n`,
  );
  await chmod(file, 0o755);
  return file;
}

async function readRecord(recordPath: string): Promise<{ file: string; content: string }> {
  return JSON.parse(await readFile(recordPath, "utf8"));
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

  it("hands the validator a temp path ending in .json (renovate-config-validator dispatches on extension)", async () => {
    // The real validator's getParsedContent() switches on upath.extname() and
    // throws "Unsupported file type" for anything else — a suffix-less temp
    // name makes every non-force write fail against the bundled validator.
    const record = path.join(repo, "validator-saw.json");
    const validator = await makeFakeValidator(repo, "fake-record.mjs", 0, record);
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
    const seen = await readRecord(record);
    expect(path.extname(seen.file)).toBe(".json");
    expect(path.basename(seen.file)).toMatch(/^renovate\.json\.renovate-mcp-tmp-/);
    expect(JSON.parse(seen.content)).toEqual({ extends: ["config:recommended"] });
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

  it("preserves comments end-to-end when overwriting an existing renovate.json (round-trip)", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    // Seed the repo with a JSONC file that contains a comment.
    const existing =
      "// preset comment\n" +
      '{ "extends": ["config:recommended"] }\n';
    await writeFile(path.join(repo, "renovate.json"), existing);

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: {
          extends: ["config:recommended"],
          schedule: ["before 9am on Monday"],
        },
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(true);

    const written = await readFile(path.join(repo, "renovate.json"), "utf8");
    // The top-of-file comment survives the round-trip edit.
    expect(written).toContain("// preset comment");
    // The new schedule key landed on disk.
    expect(written).toContain('"schedule"');
    expect(written).toContain("before 9am on Monday");
  });

  it("force=true bypasses the round-trip path and overwrites with the fresh JSON rendering", async () => {
    // Validator deliberately fails — force=true skips the gate, AND skips the
    // round-trip path so the resulting bytes match JSON.stringify exactly
    // (no comments preserved).
    const validator = await makeFakeValidator(repo, "fake-fail.mjs", 1);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const existing =
      "// preset comment\n" +
      '{ "extends": ["config:recommended"] }\n';
    await writeFile(path.join(repo, "renovate.json"), existing);

    const newConfig = {
      extends: ["config:base"],
      schedule: ["before 9am on Monday"],
    };

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: newConfig,
        force: true,
        confirmForce: "YES_OVERRIDE_VALIDATION",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(true);

    const written = await readFile(path.join(repo, "renovate.json"), "utf8");
    // ADR-0002 contract: force=true produces the byte-identical fresh
    // rendering — the comment is gone.
    expect(written).toBe(JSON.stringify(newConfig, null, 2) + "\n");
    expect(written).not.toContain("// preset comment");
  });

  it("refuses to round-trip a JSON5-only renovate.json5 and leaves no temp file", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const existing = "{ extends: ['config:recommended'], }\n"; // JSON5-only syntax
    const targetPath = path.join(repo, "renovate.json5");
    await writeFile(targetPath, existing);

    const before = await readFile(targetPath, "utf8");

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: { extends: ["config:recommended"], automerge: false },
        filename: "renovate.json5",
      },
    });

    expect(res.result?.isError).toBe(true);
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(false);
    expect(payload.reason).toBe("json5-not-jsonc-compatible");
    expect(payload.hint).toContain("force=true");

    // The file on disk is byte-identical to what we wrote before the call.
    expect(await readFile(targetPath, "utf8")).toBe(before);

    // No temp file leaked — refusal short-circuits BEFORE any disk write
    // (ADR-0002 invariant + 04-02 contract).
    const files = await readdir(repo);
    expect(
      files.filter((f) => f.startsWith("renovate.json5.renovate-mcp-tmp-")),
    ).toHaveLength(0);
  });

  it("force=true with confirmForce overwrites the JSON5-only file with a fresh JSON rendering", async () => {
    const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
    session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

    const existing = "{ extends: ['config:recommended'], }\n";
    const targetPath = path.join(repo, "renovate.json5");
    await writeFile(targetPath, existing);

    const newConfig = {
      extends: ["config:base"],
      schedule: ["before 9am on Monday"],
    };

    const res = await session.request<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>("tools/call", {
      name: "write_config",
      arguments: {
        repoPath: repo,
        config: newConfig,
        filename: "renovate.json5",
        force: true,
        confirmForce: "YES_OVERRIDE_VALIDATION",
      },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result!.content[0]!.text);
    expect(payload.wrote).toBe(true);

    // ADR-0002: force=true is a destructive rewrite via JSON.stringify.
    // Unquoted keys / trailing commas are gone.
    const written = await readFile(targetPath, "utf8");
    expect(written).toBe(JSON.stringify(newConfig, null, 2) + "\n");
  });

  describe("package.json#renovate", () => {
    const pkg = {
      name: "my-app",
      version: "1.0.0",
      dependencies: { zod: "^4" },
      renovate: { extends: ["config:recommended"] },
    };
    const next = { extends: ["config:recommended", ":semanticCommits"] };

    async function call(args: Record<string, unknown>) {
      return session.request<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>("tools/call", {
        name: "write_config",
        arguments: { repoPath: repo, filename: "package.json", config: next, ...args },
      });
    }

    it("validates only the renovate slice and keeps name/version/dependencies on disk", async () => {
      const record = path.join(repo, "validator-saw.json");
      const validator = await makeFakeValidator(repo, "fake-record.mjs", 0, record);
      session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });
      await writeFile(path.join(repo, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

      const res = await call({});

      expect(res.result?.isError).toBeFalsy();
      const payload = JSON.parse(res.result!.content[0]!.text);
      expect(payload).toMatchObject({ wrote: true, path: "package.json", valid: true });

      // The validator saw a file that is NOT package.json and holds only the slice.
      const seen = await readRecord(record);
      expect(path.basename(seen.file)).not.toBe("package.json");
      expect(JSON.parse(seen.content)).toEqual(next);

      // The full package.json keeps every sibling key.
      const written = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
      expect(written).toEqual({ ...pkg, renovate: next });

      // No temp files (neither the full-file tmp nor the slice tmp) left behind.
      const files = await readdir(repo);
      expect(files.filter((f) => f.startsWith("package.json."))).toHaveLength(0);
    });

    it("force=true skips validation but STILL round-trips the nested key (no whole-file clobber)", async () => {
      const validator = await makeFakeValidator(repo, "fake-fail.mjs", 1);
      session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });
      await writeFile(path.join(repo, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

      const res = await call({ force: true, confirmForce: "YES_OVERRIDE_VALIDATION" });

      expect(res.result?.isError).toBeFalsy();
      const payload = JSON.parse(res.result!.content[0]!.text);
      expect(payload).toMatchObject({ wrote: true, valid: false });

      const written = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
      expect(written).toEqual({ ...pkg, renovate: next });
    });

    it("refuses with 'package-json-missing' when package.json does not exist and creates nothing", async () => {
      const validator = await makeFakeValidator(repo, "fake-pass.mjs", 0);
      session = await startServer({ RENOVATE_CONFIG_VALIDATOR_BIN: validator });

      const res = await call({});

      expect(res.result?.isError).toBe(true);
      const payload = JSON.parse(res.result!.content[0]!.text);
      expect(payload).toMatchObject({ wrote: false, reason: "package-json-missing" });
      expect(payload.hint).toContain("renovate.json");

      const files = await readdir(repo);
      expect(files.filter((f) => f.startsWith("package.json"))).toHaveLength(0);
    });
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
