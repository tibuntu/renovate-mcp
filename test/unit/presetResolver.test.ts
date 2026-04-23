import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveConfig, parsePreset } from "../../src/lib/presetResolver.js";

describe("resolveConfig", () => {
  it("returns the input unchanged when there are no extends", async () => {
    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig({
      schedule: ["before 6am"],
    });
    expect(resolved).toEqual({ schedule: ["before 6am"] });
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toEqual([]);
  });

  it("expands a built-in preset and records it as resolved", async () => {
    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig({
      extends: ["default:automergeAll"],
    });
    expect(resolved).toEqual({ automerge: true });
    expect(presetsResolved).toContain("default:automergeAll");
    expect(presetsUnresolved).toEqual([]);
    expect(resolved).not.toHaveProperty("extends");
  });

  it("treats `:foo` as shorthand for `default:foo`", async () => {
    const { resolved, presetsResolved } = await resolveConfig({
      extends: [":automergeAll"],
    });
    expect(resolved).toMatchObject({ automerge: true });
    expect(presetsResolved).toContain(":automergeAll");
  });

  it("recursively expands nested extends", async () => {
    // `config:recommended` extends a chain of other presets.
    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig({
      extends: ["config:recommended"],
    });
    expect(presetsResolved).toContain("config:recommended");
    // recursion should have pulled in at least one nested preset
    expect(presetsResolved.length).toBeGreaterThan(1);
    expect(resolved).not.toHaveProperty("extends");
    // The user should see keys contributed by nested presets, not a raw chain.
    expect(presetsUnresolved).toEqual([]);
  });

  it("lets outer config override preset-provided values", async () => {
    const { resolved } = await resolveConfig({
      extends: ["default:automergeAll"],
      automerge: false,
    });
    expect(resolved).toMatchObject({ automerge: false });
  });

  it("concatenates arrays from preset and outer config", async () => {
    const { resolved } = await resolveConfig({
      extends: ["default:automergeAll"],
      packageRules: [{ matchPackageNames: ["lodash"] }],
    });
    expect(resolved).toMatchObject({
      automerge: true,
      packageRules: [{ matchPackageNames: ["lodash"] }],
    });
  });

  it("substitutes positional arguments into preset body", async () => {
    const { resolved, presetsResolved } = await resolveConfig({
      extends: ["default:assignee(alice)"],
    });
    expect(resolved).toMatchObject({ assignees: ["alice"] });
    expect(presetsResolved).toContain("default:assignee(alice)");
  });

  it("flags github> presets as unresolved with a network reason by default", async () => {
    const { presetsResolved, presetsUnresolved } = await resolveConfig({
      extends: ["github>some/repo"],
    });
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.preset).toBe("github>some/repo");
    expect(presetsUnresolved[0]?.reason).toMatch(/network/i);
  });

  it("flags gitlab>, local>, and npm presets too", async () => {
    const { presetsUnresolved } = await resolveConfig({
      extends: ["gitlab>a/b", "local>a/b", "some-npm-preset"],
    });
    expect(presetsUnresolved.map((p) => p.preset).sort()).toEqual([
      "gitlab>a/b",
      "local>a/b",
      "some-npm-preset",
    ]);
  });

  it("flags unknown built-in presets", async () => {
    const { presetsUnresolved } = await resolveConfig({
      extends: ["config:doesNotExist"],
    });
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.preset).toBe("config:doesNotExist");
    expect(presetsUnresolved[0]?.reason).toMatch(/catalogue/i);
  });

  it("resolves siblings independently when one is unknown", async () => {
    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig({
      extends: ["default:automergeAll", "config:doesNotExist"],
    });
    expect(resolved).toMatchObject({ automerge: true });
    expect(presetsResolved).toContain("default:automergeAll");
    expect(presetsUnresolved.map((p) => p.preset)).toContain("config:doesNotExist");
  });
});

