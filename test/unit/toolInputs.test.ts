import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertRepoDir,
  checkConfigFileInput,
  hostTokensError,
  loadConfigFile,
  loadConfigSource,
} from "../../src/lib/toolInputs.js";

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

describe("loadConfigSource", () => {
  it("rejects both inputs", async () => {
    expect(await loadConfigSource({ repoPath: repo, configContent: {} })).toEqual({
      error: "Pass either repoPath or configContent, not both.",
    });
  });

  it("rejects neither input", async () => {
    expect(await loadConfigSource({})).toEqual({
      error: "Provide either repoPath or configContent.",
    });
  });

  it("runs the repoPath guard", async () => {
    expect(await loadConfigSource({ repoPath: "relative/repo" })).toEqual({
      error: guardMessage("relative/repo"),
    });
  });

  it("treats an empty repoPath as given, not absent", async () => {
    expect(await loadConfigSource({ repoPath: "" })).toEqual({ error: guardMessage("") });
  });

  it("reports a repo without config", async () => {
    expect(await loadConfigSource({ repoPath: repo })).toEqual({
      error: `No Renovate configuration found in ${repo}.`,
    });
  });

  it("returns inline content as-is with no path", async () => {
    const configContent = { extends: ["config:recommended"] };
    expect(await loadConfigSource({ configContent })).toEqual({ config: configContent });
  });

  it("locates a repo config and reports its relative path", async () => {
    await writeFile(path.join(repo, "renovate.json"), '{"extends":["config:recommended"]}');
    expect(await loadConfigSource({ repoPath: repo })).toEqual({
      config: { extends: ["config:recommended"] },
      path: "renovate.json",
    });
  });
});

describe("hostTokensError", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the parse error for a malformed RENOVATE_MCP_HOST_TOKENS when fetching", () => {
    vi.stubEnv("RENOVATE_MCP_HOST_TOKENS", "[{}]");
    expect(hostTokensError(true)).toMatch(/RENOVATE_MCP_HOST_TOKENS\[0\]/);
  });

  it("returns null when nothing is fetched", () => {
    vi.stubEnv("RENOVATE_MCP_HOST_TOKENS", "[{}]");
    expect(hostTokensError(false)).toBeNull();
    expect(hostTokensError(undefined)).toBeNull();
  });

  it("returns null for a valid or unset var", () => {
    vi.stubEnv("RENOVATE_MCP_HOST_TOKENS", "");
    expect(hostTokensError(true)).toBeNull();
    vi.stubEnv(
      "RENOVATE_MCP_HOST_TOKENS",
      JSON.stringify([{ matchHost: "gitlab.example.com", hostType: "gitlab", tokenEnv: "ACME" }]),
    );
    expect(hostTokensError(true)).toBeNull();
  });
});

const ONE_OF = "Pass exactly one of `configPath` or `configContent`.";
const ABSOLUTE = "`configPath` must be an absolute path.";

describe("checkConfigFileInput", () => {
  it("requires exactly one source, by presence rather than truthiness", () => {
    expect(checkConfigFileInput({})).toBe(ONE_OF);
    expect(checkConfigFileInput({ configPath: "/a.json", configContent: {} })).toBe(ONE_OF);
    expect(checkConfigFileInput({ configPath: "", configContent: {} })).toBe(ONE_OF);
  });

  it("requires an absolute configPath", () => {
    expect(checkConfigFileInput({ configPath: "rel/renovate.json" })).toBe(ABSOLUTE);
    expect(checkConfigFileInput({ configPath: "" })).toBe(ABSOLUTE);
    expect(checkConfigFileInput({ configPath: "/abs/renovate.json" })).toBeNull();
    expect(checkConfigFileInput({ configContent: {} })).toBeNull();
  });
});

describe("loadConfigFile", () => {
  it("returns inline content as-is", async () => {
    expect(await loadConfigFile({ configContent: { a: 1 } })).toEqual({
      ok: true,
      config: { a: 1 },
    });
  });

  it("parses a JSON5 file", async () => {
    const file = path.join(repo, "renovate.json5");
    await writeFile(file, "{ extends: ['config:base'], // c\n}");
    expect(await loadConfigFile({ configPath: file })).toEqual({
      ok: true,
      config: { extends: ["config:base"] },
      path: file,
    });
  });

  it("refuses both, neither and an empty configPath with the same text", async () => {
    const both = { ok: false, error: ONE_OF };
    expect(await loadConfigFile({})).toEqual(both);
    expect(await loadConfigFile({ configPath: "", configContent: {} })).toEqual(both);
  });

  it("refuses a relative configPath", async () => {
    expect(await loadConfigFile({ configPath: "renovate.json" })).toEqual({
      ok: false,
      error: ABSOLUTE,
    });
  });

  it("reports unreadable and unparseable files with the path", async () => {
    const missing = path.join(repo, "missing.json");
    const res = await loadConfigFile({ configPath: missing });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(`Could not read or parse config at ${missing}: `);
    const bad = path.join(repo, "bad.json");
    await writeFile(bad, "{ nope");
    const res2 = await loadConfigFile({ configPath: bad });
    expect(!res2.ok && res2.error).toContain(`Could not read or parse config at ${bad}: `);
  });

  it("refuses a non-object file", async () => {
    const file = path.join(repo, "arr.json");
    await writeFile(file, "[]");
    expect(await loadConfigFile({ configPath: file })).toEqual({
      ok: false,
      error: `Config at ${file} must be a JSON object.`,
    });
  });
});
