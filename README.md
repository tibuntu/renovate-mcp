# renovate-mcp

[![npm](https://img.shields.io/npm/v/renovate-mcp.svg)](https://www.npmjs.com/package/renovate-mcp)
[![CI](https://github.com/tibuntu/renovate-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tibuntu/renovate-mcp/actions/workflows/ci.yml)
[![Node ≥ 24](https://img.shields.io/node/v/renovate-mcp.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An MCP server for designing [Renovate](https://github.com/renovatebot/renovate) configurations interactively. Point it at a local repo and let an LLM help you read, validate, preview, and save `renovate.json`.

## Contents

- [What it does](#what-it-does)
- [What this is NOT](#what-this-is-not)
- [Requirements](#requirements)
- [Install](#install)
- [Platform setup](#platform-setup)
- [Example prompts](#example-prompts)
- [Example session](#example-session)
- [Development](#development)
- [Release flow](#release-flow)
- [Design notes](#design-notes)

## What it does

Eleven tools plus a preset reference:

| Tool | Purpose |
| --- | --- |
| `check_setup` | Report Renovate CLI + validator availability, versions, and install hints. Also surfaces a `platformContext` block (`RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` values, token-presence booleans, the platform `dry_run` would pick when its input is unset, and notes about likely misconfigurations) so callers can verify env before invoking `dry_run`. Token values are never echoed — only presence booleans. Also runs at startup. |
| `get_version` | Report the renovate-mcp server version and whether it's a released build (running from `node_modules`) or a local/dev build (typically launched via `command: node` against a checkout). |
| `read_config` | Locate and parse a repo's Renovate config (`renovate.json`, `renovate.json5`, `.renovaterc*`, `package.json#renovate`, …) in priority order. |
| `resolve_config` | Expand every `extends` preset offline. Opt in to fetching `github>` / `gitlab>` presets over HTTPS with `externalPresets: true`. |
| `explain_config` | Inverse of `resolve_config`: walk the same preset tree but annotate every leaf field with the chain of presets that touched it. Each leaf is `{ value, setBy }` where `setBy` lists every contribution in merge order — last entry wins for scalars; for arrays each entry adds its own slice. Same offline-by-default behaviour and same `externalPresets` / `endpoint` / `platform` opt-ins as `resolve_config`. |
| `preview_custom_manager` | Preview a `customManagers` (regex) entry against a local repo — shows file/line hits and extracted dep info. Offline. |
| `validate_config` | Run `renovate-config-validator` against a file or inline object. |
| `lint_config` | Semantic lint for Renovate-specific footguns schema validation misses — malformed `/…/` regex patterns plus unknown manager names in `matchManagers` / `excludeManagers`. Offline. |
| `dry_run` | Run Renovate with `--dry-run` and return the structured JSON report. Defaults to `--platform=local` against `repoPath`; pass `platform` + `endpoint` + `token` + `repository` to run as a real GitHub/GitLab client (needed when the config extends `local>` presets on a private host). When `platform` is not passed, the tool reads `RENOVATE_PLATFORM` from the MCP server's env before defaulting to `local`. When `token` is not passed, falls back to `RENOVATE_TOKEN` from MCP env, then to `GITLAB_TOKEN` (when `platform=gitlab`) or `GITHUB_TOKEN` (when `platform=github`) — auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI, since Renovate itself only reads that one var. `repository` accepts GitHub-style `owner/repo` and GitLab nested-group paths like `group/subgroup/project`. `endpoint`/`token` also flow through in local mode so `gitlab>…` / `github>…` preset shortcuts can be redirected at a self-hosted host without setting up a full remote run. No PRs, no pushes. Emits MCP progress notifications during the run when the caller supplies a `progressToken`. |
| `dry_run_diff` | Semantic diff between two `dry_run` reports — `added` / `removed` / `changed` proposed updates plus a compact text rendering. Stateless; takes both reports as inputs. Useful when iterating on a config to see exactly what each tweak did. |
| `write_config` | Validate, then atomically write a config to disk. Refuses to save invalid configs unless `force: true`. |
| `renovate://presets` (resource) | Markdown index of all 1000+ built-in presets grouped by namespace. |
| `renovate://presets/{namespace}` (resource template) | Markdown listing for a single namespace (e.g. `renovate://presets/config`) — cheaper than the full index. |
| `renovate://preset/{name}` (resource template) | Expanded JSON body for one preset (e.g. `renovate://preset/config:recommended`). |

See [Design notes](#design-notes) for implementation details (timeouts, safety caps, auth scrubbing, merge semantics).

## What this is NOT

- **Not a Renovate replacement.** This server doesn't open PRs, run scheduled updates, or execute in CI — it's a design-time companion for a local `renovate.json`. Use the real Renovate for the actual dependency-update pipeline.
- **`resolve_config` is preview-quality.** Preset expansion runs against a committed snapshot, and template substitution implements only positional `{{argN}}` placeholders — non-positional tokens and Handlebars helpers are flagged in `warnings` and pass through verbatim. For authoritative output, run `dry_run`.
- **`preview_custom_manager` is a subset of Renovate's regex manager.** It covers `customType: "regex"`, `matchStringsStrategy` of `any` / `combination` / `recursive`, and `{{groupName}}` template substitution only — other custom types and full Handlebars (helpers, conditionals) are not implemented. Use it for fast regex iteration; confirm with `dry_run`.
- **`validate_config` / `dry_run` aren't exercised in CI.** CI deliberately doesn't install Renovate, so tools that shell out to it are only covered by unit/integration tests that don't require the binary. Run them locally against the Renovate install you intend to deploy with.

## Requirements

**Required**

- Node.js ≥ 24 (aligns with Renovate's own engine requirement).
- Renovate on your `PATH` — either a global install (`npm i -g renovate`) or a project-local install that exposes `renovate` + `renovate-config-validator` via `npm exec`. Only needed for `validate_config`, `dry_run`, and `write_config`; the offline tools (`read_config`, `resolve_config`, `preview_custom_manager`, `lint_config`) work without it.

**Optional**

- `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` — override binary locations.
- `RENOVATE_MCP_REQUIRE_CLI=false` — suppress the startup "partial availability" notice when you only intend to use the offline tools.
- Platform env vars — `RENOVATE_PLATFORM`, `RENOVATE_ENDPOINT`, and a token (`RENOVATE_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN`). Needed for `dry_run` against a remote platform and for `resolve_config` with `externalPresets: true`. See [Platform setup](#platform-setup) for the matrix and a worked example.
- Private-registry credentials for `dry_run` — whatever Renovate itself would need at lookup time (`COMPOSER_AUTH`, `NPM_TOKEN` / `.npmrc`, Docker registry creds, or a `RENOVATE_HOST_RULES` JSON blob). Alternatively encode these as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on `dry_run` (no MCP restart needed). Per-call `hostRules` are appended to whatever the repo's own config declares. Values reach Renovate as JSON through the tool-call transport, so the calling LLM sees them in its context — prefer the env route if that matters. Without any of these, Renovate's lookup often returns 0 updates silently; `dry_run` scans its logs for auth failures and surfaces them under `problems`.

> **Note:** all env vars (tokens, `COMPOSER_AUTH`, `RENOVATE_HOST_RULES`, binary overrides, …) must be set on the MCP server process itself — via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell — since the MCP server runs as a child of the client and does not inherit shell env.

## Install

`npx` fetches the [published package](https://www.npmjs.com/package/renovate-mcp) on demand — no manual install needed. For local development, clone and build first:

```bash
npm install
npm run build
```

Add the following `mcpServers` entry to your client's config file:

```json
{
  "mcpServers": {
    "renovate": {
      "command": "npx",
      "args": ["-y", "renovate-mcp"]
    }
  }
}
```

For local development, swap to `"command": "node"` with `"args": ["/absolute/path/to/renovate-mcp/dist/index.js"]`.

### Claude Code

Config lives in `.mcp.json` (project-scoped) or `~/.claude.json` (user-scoped).

### Claude Desktop

Config lives in `~/Library/Application Support/Claude/claude_desktop_config.json`.

### Other MCP clients

Any client that can launch a stdio MCP server works — point it at the same command shown above.

### Verify the wiring

Restart your client and prompt it:

> List the namespaces available under `renovate://presets`.

A response listing namespaces like `config`, `docker`, `npm`, `helpers`, … confirms the server is reachable and the resource is exposed. If the client reports the tool or resource as unavailable, re-check the config file path and command.

## Platform setup

The four common configurations differ in three settings: `RENOVATE_PLATFORM`, `RENOVATE_ENDPOINT`, and which token env var you set. Pick the row that matches your environment and put the values in your client's `mcpServers.renovate.env` block.

| Setup | `RENOVATE_PLATFORM` | `RENOVATE_ENDPOINT` | Token env var |
| --- | --- | --- | --- |
| github.com | `github` | (omit — defaults to `https://api.github.com`) | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| GitHub Enterprise | `github` | `https://github.example.com/api/v3/` | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| gitlab.com | `gitlab` | (omit — defaults to `https://gitlab.com/api/v4`) | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |
| Self-hosted GitLab | `gitlab` | `https://gitlab.example.com/api/v4/` | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |

Notes that apply to every row:

- All env vars must be on the MCP server process — set them via the `env` key in `.mcp.json` / `claude_desktop_config.json`, not your shell, since the MCP server runs as a child of the client and does not inherit shell env.
- `RENOVATE_TOKEN` wins when both it and the platform-specific var are set. `dry_run` and `resolve_config` honour the same precedence; for `dry_run` the platform-specific var is auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI (Renovate itself only reads that one var).
- For repository identifiers, GitLab accepts nested-group paths like `group/subgroup/project`, not just `group/project`.
- If you only intend to use the offline tools (`read_config`, `resolve_config` without `externalPresets`, `preview_custom_manager`, `lint_config`), you can skip all of the above.

### Worked example — self-hosted GitLab

```jsonc
{
  "mcpServers": {
    "renovate": {
      "command": "npx",
      "args": ["-y", "renovate-mcp"],
      "env": {
        "RENOVATE_PLATFORM": "gitlab",
        "RENOVATE_ENDPOINT": "https://gitlab.example.com/api/v4/",
        "GITLAB_TOKEN": "<your token>"
      }
    }
  }
}
```

This is enough for both `dry_run` (remote-platform runs) and `resolve_config` (private preset fetches). With this set, `dry_run` against `group/subgroup/project` works without passing `platform` / `endpoint` / `token` per call: `RENOVATE_PLATFORM` and the auto-translated `GITLAB_TOKEN` cover the platform side, and `RENOVATE_ENDPOINT` is inherited naturally by the spawned Renovate CLI. For `resolve_config`, `platform` and `endpoint` are tool *inputs* (not env vars) — pass them when you need `local>` presets routed through your host, since `resolve_config` is in-process and doesn't read `RENOVATE_*` env vars itself.

### `local>` presets

A config that extends `local>owner/repo:preset` only resolves when there's a platform context to expand it against:

- **For `dry_run`** — pass `platform` + `endpoint` + `repository` (token falls back to env). Use `dryRunMode=extract` if you only need manifest extraction; the preset preflight is skipped in that mode.
- **For `resolve_config`** — pass `platform` + `endpoint` as inputs and the tool rewrites `local>` into `<platform>>` and fetches over HTTPS. Without these inputs, `local>` stays in `presetsUnresolved` with a pointer to the workaround. Run `dry_run` afterwards for full-fidelity merging.

## Example prompts

Once the server is wired up, try prompts like these. They're written for Claude but work with any MCP-capable client.

**Understanding an existing config**

- "Read the Renovate config in this repo and summarize what it actually does — expand every preset so I can see the real effective behavior."
- "Resolve my config and list anything that landed in `presetsUnresolved`, with the reason for each."
- "Why is my `prCreation` set to `not-pending`? Use `explain_config` to trace which preset set it."

**Browsing presets**

- "List the presets in the `config` namespace." (uses the `renovate://presets/config` sub-resource — cheaper than pulling the whole index)
- "What does `config:recommended` actually enable? Show me its expanded JSON."
- "Find a built-in preset that pins GitHub Actions digests."

**Self-hosted GitLab / GitHub Enterprise** (env set per [Platform setup](#platform-setup))

- "Resolve my config with external presets enabled, fetching `gitlab>platform/renovate-presets` from our self-hosted GitLab at `https://gitlab.example.com/api/v4`. Route `local>` presets through the same host."
- "Expand `github>acme/renovate-config//base` from our GitHub Enterprise at `https://github.acme.corp/api/v3`."
- "Dry-run `infrastructure/kubernetes/our-platform` (a nested-group GitLab project) so Renovate can fetch the `local>` presets the config extends."

**Authoring a custom manager (regex)**

- "I have `# renovate: datasource=docker depName=...` comments above image tags in my Dockerfiles. Draft a `customManagers` regex entry and preview it against this repo so I can see what it extracts."
- "Here's a `customManagers` entry — preview it and tell me which files match, which lines hit each `matchStrings` regex, and what dep info gets extracted."

**Validating, previewing, saving**

- "Validate this proposed config against Renovate's schema without writing it anywhere."
- "Do a dry run and show me which PRs Renovate would open — no pushes."
- "Add `:semanticCommits` to my `extends`, validate it, and save back to `renovate.json`."

## Example session

A transcript-style walkthrough: design a Dockerfile custom manager from scratch, validate it, dry-run, and save. Turns are abbreviated — your client will show the actual tool-call JSON.

> **You:** I've got `# renovate: datasource=docker depName=<image>` comments above `FROM` lines in my Dockerfiles. Draft a `customManagers` entry and preview it against this repo.
>
> **Claude** calls `preview_custom_manager` with a first-draft `fileMatch` + `matchStrings`.
> → 4 Dockerfiles matched `fileMatch`, 0 lines matched `matchStrings`. The regex anchored on `ARG`, but the Dockerfiles use `FROM`.
>
> **You:** Rewrite `matchStrings` to anchor on the renovate comment, then `FROM <image>:<version>` on the next line.
>
> **Claude** calls `preview_custom_manager` again with the fixed regex.
> → 4 files, 4 line hits. Extracted: `postgres:15.3-alpine`, `redis:7.2`, `nginx:1.25`, `node:20.11`. Named groups `depName` and `currentValue` populated on every hit.
>
> **You:** Good. Validate the full config inline, with this `customManagers` entry alongside my existing `extends`.
>
> **Claude** calls `validate_config` with the inline config. → valid.
>
> **You:** Now dry-run so I can see what Renovate would actually open.
>
> **Claude** calls `dry_run`. → 2 updates: `postgres` 15.3-alpine → 15.5-alpine, `redis` 7.2 → 7.4. No entries in `problems`.
>
> **You:** Save it.
>
> **Claude** calls `write_config` on `renovate.json`. → validated, written atomically.

## Development

```bash
npm run dev              # build watch mode
npm run typecheck        # tsc --noEmit
npm run build            # compile to dist/
npm start                # run the built server over stdio
npm test                 # vitest run (builds first)
npm run test:watch       # vitest watch mode
npm run test:coverage    # vitest run --coverage (writes coverage/ report)
npm run generate:presets # regenerate src/data/presets.generated.ts from the renovate devDep
npm run generate:managers # regenerate src/data/managers.generated.ts from the renovate devDep
```

The preset catalogue at `src/data/presets.generated.ts` and the manager-name list at `src/data/managers.generated.ts` are committed snapshots of Renovate's built-in presets and manager registry. Runtime code never imports the `renovate` package — only the `scripts/generate-*.mjs` scripts do. Regenerate both after bumping the `renovate` devDependency.

CI runs `typecheck`, `build`, and `test:coverage` on Node 24 for every PR and push to `main` (see `.github/workflows/ci.yml`). Coverage is uploaded as a per-run artifact; no threshold is enforced yet.

`.github/workflows/claude.yml` is maintainer tooling: it lets the repo owner trigger [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) by mentioning `@claude` in an issue, issue comment, PR review, or PR review comment. It's gated on `sender.login == repository_owner`, so mentions from anyone else are ignored. The workflow needs the `CLAUDE_CODE_OAUTH_TOKEN` secret on the repo; outside contributors and forks do not need any Anthropic credentials to work on this project.

## Release flow

Releases are automated via [release-please](https://github.com/googleapis/release-please) (see `.github/workflows/release.yaml`):

1. Merge Conventional Commits to `main` (`feat:`, `fix:`, etc.)
2. release-please opens or updates a release PR that bumps the version and updates `CHANGELOG.md`
3. Merging the release PR creates a GitHub release and tag
4. The `publish` workflow (`.github/workflows/publish.yml`) fires on the release event, runs the test suite, and runs `npm publish` with provenance

Publishing uses [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers) — no npm token is stored in the repo. Instead the workflow authenticates to npm via OIDC using the `id-token: write` permission. Trusted Publishers must be configured on the npm package settings page before OIDC publishes will succeed; this requires the package to already exist, so the **first release must be published manually once** (`npm login && npm publish` from a clean build), after which Trusted Publishers can be wired up and all subsequent releases go through this workflow.

Secrets required on the repo: `RELEASE_PLEASE_TOKEN` (a PAT for release-please). No npm token is needed.

## Design notes

Scope and non-goals are summarized in [What this is NOT](#what-this-is-not); this section covers implementation decisions behind the scope that *is* supported.

- `validate_config`, `dry_run`, and `write_config` shell out to the Renovate CLI rather than importing Renovate as a library — this decouples our Node version from Renovate's (currently Node 24).
- `resolve_config`, `preview_custom_manager`, and `lint_config` are fully in-process and never invoke the Renovate CLI, so they work without a Renovate install.
- `lint_config` is a semantic lint pass that sits alongside `validate_config` rather than replacing it: schema validation catches structural bugs, the linter catches Renovate-specific footguns that schema validation declares valid — most commonly a pattern like `"matchPackageNames": ["/devops\\/pipelines\\/.+"]` where a trailing `/` is missing and Renovate silently degrades the value to an exact-string match that never hits, or a typo like `"matchManagers": ["npmm"]` that silently applies the rule to zero packages. The ruleset is intentionally small (three rules: `dead-regex-missing-slash`, `unwrapped-regex`, `matchManagers-unknown-name`), scoped to the four regex-aware fields plus `matchManagers` / `excludeManagers`, and tuned to avoid false positives on benign exact strings containing a `.`. The valid-manager list is snapshotted from the `renovate` devDep at `src/data/managers.generated.ts` (regenerate with `npm run generate:managers`), and unknown names get a Damerau-Levenshtein "did you mean?" suggestion when something close enough exists. Rule IDs are stable so findings can be suppressed by callers.
- `preview_custom_manager` honors `.gitignore` (including nested `.gitignore`s and `.git/info/exclude`) when walking the repo, so generated/vendored directories like `dist/`, `.next/`, `target/`, `__pycache__/` don't crowd out real hits against the `maxFilesWalked` cap. `node_modules/` and `.git/` are always skipped as a safety net even when no `.gitignore` is present.
- `preview_custom_manager` exposes two separate safety caps so the warning text can name which one tripped: `maxFilesWalked` (default 2000) bounds the directory walk before any `fileMatch` testing, and `maxFilesMatched` (default 500) bounds the result set after `fileMatch` is applied. Previously a single `maxFilesScanned` conflated the two, leaving the user unable to tell whether to narrow `fileMatch` or widen the walk.
- `preview_custom_manager` runs every user-supplied regex on a `worker_threads` worker with a wall-clock budget per operation (default 2 s, configurable via `matchTimeoutMs`). Catastrophic backtracking — e.g. `^(a+)+b$` against `aaaa…c`, or `(.*)*=` against a modestly sized file — would otherwise pin the MCP server's event loop indefinitely. On timeout the worker is terminated and a warning is appended identifying which `fileMatch[i]` or `matchStrings[i]` was aborted, so the user can simplify the pattern or raise the budget.
- `preview_custom_manager` also stats each matched file before reading it and skips anything larger than `maxFileBytes` (default 5 MiB) with a warning, so a stray lockfile, generated artifact, or SQL dump caught by a loose `fileMatch` can't OOM the server. `maxHitsPerFile` already bounds output size; this guards input size.
- `resolve_config` expands `extends` against a committed snapshot of Renovate's built-in presets (`src/data/presets.generated.ts`). External `github>` / `gitlab>` fetching is opt-in, uses each platform's contents API with a 10 s timeout, and caches results per call. The `endpoint` input swaps in a custom API base for GHE / self-hosted GitLab; `platform` additionally rewrites `local>` presets to be fetched against that endpoint.
- `resolve_config` merges preset bodies with a close approximation of Renovate's own `mergeChildConfig` — arrays concat, objects recursively merge, scalars overwrite — not a bit-identical port. Rule-specific semantics for `hostRules`, `regexManagers` / `customManagers`, and certain boolean flags aren't modeled here. Every response carries `mergeQuality: "preview"` plus a human-readable `disclaimer` so callers can't miss the limitation; run `dry_run` for authoritative output.
- When `resolve_config` encounters template tokens outside its supported subset, it records a structured entry in `warnings`: under-argument cases (`{{arg2}}` referenced when only one arg was passed) substitute an empty string, while non-positional tokens (`{{packageRules}}`, Handlebars helpers like `{{#if …}}`) pass through verbatim.
- `explain_config` reuses the same expansion machinery as `resolve_config` (`parsePreset`, `loadPresetBody`, `applyArgs`, `recordTemplateWarnings`) so the two can't drift — if `resolve_config` resolves a preset, `explain_config` does too. The annotated layer threads each preset body's leaves through a parallel `mergeAnnotated` that preserves contributors instead of dropping them, then pins each contribution with the source name (literal `extends` entry, or `<own>` for the user's input config) and a `via` chain naming every parent preset traversed to reach it. Arrays accumulate every contribution in `setBy` and concat their `value`s; scalars list every contribution in merge order with the last as the winner. `merge_quality: "preview"` carries the same disclaimer as `resolve_config` — Renovate's rule-specific semantics for `hostRules`, `regexManagers`, and certain boolean flags aren't modelled.
- `dry_run` uses `--report-type=file` so we get a structured JSON report instead of scraping stdout. When a `hostRules` input is passed it's written to a mode-0600 temp file in `os.tmpdir()`, handed to Renovate via the `RENOVATE_CONFIG_FILE` env var (the CLI has no `--config-file` flag), and deleted in a `finally` block. Token/password values — including the platform `token` input — are scrubbed from the detected `problems` list and the `logTail` fallback before returning.
- `dry_run` defaults to `--platform=local` so no host token is required, but that mode can't resolve `local>` presets (they have no platform context to expand against) and silently hides non-default-host GitHub/GitLab setups. When the caller doesn't pass a `platform` input, the tool first falls back to `RENOVATE_PLATFORM` from the MCP server's env (if it's one of `local`/`github`/`gitlab`) before defaulting to `local` — without that fallback, the wrapper would unconditionally pass `--platform=local` and silently override an env var the user had set in their `mcp.json`. Passing `platform` + `endpoint` + `token` + `repository` (or relying on the `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` env vars) switches the run to a real platform client so the preset-fetch path works end-to-end; `--dry-run` is still set, so no PRs are opened. The repository is passed to Renovate as a positional argument because the CLI has no `--repository` flag. `endpoint` and `token` are also forwarded in the default `platform=local` mode so `gitlab>…` / `github>…` preset shortcuts (which are otherwise hardcoded to gitlab.com/github.com) can be redirected at a self-hosted host. As a guard against the silent-failure mode, `dry_run` preflight-checks the repo's config: if it extends any `local>…` preset while the effective platform is `local`, the tool fails fast with specific remediation rather than spawning a Renovate run that would opaquely report `config-validation`. The preflight is skipped for `dryRunMode=extract` so manifest-only extraction can still be attempted.
- `dry_run` returns a top-level `ok` boolean that is `false` whenever the CLI exited non-zero OR the structured report contains a validation/error-level problem (`level >= 40`, `message === "config-validation"`, or a non-empty `validationError` field). Renovate frequently writes exit-code 0 alongside report-level failures — trusting the exit code alone hides runs that did nothing.
- `dry_run` emits MCP progress notifications only when the caller's `tools/call` includes `_meta.progressToken` — no-op otherwise, so legacy clients see zero overhead. A 5-second heartbeat ticks while the child runs; each tick's message is best-effort enriched with the latest Renovate JSON-log `msg` seen on stdout. Notifications are also emitted at start and completion. We deliberately don't couple to Renovate's log schema beyond reading `msg`, since that schema isn't a stable API.
- `dry_run_diff` is stateless on purpose: both reports are passed as inputs, no per-repo state is kept on the server. Updates are keyed by `(manager, packageFile, depName)` so a version bump on the same dep shows up once under `changed` rather than twice as `removed + added`. Compared per identity: `newValue`, `newVersion`, `updateType`, `branchName`, `groupName`, `schedule`. Either input can be the raw Renovate report or the full `dry_run` summary (with the `report` key) — the tool unwraps `report` automatically.
- `write_config` writes to a temp file, validates, then atomically renames — so a failed validation never leaves a broken config on disk.
