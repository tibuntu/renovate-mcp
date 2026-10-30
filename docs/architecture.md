# Architecture

The non-obvious design decisions behind `renovate-mcp`.

## Shell out, don't import

`validate_config`, `dry_run`, and `write_config` shell out to the Renovate CLI rather than importing Renovate as a library. This decouples our Node version from Renovate's (currently Node 24) and keeps the main MCP server process free of Renovate's internal API surface.

The `renovate` package is bundled as a runtime dependency so users don't need a separate `npm i -g renovate`. We still spawn the binary as a child process (via `node node_modules/renovate/dist/renovate.js`) — the main process **never** `import "renovate"`. Resolution order is `RENOVATE_BIN` env override → bundled JS entry resolved via `require.resolve("renovate/package.json")` → bare tool name on `PATH`. The env override is the supported escape hatch when a user wants a different Renovate version.

`read_config`, `suggest_presets`, `resolve_config`, `explain_config`, `resolve_config_diff`, `test_package_rules`, `preview_custom_manager`, `lint_config`, `dry_run_diff`, `annotate_dry_run`, `explain_dependency`, `explain_schedule`, and `migrate_config` never invoke the Renovate **CLI**, so they don't need a configured Renovate binary. `preview_custom_manager`, `lint_config`, and `suggest_presets` are fully in-process; so is `explain_dependency`'s report walk (`src/lib/dependencyExplainer.ts`), which only reaches for the packageRules worker when a config source is supplied. `resolve_config` / `explain_config` expand presets in-process but fold them with Renovate's real `mergeChildConfig` in a worker thread; `test_package_rules` / `annotate_dry_run` / `explain_dependency` evaluate Renovate's real `packageRules` matchers in a worker thread, and `explain_schedule` probes Renovate's real schedule matcher in another (the `renovate` npm package is a bundled runtime dependency; if a worker can't load it the merge and packageRules tools fall back to an approximate in-process result, while `explain_schedule` returns an error). The main process itself never imports `renovate`.

## Worker isolation for migration

`migrate_config` was the first tool to call into Renovate as a library (the config-merge worker below is the second) — Renovate ships no `renovate-config-migrate` CLI, only a library export. To keep the main MCP server process decoupled from Renovate's internal API surface (and to avoid the ~20-30 MB resident cost of `getOptions()` eagerly loading the manager registry), the tool spawns a `node:worker_threads` worker on demand that imports `renovate/dist/config/migration.js` **inside the worker**. The main process never imports `renovate`.

First call carries a one-time cold-load latency (a few seconds) for the worker's ESM graph; the worker is terminated after each call. The spawn / first-message / 30 s timeout (`WorkerTimeoutError`) / terminate cycle is shared by all four carve-outs through `src/lib/renovateWorker.ts` (`runRenovateWorker`); each `*Worker.ts` wrapper only names its `*WorkerImpl.js` entry and shapes the reply.

## Worker isolation for config merge

`resolve_config` and `explain_config` fold expanded presets with Renovate's real `mergeChildConfig` (`renovate/dist/config/utils.js`) — the same library-with-no-CLI shape as migration, so the merge runs in a `node:worker_threads` worker (`src/lib/mergeWorker.ts` + `src/lib/mergeWorkerImpl.ts`). The main process flattens preset expansion offline into an ordered list of step configs (`collectMergeSteps` in `presetResolver.ts`, shared by both tools), ships them to the worker, and gets the merged result back in one round-trip. `explain_config` additionally requests cumulative per-step snapshots and reconstructs per-field provenance by diffing them — so it never maintains a parallel merge and can't drift from `resolve_config`. Configs that merge fewer than two sources skip the worker entirely; the first multi-source merge pays the same `getOptions()` cold start as migration. On worker failure or a 30 s timeout, both tools fall back to an in-process approximate merge and report `mergeQuality: "preview"`.

## JSONata worker isolation

