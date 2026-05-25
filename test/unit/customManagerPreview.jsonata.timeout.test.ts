import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewCustomManager } from "../../src/lib/customManagerPreview.js";

/**
 * Deterministic pathological-expression timeout test.
 *
 * Calibration (run on dev hardware against the unbuilt source):
 *
 *   N=10000   ~37ms (sometimes under 50ms — not reliable)
 *   N=50000   ~54ms timedOut=true at 50ms
 *   N=100000  ~52ms timedOut=true at 50ms (reliable trip)
 *   N=250000  ~54ms timedOut=true at 50ms
 *   N=500000  ~55ms timedOut=true at 50ms
 *
 * N=100000 reliably trips the 50ms timeout. Per the plan's "2x safety margin"
 * guidance, we land N=200000 so even a fast CI runner (or a future JSONata
 * version with a tighter `$reduce` loop) still trips the timeout before the
 * shape-mismatch warning fires.
 *
 * The expression `$reduce(items, function($acc, $v) { $acc + $v }, 0)` returns
 * a number (the sum). On a non-timeout path that primitive shape would trigger
 * the "must return an array of objects or a single object" warning AFTER
 * evaluation completes — but the timeout fires DURING evaluation, kills the
 * worker mid-flight, and the shape check never runs. The timeout warning is
 * what surfaces.
 *
 * If this test ever flakes — e.g. on a CI runner so fast that the worker
 * completes in <50ms — bump N up, do not paper over with `it.skip`. The
 * timeout has to fire FIRST or this whole test loses its point.
 */
const TIMEOUT_CALIBRATED_N = 200_000;

describe("customManagerPreview jsonata pathological-expression timeout", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(
      path.join(tmpdir(), `rmcp-jsonata-timeout-${process.pid}-`),
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it(
    "kills a runaway $reduce expression at the configured 50ms budget and surfaces a timeout warning",
    async () => {
      // Build the input array out-of-band rather than inside the JSONata
      // expression — `[1..N]` range syntax has known memory cliffs on large N
      // and we want the cost to live in the reduce loop, not the range
      // materialization.
      const items = Array.from({ length: TIMEOUT_CALIBRATED_N }, (_, i) => i);
      const fixturePath = path.join(repo, "data.json");
      await writeFile(fixturePath, JSON.stringify({ items }));

      const manager = {
        customType: "jsonata" as const,
        fileFormat: "json" as const,
        fileMatch: ["^data\\.json$"],
        matchStrings: [
          "$reduce(items, function($acc, $v) { $acc + $v }, 0)",
        ],
      };

      const t0 = Date.now();
      const result = await previewCustomManager(repo, manager, {
        matchTimeoutMs: 50,
      });
      const elapsed = Date.now() - t0;

      // Wall-clock budget: 5s should be plenty above the 50ms timeout +
      // worker spin-up. If this fails we have a hang, not a slow test.
      expect(elapsed).toBeLessThan(5000);

      // No deps — the worker was killed before any could be produced.
      expect(result.extractedDeps).toEqual([]);

      // Exactly one warning, and it has the timeout wording locked in by
      // plan 05-02. Critically, NOT the shape-mismatch wording (which would
      // mean the expression finished before the timeout fired, and the
      // calibration needs bumping).
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(
        /JSONata expression exceeded 50ms/,
      );
      expect(result.warnings[0]).not.toMatch(
        /must return an array of objects or a single object/,
      );
    },
    15_000, // vitest per-test timeout: generous, since the assertion already bounds elapsed
  );
});
