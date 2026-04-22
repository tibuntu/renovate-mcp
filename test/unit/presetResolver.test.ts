import { describe, it, expect } from "vitest";
import { resolveConfig } from "../../src/lib/presetResolver.js";

describe("resolveConfig", () => {
  it("returns the input unchanged when there are no extends", () => {
    const { resolved, presetsResolved, presetsUnresolved } = resolveConfig({
      schedule: ["before 6am"],
    });
    expect(resolved).toEqual({ schedule: ["before 6am"] });
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toEqual([]);
  });

  it("expands a built-in preset and records it as resolved", () => {
    const { resolved, presetsResolved, presetsUnresolved } = resolveConfig({
      extends: ["default:automergeAll"],
    });
    expect(resolved).toEqual({ automerge: true });
    expect(presetsResolved).toContain("default:automergeAll");
    expect(presetsUnresolved).toEqual([]);
    expect(resolved).not.toHaveProperty("extends");
  });

  it("treats `:foo` as shorthand for `default:foo`", () => {
    const { resolved, presetsResolved } = resolveConfig({
      extends: [":automergeAll"],
    });
    expect(resolved).toMatchObject({ automerge: true });
    expect(presetsResolved).toContain(":automergeAll");
  });

  it("recursively expands nested extends", () => {
    // `config:recommended` extends a chain of other presets.
    const { resolved, presetsResolved, presetsUnresolved } = resolveConfig({
      extends: ["config:recommended"],
    });
    expect(presetsResolved).toContain("config:recommended");
    // recursion should have pulled in at least one nested preset
    expect(presetsResolved.length).toBeGreaterThan(1);
    expect(resolved).not.toHaveProperty("extends");
    // The user should see keys contributed by nested presets, not a raw chain.
    expect(presetsUnresolved).toEqual([]);
  });

  it("lets outer config override preset-provided values", () => {
    const { resolved } = resolveConfig({
      extends: ["default:automergeAll"],
      automerge: false,
    });
    expect(resolved).toMatchObject({ automerge: false });
  });

  it("concatenates arrays from preset and outer config", () => {
    const { resolved } = resolveConfig({
      extends: ["default:automergeAll"],
      packageRules: [{ matchPackageNames: ["lodash"] }],
    });
    expect(resolved).toMatchObject({
      automerge: true,
      packageRules: [{ matchPackageNames: ["lodash"] }],
    });
  });

  it("substitutes positional arguments into preset body", () => {
    const { resolved, presetsResolved } = resolveConfig({
      extends: ["default:assignee(alice)"],
    });
    expect(resolved).toMatchObject({ assignees: ["alice"] });
    expect(presetsResolved).toContain("default:assignee(alice)");
  });

  it("flags github> presets as unresolved with a network reason", () => {
    const { presetsResolved, presetsUnresolved } = resolveConfig({
      extends: ["github>some/repo"],
    });
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.preset).toBe("github>some/repo");
    expect(presetsUnresolved[0]?.reason).toMatch(/network/i);
  });

  it("flags gitlab>, local>, and npm presets too", () => {
    const { presetsUnresolved } = resolveConfig({
      extends: ["gitlab>a/b", "local>a/b", "some-npm-preset"],
    });
    expect(presetsUnresolved.map((p) => p.preset).sort()).toEqual([
      "gitlab>a/b",
      "local>a/b",
      "some-npm-preset",
    ]);
  });

  it("flags unknown built-in presets", () => {
    const { presetsUnresolved } = resolveConfig({
      extends: ["config:doesNotExist"],
    });
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.preset).toBe("config:doesNotExist");
    expect(presetsUnresolved[0]?.reason).toMatch(/catalogue/i);
  });

  it("resolves siblings independently when one is unknown", () => {
    const { resolved, presetsResolved, presetsUnresolved } = resolveConfig({
      extends: ["default:automergeAll", "config:doesNotExist"],
    });
    expect(resolved).toMatchObject({ automerge: true });
    expect(presetsResolved).toContain("default:automergeAll");
    expect(presetsUnresolved.map((p) => p.preset)).toContain("config:doesNotExist");
  });
});
