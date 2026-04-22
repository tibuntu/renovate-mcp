import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchExternalPreset, type FetchOptions } from "../../src/lib/externalPresetFetcher.js";
import { parsePreset } from "../../src/lib/presetResolver.js";

function makeResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
  });
}

describe("fetchExternalPreset — github", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("fetches default.json from the contents API", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse({ extends: [":semanticCommits"], automerge: true }),
    );
    const parsed = parsePreset("github>acme/renovate-config");
    const result = await fetchExternalPreset(parsed, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/acme/renovate-config/contents/default.json?ref=HEAD",
    );
    expect((init?.headers as Record<string, string>).Accept).toBe(
      "application/vnd.github.raw",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      body: { extends: [":semanticCommits"], automerge: true },
    });
  });

  it("uses :preset as the file name and #ref as the query ref", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg:strict#v2"), { fetchImpl });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/acme/cfg/contents/strict.json?ref=v2");
  });

  it("uses //subpath as the file when provided", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg//nested/strict"), { fetchImpl });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/acme/cfg/contents/nested/strict.json?ref=HEAD",
    );
  });

  it("attaches GITHUB_TOKEN as a Bearer auth header", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_example");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_example");
  });

  it("falls back to RENOVATE_TOKEN when GITHUB_TOKEN is unset", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("RENOVATE_TOKEN", "rnv_example");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rnv_example");
  });

  it("surfaces a 404 as an unresolved reason", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeResponse("not found", { status: 404, statusText: "Not Found" }));
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/404/);
      expect(result.reason).toMatch(/github>acme\/cfg/);
    }
  });

  it("surfaces an abort/timeout as an unresolved reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), {
      fetchImpl,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Timed out/);
      expect(result.reason).toMatch(/20ms/);
    }
  });

  it("surfaces an invalid JSON body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse("not-json-at-all"));
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not valid JSON/);
  });

  it("caches the result per canonical key for the same request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ automerge: true }));
    const cache: NonNullable<FetchOptions["cache"]> = new Map();
    const p = parsePreset("github>acme/cfg");
    await fetchExternalPreset(p, { fetchImpl, cache });
    await fetchExternalPreset(p, { fetchImpl, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchExternalPreset — gitlab", () => {
  afterEach(() => vi.restoreAllMocks());

  it("url-encodes the project path and file, and sends PRIVATE-TOKEN when available", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_example");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ automerge: true }));
    await fetchExternalPreset(parsePreset("gitlab>acme/my-cfg:strict#main"), { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fmy-cfg/repository/files/strict.json/raw?ref=main",
    );
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat_example");
    vi.unstubAllEnvs();
  });
});

describe("fetchExternalPreset — unsupported sources", () => {
  it("returns a clear error for bitbucket", async () => {
    const result = await fetchExternalPreset(parsePreset("bitbucket>acme/cfg"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not yet supported/i);
  });

  it("returns a clear error for gitea", async () => {
    const result = await fetchExternalPreset(parsePreset("gitea>acme/cfg"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not yet supported/i);
  });

  it("returns a clear error for local", async () => {
    const result = await fetchExternalPreset(parsePreset("local>acme/cfg"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/out of scope/i);
  });

  it("returns a clear error for npm", async () => {
    const result = await fetchExternalPreset(parsePreset("some-npm-preset"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not yet supported/i);
  });
});
