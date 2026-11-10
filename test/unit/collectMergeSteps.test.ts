import { describe, it, expect, vi, afterEach } from "vitest";
import { collectMergeSteps, OWN_SOURCE } from "../../src/lib/presetResolver.js";

/**
 * collectMergeSteps is the shared expansion core: it flattens the preset tree
 * into the ordered sequence of leaf configs that both resolve_config and
 * explain_config fold (so the two tools can never drift on *which* configs
 * merge in *what* order). It does NOT merge — it only collects.
 */
describe("collectMergeSteps", () => {
  it("labels a renamed preset's steps with the entry as written", async () => {
    const { steps } = await collectMergeSteps({ extends: ["config:base"] });
    expect(steps.length).toBeGreaterThan(0);
    // Labels/via show the entry as written, never the rename target.
    const names = steps.flatMap((s) => [s.label, ...s.via]);
    expect(names).not.toContain("config:recommended");
    expect(steps.every((s) => s.via[0] === "config:base")).toBe(true);
  });

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

/**
 * Mirrors Renovate's `resolveConfigPresets` (lib/config/presets/index.ts):
 * the root's `ignorePresets` applies to the whole tree when non-empty;
 * otherwise each node's own list applies to its subtree. Matching is by the
 * raw `extends` string, and `ignorePresets` never survives a preset body.
 */
describe("collectMergeSteps — ignorePresets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubPresets(bodies: Record<string, unknown>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      for (const [repo, body] of Object.entries(bodies)) {
        if (url.includes(`/repos/${repo}/`)) {
          return new Response(JSON.stringify(body), { status: 200 });
        }
      }
      return new Response("", { status: 404, statusText: "Not Found" });
    });
  }

  it("skips a top-level preset listed in the root ignorePresets and drops the root list, like Renovate", async () => {
    const { steps, presetsResolved, presetsUnresolved } = await collectMergeSteps({
      extends: [":automergeAll", ":timezone(Europe/Berlin)"],
      ignorePresets: [":automergeAll"],
    });
    expect(presetsResolved).toEqual([":timezone(Europe/Berlin)"]);
    expect(presetsUnresolved).toEqual([]);
    // Renovate's resolveConfigPresets deletes ignorePresets from the root too,
    // so the root has no own keys left and contributes no step.
    expect(steps.map((s) => s.label)).toEqual([":timezone(Europe/Berlin)"]);
  });

  it("applies the root ignorePresets at every depth", async () => {
    const { presetsResolved } = await collectMergeSteps({
      extends: ["config:recommended"],
      ignorePresets: [":dependencyDashboard"],
    });
    expect(presetsResolved).toContain("config:recommended");
    expect(presetsResolved).not.toContain(":dependencyDashboard");
  });

  it("matches the raw string only: ignoring default:automergeAll does not skip :automergeAll", async () => {
    const { presetsResolved } = await collectMergeSteps({
      extends: [":automergeAll"],
      ignorePresets: ["default:automergeAll"],
    });
    expect(presetsResolved).toEqual([":automergeAll"]);
  });

  it("treats a non-array ignorePresets as empty", async () => {
    const { presetsResolved } = await collectMergeSteps({
      extends: [":automergeAll"],
      ignorePresets: ":automergeAll",
    });
    expect(presetsResolved).toEqual([":automergeAll"]);
  });

  it("applies a nested preset's own ignorePresets to its subtree when the root has none, and strips it from the step", async () => {
    stubPresets({
      "acme/outer": {
        extends: [":automergeAll", ":timezone(Europe/Berlin)"],
        ignorePresets: [":automergeAll"],
        schedule: ["weekly"],
      },
    });
    const { steps, presetsResolved } = await collectMergeSteps(
      { extends: ["github>acme/outer", ":automergeAll"], ignorePresets: [] },
      { fetchExternal: true },
    );
    // Ignored inside the outer preset's subtree only; the root's own
    // `:automergeAll` entry is outside it and still resolves.
    expect(presetsResolved).toEqual([
      ":timezone(Europe/Berlin)",
      "github>acme/outer",
      ":automergeAll",
    ]);
    const outer = steps.find((s) => s.label === "github>acme/outer")!;
    expect(outer.config).toEqual({ schedule: ["weekly"] });
    expect(steps.some((s) => s.label === OWN_SOURCE)).toBe(false);
  });

  it("lets a non-empty root list replace a nested preset's own list", async () => {
    stubPresets({
      "acme/outer": {
        extends: [":automergeAll", ":timezone(Europe/Berlin)"],
        ignorePresets: [":automergeAll"],
      },
    });
    const { presetsResolved } = await collectMergeSteps(
      {
        extends: ["github>acme/outer"],
        ignorePresets: [":timezone(Europe/Berlin)"],
      },
      { fetchExternal: true },
    );
    expect(presetsResolved).toEqual([":automergeAll", "github>acme/outer"]);
  });

  it("emits no step for a nested preset whose only own key is ignorePresets", async () => {
    stubPresets({
      "acme/outer": { extends: [":automergeAll"], ignorePresets: [":nope"] },
    });
    const { steps } = await collectMergeSteps(
      { extends: ["github>acme/outer"] },
      { fetchExternal: true },
    );
    expect(steps.map((s) => s.label)).toEqual([":automergeAll"]);
  });
});