describe("parsePreset", () => {
  it("parses a built-in preset with namespace", () => {
    const p = parsePreset("config:recommended");
    expect(p.key).toBe("config:recommended");
    expect(p.original).toBe("config:recommended");
    expect(p.args).toEqual([]);
    expect(p.source).toBeUndefined();
  });

  it("expands `:foo` shorthand to `default:foo`", () => {
    const p = parsePreset(":pinAll");
    expect(p.key).toBe("default:pinAll");
    expect(p.original).toBe(":pinAll");
  });

  it("captures positional args", () => {
    const p = parsePreset("default:assignee(alice, bob)");
    expect(p.key).toBe("default:assignee");
    expect(p.args).toEqual(["alice", "bob"]);
  });

  it("parses github>owner/repo", () => {
    const p = parsePreset("github>acme/renovate-config");
    expect(p).toMatchObject({
      source: "github",
      repoPath: "acme/renovate-config",
      presetName: undefined,
      subpath: undefined,
      ref: undefined,
      key: "github>acme/renovate-config",
    });
  });

  it("parses github>owner/repo:preset#ref", () => {
    const p = parsePreset("github>acme/cfg:strict#v2");
    expect(p).toMatchObject({
      source: "github",
      repoPath: "acme/cfg",
      presetName: "strict",
      ref: "v2",
      key: "github>acme/cfg:strict#v2",
    });
  });

  it("parses github>owner/repo//path", () => {
    const p = parsePreset("github>acme/cfg//nested/strict");
    expect(p).toMatchObject({
      source: "github",
      repoPath: "acme/cfg",
      subpath: "nested/strict",
    });
  });

  it("parses gitlab> with args", () => {
    const p = parsePreset("gitlab>acme/cfg:strict(arg0)");
    expect(p).toMatchObject({
      source: "gitlab",
      repoPath: "acme/cfg",
      presetName: "strict",
      args: ["arg0"],
    });
  });

  it("treats bare names as npm presets", () => {
    const p = parsePreset("some-npm-preset");
    expect(p).toMatchObject({ source: "npm", repoPath: "some-npm-preset" });
  });
});

describe("resolveConfig with externalPresets: true", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("fetches and expands a github> preset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ automerge: true, schedule: ["weekly"] }), {
        status: 200,
      }),
    );
    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/cfg"] },
      { fetchExternal: true },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(resolved).toMatchObject({ automerge: true, schedule: ["weekly"] });
    expect(presetsResolved).toEqual(["github>acme/cfg"]);
    expect(presetsUnresolved).toEqual([]);
  });

  it("recursively expands external extends chains against the same cache", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/acme/base/")) {
        return new Response(JSON.stringify({ automerge: true }), { status: 200 });
      }
      if (url.includes("/acme/outer/")) {
        return new Response(
          JSON.stringify({
            extends: ["github>acme/base", "github>acme/base"],
            schedule: ["weekly"],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404, statusText: "Not Found" });
    });

    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["github>acme/outer"] },
      { fetchExternal: true },
    );

    // outer + base × 2 (but base should be cached, so 2 fetch calls total)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(resolved).toMatchObject({ automerge: true, schedule: ["weekly"] });
    expect(presetsResolved).toContain("github>acme/outer");
    expect(presetsResolved.filter((p) => p === "github>acme/base")).toHaveLength(2);
    expect(presetsUnresolved).toEqual([]);
  });

  it("lands a 404 in presetsUnresolved with a clean reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 404, statusText: "Not Found" }),
    );
    const { presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["github>does/not-exist"] },
      { fetchExternal: true },
    );
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.preset).toBe("github>does/not-exist");
    expect(presetsUnresolved[0]?.reason).toMatch(/404/);
  });

  it("mixes built-in and external presets in one call", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ schedule: ["before 6am"] }), { status: 200 }),
    );
    const { resolved, presetsResolved } = await resolveConfig(
      { extends: ["default:automergeAll", "github>acme/cfg"] },
      { fetchExternal: true },
    );
    expect(resolved).toMatchObject({ automerge: true, schedule: ["before 6am"] });
    expect(presetsResolved).toEqual(["default:automergeAll", "github>acme/cfg"]);
  });
});

