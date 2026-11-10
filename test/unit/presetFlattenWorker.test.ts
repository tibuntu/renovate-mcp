import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import {
  findLocalPresets,
  flattenLocalPresets,
  isLocalPreset,
  nestedLocalPresetHint,
  resolveLocalPresetRoute,
} from "../../src/lib/presetFlattenWorker.js";

/**
 * The worker entry (dist/lib/presetFlattenWorkerImpl.js) is pointed at via
 * RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY in vitest.config.ts. The preset
 * host is a local GitLab-shaped server: Renovate's worker accepts a plain-http
 * loopback endpoint, and only dry_run's endpoint validator refuses one.
 */

const files: Record<string, Record<string, unknown>> = {
  "acme/widgets": {
    extends: ["local>acme/base"],
    rangeStrategy: "replace",
    labels: ["widgets"],
    packageRules: [{ matchPackageNames: ["foo"], extends: ["local>acme/rule"] }],
  },
  "acme/base": { prHourlyLimit: 3, labels: ["base"] },
  "acme/rule": { automerge: true },
  "acme/args": { labels: ["{{arg0}}"] },
  "acme/invalid": { notARenovateOption: true },
  "acme/lfm": { enabled: false, commitMessageAction: "from-preset" },
};
const requests: Array<{ url: string; auth: string | undefined }> = [];
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url!, auth: req.headers.authorization });
    const content = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64");
    const gitlab = /^\/api\/v4\/projects\/([^/]+)\/repository\/files\/default\.json\?ref=HEAD$/.exec(req.url!);
    const gitea = /^\/api\/v1\/repos\/(\w+\/\w+)\/contents\/default\.json$/.exec(req.url!);
    const body = gitlab ? files[decodeURIComponent(gitlab[1]!)] : gitea ? files[gitea[1]!] : undefined;
    if (!body) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    const reply = gitlab
      ? { content: content(body) }
      : { type: "file", name: "default.json", path: "default.json", content: content(body) };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4/`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

afterEach(() => {
  requests.length = 0;
  vi.unstubAllEnvs();
});

const flatten = (config: Record<string, unknown>, hostRules: Array<Record<string, unknown>> = []) =>
  flattenLocalPresets(config, { platform: "gitlab", endpoint, hostRules });

describe("isLocalPreset (Renovate's parsePreset source detection)", () => {
  it.each([
    "local>acme/widgets",
    "local>acme/widgets:strict",
    "acme/widgets",
    "acme/widgets:strict#v1",
    "npm>foo/bar",
  ])("treats %s as local", (entry) => {
    expect(isLocalPreset(entry)).toBe(true);
  });

  it.each([
    ":semanticCommits",
    "config:recommended",
    "group:monorepos",
    "group:acme/widgets",
    "npm>group:acme/widgets",
    "npm>renovate-config-acme",
    "github>acme/widgets",
    "gitlab>acme/widgets",
    "gitea>acme/widgets",
    "forgejo>acme/widgets",
    "npm>@acme/preset",
    "@acme/preset",
    "@acme/preset/sub",
    "./local",
    "../up",
    "/abs",
    "https://example.com/preset.json",
    "http://example.com/a/b.json",
    "renovate-config-acme",
  ])("does not treat %s as local", (entry) => {
    expect(isLocalPreset(entry)).toBe(false);
  });
});

describe("findLocalPresets (walks like resolveConfigPresets)", () => {
  it("finds top-level, implicit and nested local presets in order", () => {
    expect(
      findLocalPresets({
        extends: [":semanticCommits", "local>acme/a", 42, "acme/b"],
        packageRules: [{ extends: ["local>acme/c"] }, "not-an-object", { matchPackageNames: ["x"] }],
        lockFileMaintenance: { extends: ["acme/d"] },
      }),
    ).toEqual(["local>acme/a", "acme/b", "local>acme/c", "acme/d"]);
  });

  it("accepts a string extends, which Renovate's migration turns into a one-entry list", () => {
    expect(findLocalPresets({ extends: "local>acme/a" })).toEqual(["local>acme/a"]);
    expect(findLocalPresets({ packageRules: [{ extends: "acme/b" }], lockFileMaintenance: { extends: "acme/c" } })).toEqual([
      "acme/b",
      "acme/c",
    ]);
    expect(findLocalPresets({ extends: ":semanticCommits" })).toEqual([]);
  });

  it("finds none in configs without local presets, and skips the keys Renovate skips", () => {
    expect(findLocalPresets({})).toEqual([]);
    expect(findLocalPresets({ extends: [":semanticCommits", "github>acme/x"] })).toEqual([]);
    expect(findLocalPresets({ onboardingConfig: { extends: ["local>acme/a"] } })).toEqual([]);
    expect(findLocalPresets({ content: { extends: ["local>acme/a"] } })).toEqual([]);
    expect(findLocalPresets({ packageRules: [[{ extends: ["local>acme/a"] }]] })).toEqual([]);
    expect(findLocalPresets(null)).toEqual([]);
  });
});

describe("flattenLocalPresets (Renovate's resolver in a worker)", () => {
  it("keeps the leading built-ins, resolves the rest in Renovate's order, and sends the scoped token", async () => {
    const res = await flatten(
      {
        extends: [":semanticCommits", "local>acme/widgets", "acme/base", ":pinVersions"],
        labels: ["own"],
        ignorePresets: [":dependencyDashboard"],
      },
      [{ hostType: "gitlab", matchHost: "127.0.0.1", token: "glpat-scoped" }],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.keptExtends).toEqual([":semanticCommits"]);
    expect(res.config.extends).toEqual([":semanticCommits"]);
    // The root list goes back in for the spawned Renovate's built-ins.
    expect(res.config.ignorePresets).toEqual([":dependencyDashboard"]);
    // :pinVersions comes after local>acme/widgets and wins rangeStrategy;
    // the own key wins labels.
    expect(res.config.rangeStrategy).toBe("pin");
    expect(res.config.labels).toEqual(["own"]);
    expect(res.config.prHourlyLimit).toBe(3);
    // packageRules[].extends is resolved too, through the same endpoint.
    expect(res.config.packageRules).toEqual([
      expect.objectContaining({ matchPackageNames: ["foo"], automerge: true }),
    ]);
    expect(findLocalPresets(res.config)).toEqual([]);
    expect(res.flattenedPresets).toEqual(
      expect.arrayContaining(["local>acme/widgets", "local>acme/base", "acme/base", "local>acme/rule", ":pinVersions"]),
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.auth === "Bearer glpat-scoped")).toBe(true);
  });

  it("resolves everything when the first entry is not built-in, applies preset arguments and honours ignorePresets", async () => {
    const res = await flatten({
      extends: ["local>acme/args(from-arg)", "local>acme/base"],
      ignorePresets: ["local>acme/base"],
    });
    expect(res).toMatchObject({ ok: true, keptExtends: [], config: { labels: ["from-arg"] } });
    if (!res.ok) return;
    expect(res.config).not.toHaveProperty("extends");
    expect(res.config).not.toHaveProperty("ignorePresets");
    expect(res.config).not.toHaveProperty("prHourlyLimit");
    expect(requests.some((r) => r.url.includes("acme%2Fbase"))).toBe(false);
    expect(requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it("trims a Forgejo endpoint's /api/v1 like Renovate's initPlatform before the preset source adds it", async () => {
    const res = await flattenLocalPresets(
      { extends: ["local>acme/base"] },
      { platform: "forgejo", endpoint: endpoint.replace("/api/v4/", "/api/v1"), hostRules: [] },
    );
    expect(res).toMatchObject({ ok: true, config: { prHourlyLimit: 3 } });
    expect(requests.map((r) => r.url)).toEqual(["/api/v1/repos/acme/base/contents/default.json"]);
  });

  it("refuses with Renovate's message when a preset cannot be found", async () => {
    const res = await flatten({ extends: ["local>acme/missing"] });
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("Cannot find preset's package (local>acme/missing)"),
    });
  });

  it("refuses a flattened config Renovate's repo validation rejects, naming the offending option", async () => {
    const res = await flatten({ extends: ["local>acme/invalid"] });
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("notARenovateOption") });
    // A platform run would accept it: Renovate only logs resolved preset content at debug level.
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("A platform run would accept this config") });
  });

  it("flattens a string extends like an array", async () => {
    const res = await flatten({ extends: "local>acme/base" });
    expect(res).toMatchObject({ ok: true, keptExtends: [], config: { prHourlyLimit: 3 } });
  });

  it("flattens everything when an own nested object has its own extends, so kept built-ins cannot be reordered", async () => {
    // In one pass Renovate merges :maintainLockFilesWeekly's lockFileMaintenance
    // with the own one first and resolves acme/lfm under both, so the merged
    // object's enabled: true wins. Resolving the suffix alone would let acme/lfm
    // beat the kept built-in in the spawned run.
    const res = await flatten({
      extends: [":maintainLockFilesWeekly", "local>acme/base"],
      lockFileMaintenance: { extends: ["local>acme/lfm"] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.keptExtends).toEqual([]);
    expect(res.config).not.toHaveProperty("extends");
    expect(res.config.lockFileMaintenance).toMatchObject({ enabled: true, commitMessageAction: "from-preset" });
    expect(res.config.prHourlyLimit).toBe(3);
  });

  it("keeps the cut for nested extends only under content / onboardingConfig, which Renovate does not resolve", async () => {
    const res = await flatten({
      extends: [":semanticCommits", "local>acme/base"],
      onboardingConfig: { extends: ["config:recommended"] },
      vulnerabilityAlerts: { labels: ["sec"] },
    });
    expect(res).toMatchObject({ ok: true, keptExtends: [":semanticCommits"] });
  });

  it("refuses when the worker fails, without a preview fallback", async () => {
    vi.stubEnv("RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY", resolve(process.cwd(), "test/fixtures/exit-one-worker.mjs"));
    const res = await flatten({ extends: ["local>acme/base"] });
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/^Renovate preset flattening worker exited/) });
  });

  it("defaults to the compiled sibling entry, which is absent next to the TS source under vitest", async () => {
    vi.stubEnv("RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY", undefined);
    const res = await flattenLocalPresets({}, { platform: "gitlab", hostRules: [] });
    expect(res).toEqual({ ok: false, reason: expect.stringContaining("presetFlattenWorkerImpl.js") });
  });

  it("refuses when the worker exceeds timeoutMs", async () => {
    // reply-worker without a mode never replies.
    vi.stubEnv("RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY", resolve(process.cwd(), "test/fixtures/reply-worker.mjs"));
    const res = await flattenLocalPresets({}, { platform: "gitlab", hostRules: [], timeoutMs: 50 });
    expect(res).toEqual({ ok: false, reason: "Renovate preset flattening worker exceeded 50ms" });
  });

  it("refuses when a local preset survives the resolver, and passes worker warnings through", async () => {
    vi.stubEnv("RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY", resolve(process.cwd(), "test/fixtures/flatten-echo-worker.mjs"));
    const left = await flatten({ extends: ["local>acme/base"] });
    expect(left).toEqual({ ok: false, reason: expect.stringContaining("local>acme/base") });
    const clean = await flatten({ labels: ["x"] });
    expect(clean).toEqual({
      ok: true,
      config: { labels: ["x"] },
      keptExtends: [],
      flattenedPresets: [],
      warnings: ["Configuration Warning: echoed"],
    });
  });
});

describe("nestedLocalPresetHint", () => {
  it("names a local preset Renovate could not resolve under platform=local", () => {
    const hint = nestedLocalPresetHint([
      { validationError: "Preset caused unexpected error (local>acme/inner). Note: this is a *nested* preset so please contact the preset author if you are unable to fix it yourself." },
    ]);
    expect(hint).toMatch(/local>acme\/inner/);
    expect(hint).toMatch(/presetPlatform/);
  });

  it("stays silent for other report errors", () => {
    expect(nestedLocalPresetHint([])).toBeUndefined();
    expect(nestedLocalPresetHint([{ validationError: "Preset caused unexpected error (github>acme/x)" }])).toBeUndefined();
    expect(nestedLocalPresetHint([{ validationError: "Cannot find preset's package (local>acme/x)" }])).toBeUndefined();
    expect(nestedLocalPresetHint([{ message: "config-validation" }])).toBeUndefined();
  });
});

describe("resolveLocalPresetRoute", () => {
  const dirs: string[] = [];
  const repoWithOrigin = (url?: string) => {
    const dir = mkdtempSync(`${tmpdir()}/rmcp-route-`);
    dirs.push(dir);
    if (url !== undefined) {
      mkdirSync(`${dir}/.git`);
      writeFileSync(`${dir}/.git/config`, `[remote "origin"]\n\turl = ${url}\n`);
    }
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const noEnv = {};

  it("takes presetPlatform and endpoint from the input without reading the origin", async () => {
    expect(await resolveLocalPresetRoute(repoWithOrigin(), { presetPlatform: "github" }, noEnv)).toEqual({
      ok: true,
      scope: { platform: "github" },
    });
    expect(
      await resolveLocalPresetRoute(
        repoWithOrigin("git@gitlab.example.com:acme/w.git"),
        { presetPlatform: "gitlab", endpoint: "https://gitlab.example.com/api/v4" },
        noEnv,
      ),
    ).toEqual({ ok: true, scope: { platform: "gitlab", endpoint: "https://gitlab.example.com/api/v4" } });
  });

  it("derives a hosted platform from the origin, and codeberg's API base for hosted Forgejo", async () => {
    expect(await resolveLocalPresetRoute(repoWithOrigin("git@github.com:acme/w.git"), {}, noEnv)).toEqual({
      ok: true,
      scope: { platform: "github" },
    });
    expect(await resolveLocalPresetRoute(repoWithOrigin("https://gitea.com/acme/w.git"), {}, noEnv)).toEqual({
      ok: true,
      scope: { platform: "gitea" },
    });
    expect(await resolveLocalPresetRoute(repoWithOrigin("https://codeberg.org/acme/w.git"), {}, noEnv)).toEqual({
      ok: true,
      scope: { platform: "forgejo", endpoint: "https://codeberg.org/api/v1" },
    });
  });

  it("derives a self-hosted flavour and takes the endpoint from the env per ADR-0008", async () => {
    const repo = repoWithOrigin("git@gitlab.example.com:acme/w.git");
    expect(
      await resolveLocalPresetRoute(repo, {}, { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "https://gitlab.example.com/api/v4" }),
    ).toEqual({ ok: true, scope: { platform: "gitlab", endpoint: "https://gitlab.example.com/api/v4" } });
    // An env endpoint for another platform does not apply to the derived one.
    expect(
      await resolveLocalPresetRoute(repo, {}, { RENOVATE_PLATFORM: "github", RENOVATE_ENDPOINT: "https://ghe.example.com/api/v3" }),
    ).toEqual({ ok: false, reason: expect.stringContaining("self-hosted") });
  });

  it("applies an env endpoint to an origin-derived route only when it is on the origin's host", async () => {
    const corp = { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "https://gitlab.corp.example/api/v4" };
    // origin gitlab.com, env endpoint elsewhere: presets come from gitlab.com, not from the env host.
    expect(await resolveLocalPresetRoute(repoWithOrigin("git@gitlab.com:acme/w.git"), {}, corp)).toEqual({
      ok: true,
      scope: { platform: "gitlab" },
    });
    // A self-hosted origin on another host than the env endpoint has no endpoint at all.
    expect(await resolveLocalPresetRoute(repoWithOrigin("git@gitlab.example.com:acme/w.git"), {}, corp)).toEqual({
      ok: false,
      reason: expect.stringMatching(/gitlab\.example\.com.*`endpoint`/),
    });
    // github.com origin with an api.github.com env endpoint: same host family, kept.
    expect(
      await resolveLocalPresetRoute(repoWithOrigin("https://github.com/acme/w.git"), {}, {
        RENOVATE_PLATFORM: "github",
        RENOVATE_ENDPOINT: "https://api.github.com/",
      }),
    ).toEqual({ ok: true, scope: { platform: "github", endpoint: "https://api.github.com/" } });
    // A hosted Forgejo keeps its derived endpoint over an env endpoint for another host.
    expect(
      await resolveLocalPresetRoute(repoWithOrigin("https://codeberg.org/acme/w.git"), {}, {
        RENOVATE_PLATFORM: "forgejo",
        RENOVATE_ENDPOINT: "https://forgejo.corp.example/api/v1",
      }),
    ).toEqual({ ok: true, scope: { platform: "forgejo", endpoint: "https://codeberg.org/api/v1" } });
    // presetPlatform is the caller's choice: the env endpoint applies as before (ADR-0008).
    expect(await resolveLocalPresetRoute(repoWithOrigin("git@gitlab.com:acme/w.git"), { presetPlatform: "gitlab" }, corp)).toEqual({
      ok: true,
      scope: { platform: "gitlab", endpoint: "https://gitlab.corp.example/api/v4" },
    });
  });

  it("refuses a self-hosted origin without an endpoint, naming the inputs", async () => {
    const res = await resolveLocalPresetRoute(repoWithOrigin("https://gitlab.example.com/acme/w.git"), {}, noEnv);
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/gitlab\.example\.com.*`endpoint`/) });
  });

  it("refuses when no platform can be derived, naming presetPlatform", async () => {
    for (const url of [undefined, "not a url", "https://git.example.com/acme/w.git"]) {
      const res = await resolveLocalPresetRoute(repoWithOrigin(url), {}, noEnv);
      expect(res).toEqual({ ok: false, reason: expect.stringContaining("`presetPlatform`") });
    }
  });

  it("refuses Bitbucket, whose local presets Renovate reads through an initialised platform client", async () => {
    expect(await resolveLocalPresetRoute(repoWithOrigin("git@bitbucket.org:acme/w.git"), {}, noEnv)).toEqual({
      ok: false,
      reason: expect.stringContaining("Bitbucket"),
    });
  });

  it("refuses a blocked endpoint, also when it comes from the env", async () => {
    expect(
      await resolveLocalPresetRoute(repoWithOrigin(), { presetPlatform: "gitlab" }, { RENOVATE_PLATFORM: "gitlab", RENOVATE_ENDPOINT: "http://10.0.0.1/api/v4" }),
    ).toEqual({ ok: false, reason: expect.stringContaining("Invalid endpoint") });
  });
});
