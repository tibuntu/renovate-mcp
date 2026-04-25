import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchExternalPreset, type FetchOptions } from "../../src/lib/externalPresetFetcher.js";
import { parsePreset } from "../../src/lib/presetResolver.js";

function makeResponse(
  body: unknown,
  init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: init.headers,
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

  it("falls back to GITHUB_TOKEN when RENOVATE_TOKEN is unset", async () => {
    vi.stubEnv("RENOVATE_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "ghp_fallback");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghp_fallback");
  });

  it("prefers RENOVATE_TOKEN over GITHUB_TOKEN when both are set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_platform");
    vi.stubEnv("RENOVATE_TOKEN", "rnv_override");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rnv_override");
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

describe("fetchExternalPreset — rate limits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("surfaces a GitHub 403 with X-RateLimit-Remaining: 0 as a rate-limit reason", async () => {
    const resetEpoch = Math.floor(Date.parse("2025-01-02T03:04:05Z") / 1000);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse(
        { message: "API rate limit exceeded for 1.2.3.4" },
        {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(resetEpoch),
          },
        },
      ),
    );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/GitHub API rate limit exceeded/);
      expect(result.reason).toMatch(/2025-01-02T03:04:05\.000Z/);
      expect(result.reason).toMatch(/GITHUB_TOKEN/);
      expect(result.reason).not.toMatch(/HTTP 403/);
    }
  });

  it("does not classify a GitHub 403 without the rate-limit header as rate-limited", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 403 when fetching/);
      expect(result.reason).not.toMatch(/rate limit/i);
    }
  });

  it("falls back to a rate-limit message without reset time when X-RateLimit-Reset is malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse("forbidden", {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "not-a-number",
        },
      }),
    );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/GitHub API rate limit exceeded/);
      expect(result.reason).not.toMatch(/resets at/);
    }
  });

  it("surfaces a GitLab 429 with RateLimit-Reset as a rate-limit reason", async () => {
    const resetEpoch = Math.floor(Date.parse("2025-06-07T08:09:10Z") / 1000);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse("too many", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "RateLimit-Reset": String(resetEpoch) },
      }),
    );
    const result = await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/GitLab API rate limit exceeded/);
      expect(result.reason).toMatch(/2025-06-07T08:09:10\.000Z/);
      expect(result.reason).toMatch(/GITLAB_TOKEN/);
      expect(result.reason).not.toMatch(/HTTP 429/);
    }
  });

  it("falls back to a rate-limit message without reset time for a GitLab 429 missing RateLimit-Reset", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse("too many", { status: 429, statusText: "Too Many Requests" }),
    );
    const result = await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/GitLab API rate limit exceeded/);
      expect(result.reason).not.toMatch(/resets at/);
    }
  });
});

describe("fetchExternalPreset — gitlab", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("url-encodes the project path and file, and sends PRIVATE-TOKEN when available", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_example");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ automerge: true }));
    await fetchExternalPreset(parsePreset("gitlab>acme/my-cfg:strict#main"), { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://gitlab.com/api/v4/projects/acme%2Fmy-cfg/repository/files/strict.json/raw?ref=main",
    );
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat_example");
  });

  it("prefers RENOVATE_TOKEN over GITLAB_TOKEN when both are set", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_platform");
    vi.stubEnv("RENOVATE_TOKEN", "rnv_override");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("rnv_override");
  });

  it("falls back to GITLAB_TOKEN when RENOVATE_TOKEN is unset", async () => {
    vi.stubEnv("RENOVATE_TOKEN", "");
    vi.stubEnv("GITLAB_TOKEN", "glpat_fallback");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat_fallback");
  });
});

describe("fetchExternalPreset — endpoint override", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses a GHE endpoint as API base for github> fetches", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ automerge: true }));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), {
      fetchImpl,
      endpoint: "https://ghe.example.com/api/v3",
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/cfg/contents/default.json?ref=HEAD",
    );
  });

  it("uses a self-hosted endpoint as API base for gitlab> fetches", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ automerge: true }));
    await fetchExternalPreset(parsePreset("gitlab>acme/cfg:strict#main"), {
      fetchImpl,
      endpoint: "https://gitlab.example.com/api/v4",
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fcfg/repository/files/strict.json/raw?ref=main",
    );
  });

  it("strips a trailing slash from the endpoint before concatenation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ automerge: true }));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), {
      fetchImpl,
      endpoint: "https://ghe.example.com/api/v3/",
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/cfg/contents/default.json?ref=HEAD",
    );
  });
});

