# Operational notes

Timeouts, caps, escape hatches, and runtime behavior that power users need to know.

## `preview_custom_manager` caps & timeouts

**Walk vs match caps (two separate budgets).** `preview_custom_manager` exposes two safety caps so the warning text can name which one tripped:

- `maxFilesWalked` (default 2000) — bounds the directory walk before any `fileMatch` testing.
- `maxFilesMatched` (default 500) — bounds the result set after `fileMatch` is applied.

Previously a single `maxFilesScanned` conflated the two, leaving the user unable to tell whether to narrow `fileMatch` or widen the walk.

**File size cap.** `maxFileBytes` (default 5 MiB) — each matched file is `stat`'d before reading; anything larger is skipped with a warning. A stray lockfile, generated artifact, or SQL dump caught by a loose `fileMatch` can't OOM the server.

**Per-file output cap.** `maxHitsPerFile` bounds output size separately from input size.

**Regex / JSONata timeout.** `matchTimeoutMs` (default 2 s) — every user-supplied regex and every JSONata expression runs inside a `worker_threads` worker with this wall-clock budget. Pathological patterns (catastrophic backtracking like `^(a+)+b$` against `aaaa…c`, or runaway JSONata) would otherwise pin the MCP server's event loop indefinitely. On timeout the worker is terminated and a warning is appended identifying which `fileMatch[i]` or `matchStrings[i]` was aborted, so the user can simplify the pattern or raise the budget.

**`.gitignore` honoring.** The walk honors `.gitignore` (including nested `.gitignore`s and `.git/info/exclude`), so generated/vendored directories like `dist/`, `.next/`, `target/`, `__pycache__/` don't crowd out real hits against the `maxFilesWalked` cap. `node_modules/` and `.git/` are always skipped as a safety net even when no `.gitignore` is present.

## `check_setup` bundled-binary fast path

Each Renovate CLI binary is `node node_modules/renovate/dist/<cli>.js`, and a cold `--version` spawn loads Renovate's full ESM graph (~2 s per binary). Two of those at every MCP session start used to dominate cold-start latency and could blow past clients' `initialize` timeout.

When the binary resolves via the bundled path (the default install), `check_setup` reads the version directly from `node_modules/renovate/package.json` — no spawn — bringing the probe to a few milliseconds. The `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` env overrides keep the spawn-based check (a user pointing those at a custom binary wants real proof of life).

**Side effect:** runtime warnings derived from `--version` stderr (e.g. RE2 dlopen failure) no longer appear in the startup banner for the bundled path; they still fire on the first actual tool call, so users see the warning on first use rather than at session start.

## RE2 runtime degradation

`check_setup` and the shell-out tools (`validate_config`, `write_config`, `dry_run`) detect when Renovate's bundled `re2` native module fails to load — typically after a Node major-version upgrade leaves a prebuilt `re2.node` compiled against the old ABI.

When the WARN appears in Renovate's stderr, the tool response carries a `warnings: [{ kind: "re2-unusable", … }]` entry alongside its normal output, and `check_setup` aggregates the same warning into `SetupStatus.warnings` plus the startup `instructions` banner. Renovate keeps running on JavaScript `RegExp` so calls don't fail, but regex-heavy operations (custom managers, validation, lookups) are noticeably slower.

The fix hint is to reinstall renovate-mcp (which reinstalls the bundled `renovate` and rebuilds its native deps), or run `npm rebuild re2` inside the renovate-mcp install's `node_modules/renovate`. This is passive detection only — the server doesn't rebuild anything itself.

## `dry_run` — `ok` semantics and benign-noise filtering

`dry_run` returns a top-level `ok` boolean that is `false` whenever the CLI exited non-zero OR the structured report contains a validation/error-level problem (`level >= 40`, `message === "config-validation"`, or a non-empty `validationError` field). Renovate frequently writes exit-code 0 alongside report-level failures — trusting the exit code alone hides runs that did nothing.

Two specific kinds of in-report problems are **filtered out** of `reportErrors` because they describe benign degradation rather than a failed run:

1. **The bundled RE2 native module failing to load** — Renovate falls back to JS `RegExp` and keeps running. Still surfaced under `warnings`.
2. **Renovate's own `Unsupported node environment` notice** — the run still produces a usable report. Surfaced under a separate `environmentWarnings[]` array.

For the nodeEnv case, `ok` also stays `true` even when Renovate exits non-zero, because the report is intact.

## `dry_run` — local-mode preflight

`dry_run` defaults to `--platform=local` so no host token is required, but that mode can't resolve `local>` presets (they have no platform context to expand against) and silently hides non-default-host GitHub/GitLab setups.

As a guard against the silent-failure mode, `dry_run` preflight-checks the repo's config: if it extends any `local>…` preset while the effective platform is `local`, the tool fails fast with specific remediation rather than spawning a Renovate run that would opaquely report `config-validation`. The preflight is skipped for `dryRunMode=extract` so manifest-only extraction can still be attempted.

## Platform-source precedence is visible to callers

Resolution is `platform` input → `RENOVATE_PLATFORM` env → `local`, and the response echoes which step won via `platformSource: "input" | "env" | "default"` and `effectivePlatform`. Both preflight error messages (missing `repository`, missing token for a remote platform) carry an origin tag so a surprising `gitlab` value can be traced without reading source.

When `platform` is unset and the env fallback yields a non-local platform, an advisory entry is appended to `warnings` reminding the caller they can pass `platform: 'local'` to override.

## Large-report escape hatch

MCP harnesses truncate tool responses at modest sizes (≈75 KB on Claude Desktop), and a real Renovate report easily exceeds that.

`dry_run` accepts:

- `reportOutputPath` (absolute path; mode-0600 write of the full report) which collapses `summary.report` to `{ reportPath, repoCount, updateCount }`.
- `summaryOnly: true` for further inline trimming.

`dry_run_diff` accepts each input as either an inline report or `{ reportPath: … }`, so the iterative workflow becomes:

```
dry_run({ reportOutputPath: "/tmp/before.json" })
# tweak config
dry_run({ reportOutputPath: "/tmp/after.json" })
dry_run_diff({ before: { reportPath: "/tmp/before.json" }, after: { reportPath: "/tmp/after.json" } })
```

`warnings` / `problems` / `reportErrors` / `environmentWarnings` always stay inline — those are the actionable bits.

## Progress notifications

`dry_run` emits MCP progress notifications only when the caller's `tools/call` includes `_meta.progressToken` — no-op otherwise, so legacy clients see zero overhead. A 5-second heartbeat ticks while the child runs; each tick's message is best-effort enriched with the latest Renovate JSON-log `msg` seen on stdout. Notifications are also emitted at start and completion. We deliberately don't couple to Renovate's log schema beyond reading `msg`, since that schema isn't a stable API.