The same worker pattern protects `preview_custom_manager`'s JSONata path. The `jsonata` package is `require()`'d **only** inside the worker source string; the main MCP process never loads `jsonata` and never carries the JSONata parser in its heap (it does resolve the package's absolute path via `createRequire(import.meta.url).resolve("jsonata")` to hand the worker a path — locating the file is not loading the module). The same `matchTimeoutMs` budget (default 2 s) and `worker.terminate()` safety posture applies to both regex and JSONata evaluation.

## Worker isolation for packageRules

`test_package_rules` and `annotate_dry_run` evaluate Renovate's real `packageRules` matchers — the third library-with-no-CLI carve-out (ADR-0006), after migration and config merge. `src/lib/packageRulesWorker.ts` + `src/lib/packageRulesWorkerImpl.ts` import Renovate's matcher registry (`renovate/dist/util/package-rules/matchers.js`) plus `mergeChildConfig` and `compile` **inside the worker**, and **replicate `applyPackageRules`' loop** rather than calling it as a black box — because Renovate's `matchesRule` returns only a boolean and exposes no per-rule / per-matcher provenance, which is exactly what these tools surface. Replicating the loop also reproduces Renovate's exact merge (override\* mutation mid-loop + `mergeChildConfig`), so the worker's merged config is bit-identical to `applyPackageRules` for matchConfidence-free configs — pinned by a parity-oracle test, with a matcher-registry drift sentinel guarding the 19-matcher array. All contexts (one per dependency / report update) are evaluated in a single worker round-trip; on worker failure or a 30 s timeout the tools fall back to an approximate in-process glob-only matcher and report `matchQuality: "preview"`. The main process never imports `renovate`.

The same worker also renders `test_package_rules`' `rendered` block (branch / commit / PR names — ADR-0006 addendum). When the caller passes `renderBase` (the resolved top-level config), the worker lazily imports Renovate's real `generateBranchName` (`dist/workers/repository/updates/branch-name.js`), its option defaults (`dist/config/defaults.js`), the versioning registry and `CommitMessage`, layers each context's merged config over defaults ← top-level config, and mirrors the ~30-line single-update path of `generateBranchConfig` (`compileCommitMessage` / `compilePrTitle`) using the already-imported `compile`. `generateBranchConfig` itself is deliberately **not** imported: its side-effect import of `config/index.js` loads every manager and datasource (measured +5–11 s cold), whereas the leaf modules cost nothing measurable. A parity-oracle test pins the mirror against the real `generateBranchConfig` for fully specified updates. `annotate_dry_run` / `explain_dependency` never pass `renderBase`, so they never load these modules.

`jsonata` is pinned to exactly `2.2.1` matching Renovate's own pin — bumped only when Renovate's pin bumps, to keep the parity-test oracle stable.

## Worker isolation for schedules

`explain_schedule` is the fourth library-with-no-CLI carve-out (ADR-0007). `src/lib/scheduleWorker.ts` + `src/lib/scheduleWorkerImpl.ts` import Renovate's real schedule validators and matcher — `hasValidSchedule`, `hasValidTimezone`, `cronMatches` from `renovate/dist/workers/repository/update/branch/schedule.js` — **inside the worker**, together with `@breejs/later`, `luxon` and `croner` resolved relative to that module (so the worker evaluates with exactly the copies Renovate would, without new direct dependencies). Renovate's `isScheduledNow` reads `DateTime.local()` and cannot be asked "would this match at time T?", so the worker **replicates its per-entry check** (cron → `cronMatches`; text → `scheduleMappings` + `fixShortHours` + `later.schedule(...).isValid(...)` on the zone-local wall time) with an injectable instant, and probes every local hour over a 366-day horizon, grouping hits into windows. Renovate forbids minutes in both schedule forms, so hourly probes are exact. A parity-oracle test pins the replication against `isScheduledNow` with a pinned clock at every reported window edge. One round-trip per call; on worker failure or the 30 s timeout the tool returns `isError` — there is no approximate fallback, because nothing outside the worker can evaluate a later-text schedule. The main process never imports `renovate`.

## Round-trip writer

`write_config` performs a surgical round-trip edit when the target file already exists and parses as JSON-with-comments. Comments, key order, trailing commas, blank-line groupings, and any unrelated trivia are preserved — only the keys the caller actually changed are rewritten.

Brand-new file writes (no prior file at the target path) fall back to plain `JSON.stringify(config, null, 2) + "\n"` — byte-identical to pre-round-trip behavior.

For `package.json` the edit is rooted at the `renovate` key instead of the document root, so the rest of the manifest is never diffed or rewritten — not even under `force: true`. Validation runs on the Renovate slice alone, written to its own temp file.

## Preset catalogue

`resolve_config` expands `extends` against a committed snapshot of Renovate's built-in presets at `src/data/presets.generated.ts`. Five generated snapshot files exist:

- `src/data/presets.generated.ts` — built-in preset catalogue
- `src/data/managers.generated.ts` — valid manager-name list for `lint_config`'s `matchManagers-unknown-name` rule, and for the `renovate://managers` resource
- `src/data/migrations.generated.ts` — deprecated-key rename map for `lint_config`'s `deprecated-key` rule
- `src/data/options.generated.ts` — config option definitions (name, type, default, `allowedValues`, `globalOnly`, etc.) for the `renovate://options` / `renovate://option/{name}` resources
- `src/data/datasources.generated.ts` — valid datasource ids for `lint_config`'s `matchDatasources-unknown-name` rule, and for the `renovate://datasources` resource

All five are generated by build-time scripts under `scripts/` that import the `renovate` package. They are plain data — no runtime coupling. Regenerate after a `renovate` dependency bump with `npm run generate:presets` / `generate:managers` / `generate:migrations` / `generate:options` / `generate:datasources`. CI's `check:snapshot-versions` step compares the `RENOVATE_VERSION` embedded in each generated file against `node_modules/renovate/package.json#version` and fails fast naming the stale file(s).

Build-time imports of `renovate` are limited to these five scripts. The main process never imports the package at runtime; the only runtime imports of `renovate` itself live inside worker threads (migration, config merge, packageRules matching, and schedule evaluation). The JSONata worker is a separate case: it `require()`s the `jsonata` npm package, never `renovate` — see [JSONata worker isolation](#jsonata-worker-isolation), above.

## External preset fetching

External `github>` / `gitlab>` / `gitea>` / `forgejo>` preset fetching — plus Bitbucket Cloud through `local>` + `platform: "bitbucket"`, since Renovate has no `bitbucket>` prefix — is opt-in (`externalPresets: true`), uses each platform's raw-contents API with a 10 s timeout, and caches results per call. The fetcher is intentionally a narrow, direct HTTP client — not routed through the Renovate CLI. Auth, redirect handling, and body caps are documented in [Security & secrets](security.md).

## Integration testing — real spawn, fake binaries

Integration tests spawn the built `dist/index.js` as a real child process and speak JSON-RPC over stdio, so the tests exercise the actual MCP handshake and tool registration. For code that shells out to Renovate, the tests generate executable Node scripts at runtime and point `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` at them. The whole point is that the real spawn path is tested — we don't `vi.mock` `child_process`.

Per-PR CI installs the pinned Renovate via `npm ci` (it's a runtime dep), but the integration tests still point at fake binaries for determinism. The real Renovate CLI is exercised end-to-end by a separate nightly workflow that installs `renovate@latest` on top of `npm ci` and re-runs the full suite, catching upstream drift before a dependency bump.

## MCP SDK conventions

The server uses the `registerTool(name, config, handler)`, `registerResource(name, uriOrTemplate, metadata, handler)`, and `registerPrompt(name, config, handler)` forms (current 1.x API with structured config objects). Input schemas are zod raw shapes (plain object with zod types as values — not `z.object(...)`).

Tools live under `src/tools/`, resources under `src/resources/`, and prompts under `src/prompts/` — each a `register<Name>(server)` function wired into the single `McpServer` instance in `src/index.ts`. `src/prompts/workflows.ts` packages the documented multi-tool workflows (config design, packageRules debugging, custom-manager authoring, repo onboarding) into four prompts that Claude Code surfaces as slash commands; each returns a single user-role text message rather than calling into any tool logic itself — it only tells the model which tools to call and in what order.

Every tool passes MCP `annotations` in its `registerTool` config; the shared offline / network read-only sets are `OFFLINE_READ_ONLY_ANNOTATIONS` and `NETWORK_READ_ONLY_ANNOTATIONS` in `src/lib/toolInputs.ts`, and `write_config` inlines the one destructive set.