describe("fetchExternalPreset — auth failures (401/403)", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports 'none (tried …)' credential source when no GitHub token is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("RENOVATE_TOKEN", "");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeResponse({ message: "Requires authentication" }, {
          status: 401,
          statusText: "Unauthorized",
        }),
      );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 401 when fetching github>acme\/cfg/);
      expect(result.reason).toMatch(
        /URL:\s+https:\/\/api\.github\.com\/repos\/acme\/cfg\/contents\/default\.json\?ref=HEAD/,
      );
      expect(result.reason).toMatch(
        /Credential:\s+none \(tried RENOVATE_TOKEN, GITHUB_TOKEN\)/,
      );
      expect(result.reason).toMatch(/Response:\s+.*Requires authentication/);
    }
  });

  it("names the specific env var that supplied the GitHub token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret_value");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeResponse("Bad credentials", { status: 401, statusText: "Unauthorized" }));
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Credential:\s+GITHUB_TOKEN \(present\)/);
      expect(result.reason).not.toMatch(/ghp_secret_value/);
    }
  });

  it("names RENOVATE_TOKEN when it wins over GITHUB_TOKEN (both set)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret_value");
    vi.stubEnv("RENOVATE_TOKEN", "rnv_secret_value");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeResponse("Bad credentials", { status: 401, statusText: "Unauthorized" }));
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Credential:\s+RENOVATE_TOKEN \(present\)/);
      expect(result.reason).not.toMatch(/rnv_secret_value/);
      expect(result.reason).not.toMatch(/ghp_secret_value/);
    }
  });

  it("includes JSON response body verbatim on a GitLab 401", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_secret");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse(
        { message: "401 Unauthorized" },
        { status: 401, statusText: "Unauthorized" },
      ),
    );
    const result = await fetchExternalPreset(parsePreset("gitlab>foo/bar"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 401 when fetching gitlab>foo\/bar/);
      expect(result.reason).toMatch(
        /URL:\s+https:\/\/gitlab\.com\/api\/v4\/projects\/foo%2Fbar\/repository\/files\/default\.json\/raw\?ref=HEAD/,
      );
      expect(result.reason).toMatch(/Credential:\s+GITLAB_TOKEN \(present\)/);
      expect(result.reason).toMatch(/Response:\s+\{"message":"401 Unauthorized"\}/);
      expect(result.reason).not.toMatch(/glpat_secret/);
    }
  });

  it("omits the Response line when the body is empty", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_secret");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(makeResponse("", { status: 401, statusText: "Unauthorized" }));
    const result = await fetchExternalPreset(parsePreset("gitlab>foo/bar"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 401 when fetching gitlab>foo\/bar/);
      expect(result.reason).toMatch(/Credential:\s+GITLAB_TOKEN \(present\)/);
      expect(result.reason).not.toMatch(/Response:/);
    }
  });

  it("enriches a non-rate-limit GitHub 403 with credential and URL context", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        makeResponse("Resource not accessible by integration", {
          status: 403,
          statusText: "Forbidden",
        }),
      );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 403 when fetching github>acme\/cfg/);
      expect(result.reason).toMatch(/Credential:\s+GITHUB_TOKEN \(present\)/);
      expect(result.reason).toMatch(/Response:\s+Resource not accessible by integration/);
      expect(result.reason).not.toMatch(/ghp_secret/);
      expect(result.reason).not.toMatch(/rate limit/i);
    }
  });

  it("leaves the rate-limit message untouched on a GitHub 403 with X-RateLimit-Remaining: 0", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          statusText: "Forbidden",
          headers: { "X-RateLimit-Remaining": "0" },
        },
      ),
    );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/GitHub API rate limit exceeded/);
      expect(result.reason).not.toMatch(/Credential:/);
      expect(result.reason).not.toMatch(/^\s+URL:/m);
    }
  });
});

