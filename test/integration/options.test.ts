import { describe, it, expect, afterEach } from "vitest";
import { startServer, type McpSession } from "../helpers/mcpSession.js";
import { OPTION_NAMES } from "../../src/data/options.generated.js";
import { ALL_MANAGERS, CUSTOM_MANAGERS } from "../../src/data/managers.generated.js";

let session: McpSession;

afterEach(async () => {
  if (session) await session.close();
});

describe("resources/list", () => {
  it("includes renovate://options and renovate://managers", async () => {
    session = await startServer();
    const res = await session.request<{
      resources: Array<{ uri: string }>;
    }>("resources/list");
    const uris = (res.result?.resources ?? []).map((r) => r.uri);
    expect(uris).toContain("renovate://options");
    expect(uris).toContain("renovate://managers");
  });
});

describe("resources/templates/list", () => {
  it("includes the renovate://option/{name} template", async () => {
    session = await startServer();
    const res = await session.request<{
      resourceTemplates: Array<{ uriTemplate: string }>;
    }>("resources/templates/list");
    const templates = (res.result?.resourceTemplates ?? []).map(
      (t) => t.uriTemplate,
    );
    expect(templates).toContain("renovate://option/{name}");
  });
});

describe("renovate://options index", () => {
  it("returns a markdown index containing a known option", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://options" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain(`**${OPTION_NAMES.length} options**`);
    expect(content?.text).toContain("`minimumReleaseAge`");
  });
});

describe("renovate://option/{name} template", () => {
  it("returns rangeStrategy's definition with allowedValues", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://option/rangeStrategy" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("application/json");
    const payload = JSON.parse(content!.text);
    expect(payload.name).toBe("rangeStrategy");
    expect(payload.allowedValues).toContain("pin");
  });

  it("returns an error for an unknown option", async () => {
    session = await startServer();
    const res = await session.request("resources/read", {
      uri: "renovate://option/nope-not-a-real-option",
    });
    expect(res.error).toBeDefined();
    expect(res.error?.message ?? "").toMatch(/unknown option/i);
  });
});

describe("renovate://managers", () => {
  it("returns a markdown list containing npm and regex", async () => {
    session = await startServer();
    const res = await session.request<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>("resources/read", { uri: "renovate://managers" });
    const content = res.result?.contents[0];
    expect(content?.mimeType).toBe("text/markdown");
    expect(content?.text).toContain(`**${ALL_MANAGERS.length} managers**`);
    expect(content?.text).toContain("`npm`");
    expect(content?.text).toContain("`regex`");
    expect(content?.text).toContain(`\`custom.${CUSTOM_MANAGERS[0]}\``);
  });
});