describe("structurally-unsupported sources: identical reason across flag values", () => {
  // These sources can never be fetched by resolve_config — flipping the flag
  // must not change the reason the user sees.
  const cases: Array<{ preset: string; matcher: RegExp }> = [
    { preset: "local>acme/cfg", matcher: /out of scope/i },
    { preset: "bitbucket>acme/cfg", matcher: /not yet supported/i },
    { preset: "gitea>acme/cfg", matcher: /not yet supported/i },
    { preset: "some-npm-preset", matcher: /npm-hosted/i },
  ];

  for (const { preset, matcher } of cases) {
    it(`${preset}: reason is identical with externalPresets false vs true`, async () => {
      const off = await resolveConfig({ extends: [preset] });
      const on = await resolveConfig({ extends: [preset] }, { fetchExternal: true });

      expect(off.presetsUnresolved).toHaveLength(1);
      expect(on.presetsUnresolved).toHaveLength(1);
      expect(off.presetsUnresolved[0]?.reason).toBe(on.presetsUnresolved[0]?.reason);
      expect(off.presetsUnresolved[0]?.reason).toMatch(matcher);
      // The misleading "pass externalPresets: true to enable" phrasing must
      // not appear for structurally-unsupported sources.
      expect(off.presetsUnresolved[0]?.reason).not.toMatch(/externalPresets: true/i);
    });
  }

  it("does not make a network call for structurally-unsupported sources even with externalPresets: true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await resolveConfig(
      { extends: ["local>a/b", "bitbucket>a/b", "gitea>a/b", "some-npm-preset"] },
      { fetchExternal: true },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveConfig with endpoint / platform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("routes github> fetches through a custom endpoint (GitHub Enterprise)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ automerge: true }), { status: 200 }),
    );
    const { resolved, presetsResolved } = await resolveConfig(
      { extends: ["github>acme/cfg"] },
      { fetchExternal: true, endpoint: "https://ghe.example.com/api/v3" },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/cfg/contents/default.json?ref=HEAD",
    );
    expect(resolved).toMatchObject({ automerge: true });
    expect(presetsResolved).toEqual(["github>acme/cfg"]);
  });

  it("routes gitlab> fetches through a custom endpoint (self-hosted GitLab)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ automerge: true }), { status: 200 }),
    );
    await resolveConfig(
      { extends: ["gitlab>acme/cfg"] },
      { fetchExternal: true, endpoint: "https://gitlab.example.com/api/v4" },
    );
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fcfg/repository/files/default.json/raw?ref=HEAD",
    );
  });

  it("rewrites local> through platform + endpoint (self-hosted GitLab)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ automerge: true }), { status: 200 }),
    );
    const { resolved, presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["local>acme/cfg"] },
      {
        fetchExternal: true,
        endpoint: "https://gitlab.example.com/api/v4",
        platform: "gitlab",
      },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://gitlab.example.com/api/v4/projects/acme%2Fcfg/repository/files/default.json/raw?ref=HEAD",
    );
    expect(resolved).toMatchObject({ automerge: true });
    // The original local> string stays in presetsResolved so users see what
    // they wrote, not what we rewrote it to.
    expect(presetsResolved).toEqual(["local>acme/cfg"]);
    expect(presetsUnresolved).toEqual([]);
  });

  it("rewrites local> through platform=github", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ automerge: true }), { status: 200 }),
    );
    await resolveConfig(
      { extends: ["local>acme/cfg"] },
      {
        fetchExternal: true,
        endpoint: "https://ghe.example.com/api/v3",
        platform: "github",
      },
    );
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/cfg/contents/default.json?ref=HEAD",
    );
  });

  it("leaves local> unsupported when platform is not set, even with a custom endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { presetsResolved, presetsUnresolved } = await resolveConfig(
      { extends: ["local>acme/cfg"] },
      { fetchExternal: true, endpoint: "https://gitlab.example.com/api/v4" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.reason).toMatch(/out of scope/i);
  });
});
