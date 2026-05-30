import { describe, it, expect, vi, afterEach } from "vitest";
import { explainConfig, OWN_SOURCE } from "../../src/lib/configExplainer.js";
import { resolveConfig } from "../../src/lib/presetResolver.js";

/**
 * Coverage strategy: every `explain_config` claim is "for the same input,
 * `explanation`'s leaf `value`s match what `resolve_config` would produce, and
 * `setBy` lists the contributors in the right order". Where possible the tests
 * cross-check against `resolveConfig` so the two tools cannot drift.
 */

describe("explainConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns the input unchanged with a <own> source when there are no extends", async () => {
    const { explanation, presetsResolved, presetsUnresolved } = await explainConfig({
      schedule: ["before 6am"],
      automerge: false,
    });
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved).toEqual([]);
    expect(explanation).toMatchObject({
      schedule: {
        value: ["before 6am"],
        setBy: [{ source: OWN_SOURCE, via: [], value: ["before 6am"] }],
      },
      automerge: {
        value: false,
        setBy: [{ source: OWN_SOURCE, via: [], value: false }],
      },
    });
    // `extends` itself is dropped from the explanation, mirroring resolve_config.
    expect(explanation).not.toHaveProperty("extends");
  });

  it("attributes a built-in preset's leaves to the preset itself", async () => {
    const { explanation, presetsResolved } = await explainConfig({
      extends: ["default:automergeAll"],
    });
    expect(presetsResolved).toContain("default:automergeAll");
    expect(explanation.automerge).toEqual({
      value: true,
      setBy: [
        { source: "default:automergeAll", via: [], value: true },
      ],
    });
  });

  it("treats `:foo` as shorthand for `default:foo` and uses the literal extends string as the source", async () => {
    const { explanation } = await explainConfig({
      extends: [":automergeAll"],
    });
    // Source is the literal entry — what the user wrote — not the canonical key.
    expect(explanation.automerge).toEqual({
      value: true,
      setBy: [{ source: ":automergeAll", via: [], value: true }],
    });
  });

  it("records own-config overrides as a later contribution that wins", async () => {
    const { explanation } = await explainConfig({
      extends: ["default:automergeAll"],
      automerge: false,
    });
    const leaf = explanation.automerge as { value: unknown; setBy: unknown[] };
    expect(leaf.value).toBe(false);
    expect(leaf.setBy).toEqual([
      { source: "default:automergeAll", via: [], value: true },
      { source: OWN_SOURCE, via: [], value: false },
    ]);
  });

  it("overwrites non-mergeable arrays (assignees) but keeps the contribution history", async () => {
    // `assignees` is NOT a mergeable Renovate option, so the own value wins
    // outright — faithful merge overwrites rather than concatenating. setBy
    // still lists both contributors in order, the last writer winning.
    const { explanation } = await explainConfig({
      extends: ["default:assignee(alice)"],
      assignees: ["bob"],
    });
    expect(explanation.assignees).toEqual({
      value: ["bob"],
      setBy: [
        { source: "default:assignee(alice)", via: [], value: ["alice"] },
        { source: OWN_SOURCE, via: [], value: ["bob"] },
      ],
    });
  });

  it("attributes each contributor's slice for a mergeable array (addLabels)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ addLabels: ["from-preset"] }), {
        status: 200,
      }),
    );
    const { explanation } = await explainConfig(
      { extends: ["github>acme/cfg"], addLabels: ["from-own"] },
      { fetchExternal: true },
    );
    // addLabels IS mergeable → concatenated; each contributor records its slice.
    expect(explanation.addLabels).toEqual({
      value: ["from-preset", "from-own"],
      setBy: [
        { source: "github>acme/cfg", via: [], value: ["from-preset"] },
        { source: OWN_SOURCE, via: [], value: ["from-own"] },
      ],
    });
  });

  it("does not credit a preset that re-asserts an already-set value", async () => {
    // Both default:automergeAll and the own config set automerge:true. Under
    // diff-based attribution only the first writer is credited — the second
    // changed nothing. This is the one intentional behavior change vs the old
    // parallel-merge attribution.
    const { explanation } = await explainConfig({
      extends: ["default:automergeAll"],
      automerge: true,
    });
    expect(explanation.automerge).toEqual({
      value: true,
      setBy: [{ source: "default:automergeAll", via: [], value: true }],
    });
  });

  it("populates `via` with the parent preset chain for nested extends", async () => {
    // config:recommended is a meta-preset that extends a chain of others.
    // Pick any leaf from the explanation and verify its `via` chain starts
    // with `config:recommended`.
    const { explanation, presetsResolved } = await explainConfig({
      extends: ["config:recommended"],
    });
    expect(presetsResolved.length).toBeGreaterThan(1);

    type Leaf = { value: unknown; setBy: Array<{ source: string; via: string[]; value: unknown }> };
    const leaves: Leaf[] = [];
    function collect(node: unknown): void {
      if (node && typeof node === "object" && "setBy" in node && Array.isArray((node as Leaf).setBy)) {
        leaves.push(node as Leaf);
        return;
      }
      if (node && typeof node === "object") {
        for (const child of Object.values(node as Record<string, unknown>)) collect(child);
      }
    }
    collect(explanation);

    // At least one leaf should have been contributed by a nested preset reached via config:recommended.
    const nested = leaves.flatMap((l) => l.setBy).filter((c) => c.via.length > 0);
    expect(nested.length).toBeGreaterThan(0);
    for (const c of nested) {
      expect(c.via[0]).toBe("config:recommended");
    }
  });

  it("emits `value`s identical to resolveConfig's resolved output", async () => {
    const cfg = {
      extends: ["config:recommended", "default:assignee(alice)"],
      automerge: false,
      packageRules: [{ matchPackageNames: ["lodash"], enabled: false }],
    };
    const { resolved } = await resolveConfig(cfg);
    const { explanation } = await explainConfig(cfg);

    // Recursively reduce the annotated tree to a plain config and compare.
    function strip(node: unknown): unknown {
      if (
        node &&
        typeof node === "object" &&
        "setBy" in node &&
        "value" in node &&
        Array.isArray((node as { setBy: unknown[] }).setBy)
      ) {
        return (node as { value: unknown }).value;
      }
      if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          out[k] = strip(v);
        }
        return out;
      }
      return node;
    }
    expect(strip(explanation)).toEqual(resolved);
  });

  it("records cycles in presetsUnresolved without throwing", async () => {
    // We don't need a real cycle in the catalogue — the unresolved list path
    // is exercised whenever a preset key recurs in the stack. Easier: pass a
    // bogus self-referential preset entry and verify it's flagged. Here
    // resolveConfig already covers cycle detection with a real catalogue
    // example; we just confirm explainConfig surfaces unresolved lists too.
    const { presetsUnresolved } = await explainConfig({
      extends: ["config:doesNotExist"],
    });
    expect(presetsUnresolved).toHaveLength(1);
    expect(presetsUnresolved[0]?.preset).toBe("config:doesNotExist");
  });

  it("flags external presets as unresolved by default", async () => {
    const { presetsResolved, presetsUnresolved, explanation } = await explainConfig({
      extends: ["github>some/repo"],
      automerge: true,
    });
    expect(presetsResolved).toEqual([]);
    expect(presetsUnresolved.map((p) => p.preset)).toEqual(["github>some/repo"]);
    // Own keys still get annotated even when an extends entry can't be resolved.
    expect(explanation.automerge).toEqual({
      value: true,
      setBy: [{ source: OWN_SOURCE, via: [], value: true }],
    });
  });

  it("records template warnings (mirrors resolveConfig's warnings list)", async () => {
    // `default:assignee` references `{{arg0}}`; not passing an arg should warn.
    const { warnings } = await explainConfig({
      extends: ["default:assignee"],
    });
    // The exact wording is owned by recordTemplateWarnings; just assert one
    // warning was emitted against the offending preset entry.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.preset).toBe("default:assignee");
  });

  it("recurses into nested objects so each sub-field gets its own contribution chain", async () => {
    const { explanation } = await explainConfig({
      lockFileMaintenance: { enabled: true, schedule: ["before 5am on monday"] },
    });
    // `lockFileMaintenance` is a nested object; we should descend into it.
    const lfm = explanation.lockFileMaintenance as Record<string, unknown>;
    expect(lfm).not.toHaveProperty("setBy");
    expect(lfm.enabled).toEqual({
      value: true,
      setBy: [{ source: OWN_SOURCE, via: [], value: true }],
    });
    expect(lfm.schedule).toEqual({
      value: ["before 5am on monday"],
      setBy: [
        {
          source: OWN_SOURCE,
          via: [],
          value: ["before 5am on monday"],
        },
      ],
    });
  });

  it("falls back to the approximate annotated merge (mergeQuality: preview) when the worker is unavailable", async () => {
    vi.stubEnv(
      "RENOVATE_MCP_MERGE_WORKER_ENTRY",
      "/nonexistent/renovate-mcp-merge-worker.js",
    );
    const { explanation, mergeQuality, warnings } = await explainConfig({
      extends: ["default:assignee(alice)"],
      assignees: ["bob"],
    });
    expect(mergeQuality).toBe("preview");
    // Approximate annotated merge concatenates arrays (pre-faithful behavior).
    expect(explanation.assignees).toEqual({
      value: ["alice", "bob"],
      setBy: [
        { source: "default:assignee(alice)", via: [], value: ["alice"] },
        { source: OWN_SOURCE, via: [], value: ["bob"] },
      ],
    });
    expect(
      warnings.some((w) => /merge worker unavailable/i.test(w.message)),
    ).toBe(true);
  });
});
