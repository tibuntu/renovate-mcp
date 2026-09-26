import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { runRenovateWorker, WorkerTimeoutError } from "../../src/lib/renovateWorker.js";

const REPLY_WORKER = resolve(process.cwd(), "test/fixtures/reply-worker.mjs");
const EXIT_ONE_WORKER = resolve(process.cwd(), "test/fixtures/exit-one-worker.mjs");
const OPTS = { timeoutMs: 5000, label: "fixture" };

describe("runRenovateWorker", () => {
  it("resolves with the worker's ok reply", async () => {
    const reply = await runRenovateWorker<{ echo: unknown }>(
      REPLY_WORKER,
      { mode: "ok", payload: { a: 1 } },
      OPTS,
    );
    expect(reply.echo).toEqual({ a: 1 });
  });

  it("rejects with the labelled failure message on an error reply", async () => {
    await expect(
      runRenovateWorker(REPLY_WORKER, { mode: "error", error: "boom" }, OPTS),
    ).rejects.toThrow("Renovate fixture failed: boom");
  });

  it("rejects with WorkerTimeoutError carrying timeoutMs when the worker never replies", async () => {
    const err = await runRenovateWorker(REPLY_WORKER, { mode: "hang" }, {
      timeoutMs: 50,
      label: "fixture",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkerTimeoutError);
    expect((err as WorkerTimeoutError).timeoutMs).toBe(50);
    expect((err as Error).message).toContain("fixture worker exceeded 50ms");
  });

  it("rejects promptly when the worker exits before posting a result", async () => {
    // process.exit(1) fires neither 'message' nor 'error'; the driver must not
    // sit on the timeout.
    const t0 = Date.now();
    await expect(runRenovateWorker(EXIT_ONE_WORKER, {}, OPTS)).rejects.toThrow(
      /fixture worker exited \(code 1\)/,
    );
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
