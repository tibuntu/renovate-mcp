import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeEndpoint } from "../../src/lib/endpointProbe.js";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = REAL_FETCH;
});

describe("probeEndpoint", () => {
  it("returns reachable=true on 200 HEAD", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as never;
    const result = await probeEndpoint("https://api.github.com");
    expect(result).toMatchObject({ url: "https://api.github.com", reachable: true, status: 200 });
  });

  it("returns reachable=true on 4xx (host responded, even if endpoint refused)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 })) as never;
    const result = await probeEndpoint("https://api.github.com");
    expect(result).toMatchObject({ reachable: true, status: 401 });
  });

  it("falls back to GET when HEAD returns 405", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as never;
    const result = await probeEndpoint("https://api.github.com");
    expect(result).toMatchObject({ reachable: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("returns reachable=false on 5xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 })) as never;
    const result = await probeEndpoint("https://api.github.com");
    expect(result).toMatchObject({ reachable: false, status: 503 });
  });

  it("returns reachable=false with the underlying error on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as never;
    const result = await probeEndpoint("https://api.example.invalid");
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });

  it("returns reachable=false on AbortError with a timeout message", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as never;
    const result = await probeEndpoint("https://api.github.com", 10);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("timed out");
  });

  it.each([
    ["http: scheme (cleartext)", "http://api.github.com"],
    ["RFC1918 host", "https://10.0.0.1/"],
    ["loopback host", "https://localhost/"],
    ["link-local cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["userinfo in URL", "https://user:pass@api.github.com/"],
  ])("refuses to fetch %s (blocked by endpoint allowlist)", async (_label, url) => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    const result = await probeEndpoint(url);
    expect(result.reachable).toBe(false);
    expect(result.skipped).toBe("endpoint-blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
