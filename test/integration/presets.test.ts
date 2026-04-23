import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { PRESET_NAMES, PRESETS } from "../../src/data/presets.generated.js";

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

describe("renovate://presets index", () => {
  it("returns a thin namespace index, not the full preset list", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://presets" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain(`**${PRESET_NAMES.length} presets**`);
    expect(content?.text).toContain("| `config` |");
    expect(content?.text).toContain("`renovate://presets/config`");
    // The index must not inline every preset name — that's the whole point.
    expect(content?.text).not.toContain("`config:recommended`");
  });
});

describe("renovate://presets/{namespace} template", () => {
  it("returns the markdown listing for a single namespace", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://presets/config" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain("# Renovate `config` presets");
    expect(content?.text).toContain("`config:recommended`");
    // Must not leak presets from other namespaces.
    const otherNamespaceSample = PRESET_NAMES.find(
      (n) => PRESETS[n]!.namespace !== "config",
    )!;
    expect(content?.text).not.toContain(`\`${otherNamespaceSample}\``);
  });

  it("returns an error for an unknown namespace", async () => {
    session = await startServer();
    const res = await session.request("resources/read", {
      uri: "renovate://presets/nope-not-a-namespace",
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message ?? "").toMatch(/unknown preset namespace/i);
  });
});

describe("renovate://preset/{name} template", () => {
  it("returns the expanded body for a known preset", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://preset/config:recommended" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("application/json");
    const payload = JSON.parse(content!.text);
    expect(payload.name).toBe("config:recommended");
    expect(payload.namespace).toBe("config");
    expect(payload.description).toBeTruthy();
    expect(payload.body).toHaveProperty("extends");
    expect(Array.isArray(payload.body.extends)).toBe(true);
  });

  it("returns an error for an unknown preset", async () => {
    session = await startServer();
    const res = await session.request(
      "resources/read",
      { uri: "renovate://preset/nope:doesnotexist" },
    );
    expect(res.error).toBeDefined();
    expect(res.error?.message ?? "").toMatch(/unknown preset/i);
  });
});

describe("resources/list", () => {
  it("enumerates the index, per-namespace sub-resources, and per-preset entries", async () => {
    session = await startServer();
    const res = await session.request<{
      resources: Array<{ uri: string; name?: string }>;
    }>("resources/list");
    const uris = (res.result?.resources ?? []).map((r) => r.uri);
    expect(uris).toContain("renovate://presets");
    expect(uris).toContain("renovate://presets/config");
    expect(uris).toContain("renovate://preset/config:recommended");
    // Sanity: many per-preset entries, and a modest but non-trivial number of namespaces.
    const perPreset = uris.filter((u) => u.startsWith("renovate://preset/"));
    expect(perPreset.length).toBeGreaterThan(500);
    const perNamespace = uris.filter((u) =>
      /^renovate:\/\/presets\/[^/]+$/.test(u),
    );
    expect(perNamespace.length).toBeGreaterThan(5);
  });
});
