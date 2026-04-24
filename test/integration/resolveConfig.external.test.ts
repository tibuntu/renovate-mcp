import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveConfig } from "../../src/lib/presetResolver.js";
import {
  resetDefaultFetchImpl,
  setDefaultFetchImpl,
} from "../../src/lib/externalPresetFetcher.js";

/**
 * End-to-end coverage for the external preset fetch path
 * (`resolve_config` tool → presetResolver → externalPresetFetcher). The
 * fetcher's `FetchOptions.fetchImpl` is injectable, but the tool handler
 * doesn't expose a way to pass one — so we plug in a fake via the test-only
 * `setDefaultFetchImpl` seam. That keeps the resolver path under test real
 * (classifier, parser, header/URL assembly, auth enrichment, rate-limit
 * detection, timeout) and only fakes the HTTP boundary.
 */

function okResponse(
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

beforeEach(() => {
  vi.unstubAllEnvs();
  resetDefaultFetchImpl();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDefaultFetchImpl();
});

describe("resolve_config external preset fetch — success", () => {
  it("expands a github> preset when externalPresets is on", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      okResponse({ automerge: true, labels: ["deps"] }),
    );
    setDefaultFetchImpl(fetchImpl);

    const { resolved, presetsResolved, presetsUnresolved, warnings } =
      await resolveConfig(
        { extends: ["github>acme/renovate-config"] },
        { fetchExternal: true },
      );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/repos/acme/renovate-config/contents/default.json?ref=HEAD",
    );
    expect(resolved).toMatchObject({ automerge: true, labels: ["deps"] });
    expect(presetsResolved).toEqual(["github>acme/renovate-config"]);
    expect(presetsUnresolved).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("resolve_config external preset fetch — network failures", () => {
  it("reports an unreachable host in presetsUnresolved with a network-error reason", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        Object.assign(new Error("getaddrinfo ENOTFOUND ghe.invalid.example"), {
          code: "ENOTFOUND",
        }),
      );
    setDefaultFetchImpl(fetchImpl);

    const { presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/cfg"] },
      { fetchExternal: true, endpoint: "https://ghe.invalid.example/api/v3" },
    );

    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]!.preset).toBe("github>acme/cfg");
    expect(presetsUnresolved[0]!.reason).toMatch(/Network error fetching github>acme\/cfg/);
    expect(presetsUnresolved[0]!.reason).toMatch(/ENOTFOUND/);
  });

  it("surfaces a timeout as an unresolved entry naming the timeout", async () => {
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
    setDefaultFetchImpl(fetchImpl);

    const { presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/cfg"] },
      { fetchExternal: true, timeoutMs: 25 },
    );

    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]!.reason).toMatch(/Timed out after 25ms fetching github>acme\/cfg/);
  });
});

describe("resolve_config external preset fetch — auth and rate limit", () => {
  it("names 'none' as the credential source on a 401 when no token env vars are set", async () => {
    vi.stubEnv("RENOVATE_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        okResponse({ message: "Requires authentication" }, {
          status: 401,
          statusText: "Unauthorized",
        }),
      );
    setDefaultFetchImpl(fetchImpl);

    const { presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/private"] },
      { fetchExternal: true },
    );

    expect(presetsUnresolved).toHaveLength(1);
    const { reason } = presetsUnresolved[0]!;
    expect(reason).toMatch(/HTTP 401 when fetching github>acme\/private/);
    expect(reason).toMatch(/Credential:\s+none \(tried RENOVATE_TOKEN, GITHUB_TOKEN\)/);
  });

  it("names the winning env var on a 401 when a token is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret_do_not_leak");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse("Bad credentials", { status: 401, statusText: "Unauthorized" }));
    setDefaultFetchImpl(fetchImpl);

    const { presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/private"] },
      { fetchExternal: true },
    );

    expect(presetsUnresolved).toHaveLength(1);
    const { reason } = presetsUnresolved[0]!;
    expect(reason).toMatch(/Credential:\s+GITHUB_TOKEN \(present\)/);
    expect(reason).not.toMatch(/ghp_secret_do_not_leak/);
  });

  it("names RENOVATE_TOKEN when it wins over GITHUB_TOKEN on a 401", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_fallback");
    vi.stubEnv("RENOVATE_TOKEN", "rnv_preferred");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse("Bad credentials", { status: 401, statusText: "Unauthorized" }));
    setDefaultFetchImpl(fetchImpl);

    const { presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/private"] },
      { fetchExternal: true },
    );

    expect(presetsUnresolved[0]!.reason).toMatch(/Credential:\s+RENOVATE_TOKEN \(present\)/);
    expect(presetsUnresolved[0]!.reason).not.toMatch(/rnv_preferred/);
    expect(presetsUnresolved[0]!.reason).not.toMatch(/ghp_fallback/);
  });

  // GitHub signals rate-limit as HTTP 403 with X-RateLimit-Remaining: 0. This
  // test guards the regression fixed in issue #31: the classifier must read
  // the rate-limit header and not fall through to the generic auth-failure
  // branch, which would hide the real cause (and leak the credential line).
  it("classifies a GitHub 403 with X-RateLimit-Remaining: 0 as rate-limit, not auth failure", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_token");
    const resetEpoch = Math.floor(Date.parse("2026-05-01T00:00:00Z") / 1000);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      okResponse(
        { message: "API rate limit exceeded" },
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
    setDefaultFetchImpl(fetchImpl);

    const { presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/cfg"] },
      { fetchExternal: true },
    );

    const { reason } = presetsUnresolved[0]!;
    expect(reason).toMatch(/GitHub API rate limit exceeded/);
    expect(reason).toMatch(/2026-05-01T00:00:00\.000Z/);
    expect(reason).not.toMatch(/HTTP 403/);
    expect(reason).not.toMatch(/Credential:/);
  });
});

describe("resolve_config external preset fetch — endpoint and platform routing", () => {
  it("routes github> fetches to a GHE endpoint when endpoint is set", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse({ automerge: true }));
    setDefaultFetchImpl(fetchImpl);

    await resolveConfig(
      { extends: ["github>acme/cfg"] },
      { fetchExternal: true, endpoint: "https://ghe.example.com/api/v3" },
    );

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/cfg/contents/default.json?ref=HEAD",
    );
  });

  it("routes local> through endpoint + platform as if it were the named platform", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse({ labels: ["self-hosted"] }));
    setDefaultFetchImpl(fetchImpl);

    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["local>team/shared-config"] },
      {
        fetchExternal: true,
        endpoint: "https://ghe.example.com/api/v3",
        platform: "github",
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://ghe.example.com/api/v3/repos/team/shared-config/contents/default.json?ref=HEAD",
    );
    expect(resolved).toMatchObject({ labels: ["self-hosted"] });
    expect(presetsResolved).toEqual(["local>team/shared-config"]);
    expect(presetsUnresolved).toEqual([]);
  });
});
