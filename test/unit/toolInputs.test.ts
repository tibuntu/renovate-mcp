import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertRepoDir } from "../../src/lib/toolInputs.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(
    path.join(tmpdir(), `rmcp-${path.basename(import.meta.url, ".ts")}-${process.pid}-`),
  );
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const guardMessage = (value: string) =>
  `repoPath must be an absolute path to an existing directory (got: ${value})`;

describe("assertRepoDir", () => {
  it("rejects a relative path", async () => {
    expect(await assertRepoDir("relative/repo")).toBe(guardMessage("relative/repo"));
  });

  it("rejects a nonexistent path", async () => {
    const missing = path.join(repo, "missing");
    expect(await assertRepoDir(missing)).toBe(guardMessage(missing));
  });

  it("rejects a file", async () => {
    const file = path.join(repo, "file");
    await writeFile(file, "x");
    expect(await assertRepoDir(file)).toBe(guardMessage(file));
  });

  it("returns null for an existing directory", async () => {
    expect(await assertRepoDir(repo)).toBeNull();
  });
});