describe("fetchExternalPreset — redirects", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("requests redirect: 'manual' so undici never auto-follows", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({}));
    await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).redirect).toBe("manual");
  });

  it("rejects a 302 from a github fetch and never re-issues the request", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse("", {
        status: 302,
        statusText: "Found",
        headers: { Location: "https://attacker.example/leak" },
      }),
    );
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Redirect refused while fetching github>acme\/cfg/);
      expect(result.reason).toMatch(/Status:\s+302/);
      expect(result.reason).toMatch(/disabled to prevent leaking auth tokens/);
      expect(result.reason).not.toMatch(/ghp_secret/);
      expect(result.reason).not.toMatch(/attacker\.example/);
    }
  });

  it("rejects a 302 from a gitlab fetch and never re-issues the request", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_secret");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      makeResponse("", {
        status: 302,
        statusText: "Found",
        headers: { Location: "https://attacker.example/leak" },
      }),
    );
    const result = await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Redirect refused while fetching gitlab>acme\/cfg/);
      expect(result.reason).toMatch(/Status:\s+302/);
      expect(result.reason).not.toMatch(/glpat_secret/);
    }
  });

  it("rejects each redirect status (301/303/307/308) the same way", async () => {
    for (const status of [301, 303, 307, 308] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        makeResponse("", { status, statusText: "Redirect" }),
      );
      const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/Redirect refused/);
        expect(result.reason).toMatch(new RegExp(`Status:\\s+${status}`));
      }
    }
  });
});

describe("fetchExternalPreset — endpoint validation", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("refuses an http:// github endpoint without making any fetch", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), {
      fetchImpl,
      endpoint: "http://ghe.example.com/api/v3",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/protocol must be https:/);
      expect(result.reason).not.toMatch(/ghp_secret/);
    }
  });

  it("refuses an http:// gitlab endpoint without making any fetch", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_secret");
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), {
      fetchImpl,
      endpoint: "http://gitlab.example.com/api/v4",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/protocol must be https:/);
  });

  it("refuses a cloud-metadata IP endpoint without making any fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), {
      fetchImpl,
      endpoint: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/protocol must be https:/);
  });

  it("refuses an https loopback endpoint without making any fetch", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat_secret");
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), {
      fetchImpl,
      endpoint: "https://localhost:8080/api/v4",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reason).toMatch(/private, loopback, or link-local/);
  });

  it("refuses userinfo-bearing endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchExternalPreset(parsePreset("gitlab>acme/cfg"), {
      fetchImpl,
      endpoint: "https://attacker:secret@gitlab.example.com/api/v4",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/userinfo .* not allowed/);
  });
});

describe("fetchExternalPreset — response size cap", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects without reading the body when Content-Length exceeds the cap", async () => {
    const textSpy = vi.fn();
    const fakeBody = {
      getReader: vi.fn(),
    } as unknown as ReadableStream<Uint8Array>;
    const res = new Response("ignored", { status: 200, headers: { "Content-Length": "100000000" } });
    Object.defineProperty(res, "text", { value: textSpy });
    Object.defineProperty(res, "body", { value: fakeBody });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res);
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(textSpy).not.toHaveBeenCalled();
    expect(fakeBody.getReader).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exceeds 1000000 bytes/);
      expect(result.reason).toMatch(/declared 100000000/);
    }
  });

  it("aborts a chunked response once the running total passes the cap", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const oneMiB = new Uint8Array(1_048_576);
    const reads = [
      { done: false, value: oneMiB },
      { done: false, value: oneMiB },
      { done: false, value: oneMiB },
    ];
    let i = 0;
    const reader = {
      read: vi.fn().mockImplementation(async () => reads[i++] ?? { done: true, value: undefined }),
      cancel,
      releaseLock: vi.fn(),
    };
    const stream = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "body", { value: stream });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res);
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reader.read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds 1000000 bytes/);
  });

  it("truncates an oversized auth body instead of buffering it whole", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    const cancel = vi.fn().mockResolvedValue(undefined);
    const big = new TextEncoder().encode("X".repeat(50_000));
    const reads = [{ done: false, value: big }];
    let i = 0;
    const reader = {
      read: vi.fn().mockImplementation(async () => reads[i++] ?? { done: true, value: undefined }),
      cancel,
      releaseLock: vi.fn(),
    };
    const stream = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const res = new Response(null, { status: 401, statusText: "Unauthorized" });
    Object.defineProperty(res, "body", { value: stream });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(res);
    const result = await fetchExternalPreset(parsePreset("github>acme/cfg"), { fetchImpl });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HTTP 401 when fetching github>acme\/cfg/);
      expect(result.reason).toMatch(/Response:\s+X+/);
    }
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
    if (!result.ok) expect(result.reason).toMatch(/need a platform context/i);
  });

  it("returns a clear error for npm", async () => {
    const result = await fetchExternalPreset(parsePreset("some-npm-preset"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not yet supported/i);
  });
});
