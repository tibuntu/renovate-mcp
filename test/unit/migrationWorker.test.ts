import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { runMigration } from "../../src/lib/migrationWorker.js";

describe("runMigration worker error handling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects promptly when the worker exits non-zero without posting a result", async () => {
    // A worker that exits before posting (here a fixture that calls
    // process.exit(1), firing neither 'message' nor 'error') must not hang
    // until the timeout. The old handler swallowed exit code 1 and only threw
    // MigrationTimeoutError after the full budget. Parity with mergeWorker.
    vi.stubEnv(
      "RENOVATE_MCP_MIGRATION_WORKER_ENTRY",
      resolve(process.cwd(), "test/fixtures/exit-one-worker.mjs"),
    );
    await expect(
      runMigration({}, { timeoutMs: 2000 }),
    ).rejects.toThrow(/exited \(code 1\)/);
  });
});
