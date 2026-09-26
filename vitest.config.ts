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
      // Excluded because these paths are only exercised out-of-process and
      // the main-process v8 instrumentation can't see them, so they'd only
      // add noise to the number:
      //  - src/index.ts: the stdio entrypoint, exercised via the built
      //    dist/index.js child process in test/integration (mcpSession.ts),
      //    never imported in-process.
      //  - src/tools/**, src/prompts/**, src/resources/**: registered against
      //    a live McpServer and invoked over the stdio JSON-RPC transport in
      //    integration tests, not called directly from unit tests.
      //  - src/lib/*WorkerImpl.ts: run inside worker_threads workers (see
      //    CLAUDE.md's worker-isolation carve-outs), invisible to the
      //    parent process's coverage instrumentation despite being exercised
      //    by the worker tests.
      //  - src/data/**: committed, generated snapshot data with no logic of
      //    its own.
      exclude: [
        "src/index.ts",
        "src/tools/**",
        "src/prompts/**",
        "src/resources/**",
        "src/lib/*WorkerImpl.ts",
        "src/data/**",
      ],
      // Regression floor set 5 points below the measured numbers after the
      // exclusions above (measured: stmts 92.41 / branch 87.41 / funcs 94.76
      // / lines 94.16 — see the coverage report's "All files" row).
      thresholds: {
        statements: 87,
        branches: 82,
        functions: 89,
        lines: 89,
      },
    },
  },
});
