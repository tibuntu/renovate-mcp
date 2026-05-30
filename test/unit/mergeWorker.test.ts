import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { runMerge, MergeTimeoutError } from "../../src/lib/mergeWorker.js";

/**
 * The worker entry (dist/lib/mergeWorkerImpl.js) is pointed at via
 * RENOVATE_MCP_MERGE_WORKER_ENTRY in vitest.config.ts, because in the vitest
 * runtime `import.meta.url` resolves to the TS source under src/ where no
 * compiled sibling .js exists. `pretest` builds dist/ before the suite runs.
 */
describe("runMerge (worker-isolated faithful merge)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an empty object for zero steps without spawning a worker", async () => {
    const { merged } = await runMerge([]);
    expect(merged).toEqual({});
  });

  it("returns the single config unchanged for one step without spawning a worker", async () => {
    const { merged } = await runMerge([
      { automerge: true, schedule: ["weekly"] },
    ]);
    expect(merged).toEqual({ automerge: true, schedule: ["weekly"] });
  });

  it("overwrites scalars (last wins) and concatenates mergeable arrays (packageRules)", async () => {
    const { merged } = await runMerge([
      { automerge: true, packageRules: [{ matchPackageNames: ["a"] }] },
      { automerge: false, packageRules: [{ matchPackageNames: ["b"] }] },
    ]);
    expect(merged.automerge).toBe(false);
    expect(merged.packageRules).toEqual([
      { matchPackageNames: ["a"] },
      { matchPackageNames: ["b"] },
    ]);
  });

  it("overwrites non-mergeable arrays (assignees) instead of concatenating", async () => {
    const { merged } = await runMerge([
      { assignees: ["alice"] },
      { assignees: ["bob"] },
    ]);
    expect(merged.assignees).toEqual(["bob"]);
  });

  it("returns cumulative snapshots (acc after each step) when withSteps is set", async () => {
    const { merged, snapshots } = await runMerge(
      [{ a: 1 }, { b: 2 }, { a: 3 }],
      { withSteps: true },
    );
    expect(snapshots).toEqual([
      { a: 1 },
      { a: 1, b: 2 },
      { a: 3, b: 2 },
    ]);
    expect(merged).toEqual({ a: 3, b: 2 });
  });

  it("throws MergeTimeoutError when the cold-load budget is exceeded", async () => {
    await expect(
      runMerge([{ a: 1 }, { b: 2 }], { timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(MergeTimeoutError);
  });

  it("rejects promptly when the worker exits non-zero without posting a result", async () => {
    // A worker that exits before posting (here a fixture that calls
    // process.exit(1), firing neither 'message' nor 'error') must not hang
    // until the timeout. The old handler swallowed exit code 1 and only threw
    // MergeTimeoutError after the full budget.
    vi.stubEnv(
      "RENOVATE_MCP_MERGE_WORKER_ENTRY",
      resolve(process.cwd(), "test/fixtures/exit-one-worker.mjs"),
    );
    await expect(
      runMerge([{ a: 1 }, { b: 2 }], { timeoutMs: 2000 }),
    ).rejects.toThrow(/exited \(code 1\)/);
  });
});

describe("mergeable-array drift sentinel", () => {
  // Which arrays Renovate concatenates vs overwrites is load-bearing for
  // resolve_config / explain_config fidelity. Pin a representative set so a
  // Renovate bump that reclassifies any of them fails loudly in PR CI — not
  // only in the nightly real-Renovate run.
  it("concatenates known-mergeable arrays and overwrites known-non-mergeable arrays", async () => {
    const { merged } = await runMerge([
      {
        packageRules: [{ matchPackageNames: ["a"] }],
        hostRules: [{ matchHost: "a.example" }],
        addLabels: ["a"],
        matchPackageNames: ["a"],
        assignees: ["a"],
        reviewers: ["a"],
        labels: ["a"],
        schedule: ["before 6am"],
      },
      {
        packageRules: [{ matchPackageNames: ["b"] }],
        hostRules: [{ matchHost: "b.example" }],
        addLabels: ["b"],
        matchPackageNames: ["b"],
        assignees: ["b"],
        reviewers: ["b"],
        labels: ["b"],
        schedule: ["after 10pm"],
      },
    ]);

    // Mergeable → concatenated.
    expect(merged.packageRules).toEqual([
      { matchPackageNames: ["a"] },
      { matchPackageNames: ["b"] },
    ]);
    expect(merged.hostRules).toEqual([
      { matchHost: "a.example" },
      { matchHost: "b.example" },
    ]);
    expect(merged.addLabels).toEqual(["a", "b"]);
    expect(merged.matchPackageNames).toEqual(["a", "b"]);

    // Non-mergeable → overwritten (last writer wins).
    expect(merged.assignees).toEqual(["b"]);
    expect(merged.reviewers).toEqual(["b"]);
    expect(merged.labels).toEqual(["b"]);
    expect(merged.schedule).toEqual(["after 10pm"]);
  });
});
