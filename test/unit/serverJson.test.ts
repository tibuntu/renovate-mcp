import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Drift guard for server.json (MCP Registry metadata). release-please bumps the
// version in package.json and, via .release-please-config.json extra-files, in
// server.json too; this fails if either side is missed or the registry's
// ownership/namespace rules stop matching package.json.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (rel: string) =>
  JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const pkg = readJson("package.json");
const server = readJson("server.json");
const releaseConfig = readJson(".release-please-config.json");

describe("server.json vs package.json", () => {
  it("name is the GitHub-namespace form the registry requires for GitHub auth", () => {
    expect(server.name).toBe("io.github.tibuntu/renovate-mcp");
    expect(server.name.startsWith("io.github.")).toBe(true);
  });

  it("package.json mcpName matches server.json name (npm ownership check)", () => {
    expect(pkg.mcpName).toBe(server.name);
  });

  it("top-level version matches package.json version", () => {
    expect(server.version).toBe(pkg.version);
  });

  it("the npm package entry points at this package at the same version, over stdio", () => {
    const [npmPkg] = server.packages;
    expect(server.packages).toHaveLength(1);
    expect(npmPkg.registryType).toBe("npm");
    expect(npmPkg.identifier).toBe(pkg.name);
    expect(npmPkg.version).toBe(pkg.version);
    expect(npmPkg.transport).toEqual({ type: "stdio" });
  });

  it("description fits the registry's 100-character limit", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.description.length).toBeGreaterThan(0);
  });

  it("every environment variable is named and secret tokens are marked isSecret", () => {
    for (const ev of server.packages[0].environmentVariables ?? []) {
      expect(typeof ev.name).toBe("string");
      if (/TOKEN$/.test(ev.name)) expect(ev.isSecret, ev.name).toBe(true);
    }
  });

  it("release-please bumps server.json's version fields on release", () => {
    const extra = releaseConfig.packages["."]["extra-files"] as Array<
      string | { type?: string; path?: string; jsonpath?: string }
    >;
    expect(extra).toContainEqual({
      type: "json",
      path: "server.json",
      jsonpath: "$.version",
    });
    expect(extra).toContainEqual({
      type: "json",
      path: "server.json",
      jsonpath: "$.packages[0].version",
    });
  });
});
