import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import {
  SERVER_VERSION,
  describeVersion,
  getVersionInfo,
} from "../../src/lib/version.js";

describe("getVersionInfo", () => {
  it("flags a path inside node_modules as released", () => {
    const url = pathToFileURL(
      "/Users/someone/proj/node_modules/renovate-mcp/dist/index.js",
    ).toString();
    const info = getVersionInfo(url);
    expect(info.mode).toBe("released");
    expect(info.version).toBe(SERVER_VERSION);
    expect(info.scriptPath).toContain("/node_modules/");
  });

  it("flags a path outside node_modules as local", () => {
    const url = pathToFileURL(
      "/Users/someone/git/renovate-mcp/dist/index.js",
    ).toString();
    const info = getVersionInfo(url);
    expect(info.mode).toBe("local");
  });

  it("flags a global npm install (lib/node_modules) as released", () => {
    const url = pathToFileURL(
      "/usr/local/lib/node_modules/renovate-mcp/dist/index.js",
    ).toString();
    expect(getVersionInfo(url).mode).toBe("released");
  });
});

describe("describeVersion", () => {
  it("appends the (local/dev build) marker for local mode", () => {
    const text = describeVersion({
      version: "1.2.3",
      mode: "local",
      scriptPath: "/some/path/dist/index.js",
    });
    expect(text).toContain("renovate-mcp 1.2.3");
    expect(text).toContain("(local/dev build)");
    expect(text).toContain("/some/path/dist/index.js");
  });

  it("omits the marker for released mode", () => {
    const text = describeVersion({
      version: "1.2.3",
      mode: "released",
      scriptPath: "/x/node_modules/renovate-mcp/dist/index.js",
    });
    expect(text).toContain("renovate-mcp 1.2.3");
    expect(text).not.toContain("(local/dev build)");
  });
});
