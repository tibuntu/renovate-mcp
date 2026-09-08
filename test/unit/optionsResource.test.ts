import { describe, it, expect } from "vitest";
import {
  renderOptionsIndex,
  renderManagersIndex,
  getOptionEntry,
} from "../../src/resources/options.js";

describe("renderOptionsIndex", () => {
  const text = renderOptionsIndex();

  it("contains a known repository-config option", () => {
    expect(text).toContain("`minimumReleaseAge`");
  });

  it("splits options into repository and global sections", () => {
    const repoHeadingIdx = text.indexOf("## Repository config options");
    const globalHeadingIdx = text.indexOf("## Global / self-hosted-only options");
    expect(repoHeadingIdx).toBeGreaterThan(-1);
    expect(globalHeadingIdx).toBeGreaterThan(repoHeadingIdx);

    // minimumReleaseAge is not globalOnly -> must appear before the global heading.
    const minReleaseIdx = text.indexOf("`minimumReleaseAge`");
    expect(minReleaseIdx).toBeGreaterThan(repoHeadingIdx);
    expect(minReleaseIdx).toBeLessThan(globalHeadingIdx);

    // binarySource is globalOnly -> must appear after the global heading.
    const binarySourceIdx = text.indexOf("`binarySource`");
    expect(binarySourceIdx).toBeGreaterThan(globalHeadingIdx);
  });

  it("tags a deprecated option", () => {
    const line = text.split("\n").find((l) => l.includes("`branchName`"));
    expect(line).toBeDefined();
    expect(line).toContain("[deprecated]");
  });
});

describe("getOptionEntry", () => {
  it("returns rangeStrategy with allowedValues including pin", () => {
    const entry = getOptionEntry("rangeStrategy");
    expect(entry).toBeDefined();
    expect(entry?.name).toBe("rangeStrategy");
    expect(entry?.allowedValues).toContain("pin");
  });

  it("returns undefined for an unknown option name", () => {
    expect(getOptionEntry("nope-not-a-real-option")).toBeUndefined();
  });
});

describe("renderManagersIndex", () => {
  const text = renderManagersIndex();

  it("lists managers and custom managers with the custom. prefix form", () => {
    expect(text).toContain("`npm`");
    expect(text).toContain("`regex`");
    expect(text).toContain("## Custom managers");
    expect(text).toContain("`custom.regex`");
  });
});
