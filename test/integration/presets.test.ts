import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { PRESET_NAMES } from "../../src/data/presets.generated.js";

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

describe("renovate://presets index", () => {
  it("returns markdown grouped by namespace with the total count", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://presets" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain(`**${PRESET_NAMES.length} presets**`);
    expect(content?.text).toContain("## `config`");
    expect(content?.text).toContain("`config:recommended`");
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
  it("enumerates both the index and per-preset entries", async () => {
    session = await startServer();
    const res = await session.request<{
      resources: Array<{ uri: string; name?: string }>;
    }>("resources/list");
    const uris = (res.result?.resources ?? []).map((r) => r.uri);
    expect(uris).toContain("renovate://presets");
    expect(uris).toContain("renovate://preset/config:recommended");
    // Quick sanity: we should be surfacing a lot of presets, not just 20.
    const perPreset = uris.filter((u) => u.startsWith("renovate://preset/"));
    expect(perPreset.length).toBeGreaterThan(500);
  });
});
