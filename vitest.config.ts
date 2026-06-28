import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // The merge worker's main module (src/lib/mergeWorker.ts) runs as TS
      // source under src/ in vitest, so its import.meta.url-relative sibling
      // .js doesn't exist there. Point it at the compiled worker in dist/
      // (built by the `pretest` script before the suite runs).
      RENOVATE_MCP_MERGE_WORKER_ENTRY: resolve(
        process.cwd(),
        "dist/lib/mergeWorkerImpl.js",
      ),
      // Same reason as the merge worker: the packageRules worker's main module
      // runs as TS source under src/ in vitest, so point its entry at the
      // compiled worker in dist/ (built by the `pretest` script).
      RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY: resolve(
        process.cwd(),
        "dist/lib/packageRulesWorkerImpl.js",
      ),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/data/presets.generated.ts"],
      // Regression floor set just below the v1.0 baseline (stmts 71 / branch 67
      // / funcs 77 / lines 72). Worker entry points (*WorkerImpl.ts) run in a
      // separate thread the main-process v8 instrumentation can't see, so they
      // count as uncovered here despite being exercised by the worker tests —
      // the margins below absorb that.
      thresholds: {
        statements: 68,
        branches: 64,
        functions: 73,
        lines: 68,
      },
    },
  },
});
