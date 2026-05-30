import { describe, it, expect } from "vitest";
import { collectMergeSteps, OWN_SOURCE } from "../../src/lib/presetResolver.js";

/**
 * collectMergeSteps is the shared expansion core: it flattens the preset tree
 * into the ordered sequence of leaf configs that both resolve_config and
 * explain_config fold (so the two tools can never drift on *which* configs
 * merge in *what* order). It does NOT merge — it only collects.
 */
describe("collectMergeSteps", () => {
  it("emits a single <own> step for a config with no extends", async () => {
    const { steps, presetsResolved } = await collectMergeSteps({
      schedule: ["before 6am"],
    });
    expect(steps).toEqual([
      { label: OWN_SOURCE, via: [], config: { schedule: ["before 6am"] } },
    ]);
    expect(presetsResolved).toEqual([]);
  });

  it("emits the preset body then the own-keys override, in order", async () => {
    const { steps, presetsResolved } = await collectMergeSteps({
      extends: ["default:automergeAll"],
      automerge: false,
    });
    expect(steps).toEqual([
      { label: "default:automergeAll", via: [], config: { automerge: true } },
      { label: OWN_SOURCE, via: [], config: { automerge: false } },
    ]);
    expect(presetsResolved).toEqual(["default:automergeAll"]);
  });

  it("omits an empty own-keys step (single preset, no sibling keys)", async () => {
    const { steps } = await collectMergeSteps({
      extends: ["default:automergeAll"],
    });
    expect(steps).toEqual([
      { label: "default:automergeAll", via: [], config: { automerge: true } },
    ]);
  });

  it("records a via chain for nested presets, outermost first", async () => {
    const { steps, presetsResolved } = await collectMergeSteps({
      extends: ["config:recommended"],
    });
    expect(presetsResolved.length).toBeGreaterThan(1);
    const nested = steps.filter((s) => s.via.length > 0);
    expect(nested.length).toBeGreaterThan(0);
    for (const s of nested) expect(s.via[0]).toBe("config:recommended");
  });

  it("lands unresolvable presets in presetsUnresolved without emitting a step", async () => {
    const { steps, presetsUnresolved } = await collectMergeSteps({
      extends: ["config:doesNotExist"],
      automerge: true,
    });
    expect(presetsUnresolved.map((p) => p.preset)).toContain(
      "config:doesNotExist",
    );
    expect(steps).toEqual([
      { label: OWN_SOURCE, via: [], config: { automerge: true } },
    ]);
  });
});
