# renovate-mcp

An MCP server for designing [Renovate](https://github.com/renovatebot/renovate) configurations interactively. Point it at a local repo and let an LLM help you read, validate, preview, and save `renovate.json`.

## What it does

Eight tools plus a preset reference:

| Tool | What it does |
| --- | --- |
| `check_setup` | Report Renovate CLI + validator availability, versions, env overrides, and install hints. Also runs at server startup and embeds the result in the server's `instructions` when anything's missing. |
| `read_config` | Locate and parse `renovate.json` / `renovate.json5` / `.renovaterc*` / `.github/renovate.json` / `.gitlab/renovate.json` / `package.json#renovate` in a repo — in Renovate's priority order. |
| `resolve_config` | Expand every `extends` preset against the committed catalogue and return the fully resolved config (offline; no `renovate` invocation). Flags unresolvable entries with a reason. Opt in to fetching `github>` / `gitlab>` presets over HTTPS with `externalPresets: true` (auth via `RENOVATE_TOKEN`, or `GITHUB_TOKEN` / `GITLAB_TOKEN` as platform-specific fallbacks). For GitHub Enterprise or self-hosted GitLab, pass `endpoint` (API base URL) — and `platform` in addition to route `local>` presets through the same host. `bitbucket>`, `gitea>`, and npm presets remain in `presetsUnresolved` regardless. |
| `preview_custom_manager` | Preview a `customManagers` (regex) entry against a local repo — offline, no `renovate` invocation. Shows which files match `fileMatch`, which lines match each `matchStrings` regex with named capture groups, and what dep info the template fields produce. User-supplied patterns run on a worker thread with a per-regex wall-clock budget (default 2000 ms, override via `matchTimeoutMs`) so a pathological pattern times out with a warning instead of pinning the server. Intended for fast regex iteration; run `dry_run` afterwards for full-fidelity confirmation. |
| `validate_config` | Run `renovate-config-validator` against a file or inline object. |
| `lint_config` | Semantic lint pass for Renovate-specific footguns schema validation misses — primarily malformed `/…/` regex patterns in `matchPackageNames` / `matchDepNames` / `matchSourceUrls` / `matchCurrentVersion`. Offline; does not shell out. Returns findings with JSON path, offending value, and a stable `ruleId` (`dead-regex-missing-slash`, `unwrapped-regex`) for suppression. Complements `validate_config`. |
| `dry_run` | Run Renovate with `--platform=local --dry-run`, return the structured JSON report (no PRs, no pushes). Scans Renovate's logs for registry-auth failures (401/403/unauthorized/etc.) and surfaces them under `problems` so an empty-updates result isn't mistaken for "no updates available" when credentials were actually missing. Accepts an optional `hostRules` input for per-invocation private-registry credentials so callers don't have to restart the MCP server with new env vars (written to a mode-0600 temp file, passed via `--config-file`, cleaned up after the run; token/password values are scrubbed from any log output). |
| `write_config` | Validate, then write a config to disk (temp-file → validate → atomic rename). Refuses to save invalid configs unless `force: true`. |
| `renovate://presets` (resource) | Thin markdown index of every namespace (with preset counts) covering all 1000+ built-in presets. Snapshot from the installed `renovate` devDep. |
| `renovate://presets/{namespace}` (resource template) | Markdown listing of every preset in a single namespace (e.g. `renovate://presets/config`). Fetch this instead of the full index when the LLM only cares about one namespace — cuts token cost by roughly 1/N where N is the number of namespaces. |
| `renovate://preset/{name}` (resource template) | Expanded JSON body (description, extends, packageRules, …) for any single built-in preset. E.g. `renovate://preset/config:recommended`. |

## What this is NOT

- **Not a Renovate replacement.** This server doesn't open PRs, run scheduled updates, or execute in CI — it's a design-time companion for a local `renovate.json`. Use the real Renovate for the actual dependency-update pipeline.
- **`resolve_config` is preview-quality.** Preset expansion runs against a committed snapshot, and template substitution implements only positional `{{argN}}` placeholders — non-positional tokens and Handlebars helpers are flagged in `warnings` and pass through verbatim. For authoritative output, run `dry_run`.
- **`preview_custom_manager` is a subset of Renovate's regex manager.** It covers `customType: "regex"`, `matchStringsStrategy: "any"`, and `{{groupName}}` template substitution only — other custom types, other strategies, and full Handlebars (helpers, conditionals) are not implemented. Use it for fast regex iteration; confirm with `dry_run`.
- **`validate_config` / `dry_run` aren't exercised in CI.** CI deliberately doesn't install Renovate, so tools that shell out to it are only covered by unit/integration tests that don't require the binary. Run them locally against the Renovate install you intend to deploy with.

## Requirements

- Node.js ≥ 24 (aligns with Renovate's own engine requirement).
- Renovate available on your `PATH` — either a global install (`npm i -g renovate`) or a project-local install that exposes `renovate` and `renovate-config-validator` via `npm exec`. Only needed for `validate_config`, `dry_run`, and `write_config`; the offline tools (`read_config`, `resolve_config`, `preview_custom_manager`, `lint_config`) work without it.
- Override binary locations with env vars if needed: `RENOVATE_BIN`, `RENOVATE_CONFIG_VALIDATOR_BIN`.
- `RENOVATE_MCP_REQUIRE_CLI=false` suppresses the startup "partial availability" notice. Set this if you only intend to use the offline tools (`read_config`, `resolve_config`, `preview_custom_manager`) and don't want the missing-CLI notice in the server's MCP instructions.
- Optional for `resolve_config` with `externalPresets: true`: `RENOVATE_TOKEN` (preferred — matches Renovate's own convention, where `RENOVATE_TOKEN` is the explicit Renovate-specific override), or `GITHUB_TOKEN` / `GITLAB_TOKEN` as platform-specific fallbacks, for fetching presets from private repos or to avoid rate limits. When both `RENOVATE_TOKEN` and a platform token are set, `RENOVATE_TOKEN` wins. For GitHub Enterprise / self-hosted GitLab, pass the `endpoint` tool input (and `platform` if you also want `local>` presets routed there); `RENOVATE_ENDPOINT` is **not** read.
- Optional for `dry_run` against private package registries: whatever credentials Renovate itself would need at lookup time — e.g. `COMPOSER_AUTH` for private Packagist / Satis proxies, `NPM_TOKEN` or `.npmrc` for private npm, Docker registry credentials, or a `RENOVATE_HOST_RULES` JSON blob covering multiple hosts. Alternatively, encode these as `hostRules` directly in the Renovate config, or pass them per-call via the `hostRules` input on `dry_run` (no MCP server restart needed — useful while debugging an empty-updates result). Per-call `hostRules` are appended to any the repo's own config already declares. Values reach Renovate through the MCP tool-call transport as JSON, so the calling LLM sees them in its context; if that matters for a given token, use the env route instead. Without any of these Renovate's lookup step often returns 0 updates silently; `dry_run` will scan its logs for auth failures and surface them under `problems` in the output.
- Any env vars the tools read (tokens, `COMPOSER_AUTH`, `RENOVATE_HOST_RULES`, binary overrides, …) must be set on the MCP server process itself — via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell, since the MCP server runs as a child of Claude and does not inherit shell env.

## Install

Once published to npm, no install is needed — `npx` will fetch it on demand. For local development, clone and build:

```bash
npm install
npm run build
```

## Use with Claude Code

Add to `.mcp.json` (project) or `~/.claude.json` (user):

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

For local development, swap to:

```json
{
  "mcpServers": {
    "renovate": {
      "command": "node",
      "args": ["/absolute/path/to/renovate-mcp/dist/index.js"]
    }
  }
}
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

## Example prompts

Once the server is wired up, try prompts like these. They're written for Claude but work with any MCP-capable client.

**Understanding an existing config**

- "Read the Renovate config in this repo and summarize what it actually does — expand every preset so I can see the real effective behavior."
- "Resolve my config and list anything that landed in `presetsUnresolved`, with the reason for each."

**Browsing presets**

- "List the presets in the `config` namespace." (uses the `renovate://presets/config` sub-resource — cheaper than pulling the whole index)
- "What does `config:recommended` actually enable? Show me its expanded JSON."
- "Find a built-in preset that pins GitHub Actions digests."

**Self-hosted GitLab / GitHub Enterprise**

- "Resolve my config with external presets enabled, fetching `gitlab>platform/renovate-presets` from our self-hosted GitLab at `https://gitlab.example.com/api/v4`. Route `local>` presets through the same host."
- "Expand `github>acme/renovate-config//base` from our GitHub Enterprise at `https://github.acme.corp/api/v3`."

(Reminder: auth tokens must be set on the MCP server process — via the `env` key in `.mcp.json` / `claude_desktop_config.json`, not your shell.)

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
npm run generate:presets # regenerate src/data/presets.generated.ts from the renovate devDep
```

The preset catalogue at `src/data/presets.generated.ts` is a committed snapshot of Renovate's built-in presets. Runtime code never imports the `renovate` package — only `scripts/generate-presets.mjs` does. Regenerate after bumping the `renovate` devDependency.

CI runs `typecheck`, `build`, and `test` on Node 24 for every PR and push to `main` (see `.github/workflows/ci.yml`).

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
- `lint_config` is a semantic lint pass that sits alongside `validate_config` rather than replacing it: schema validation catches structural bugs, the linter catches Renovate-specific footguns that schema validation declares valid — most commonly a pattern like `"matchPackageNames": ["/devops\\/pipelines\\/.+"]` where a trailing `/` is missing and Renovate silently degrades the value to an exact-string match that never hits. The ruleset is intentionally small (two rules: `dead-regex-missing-slash`, `unwrapped-regex`), scoped to the four regex-aware fields named in the proposal, and tuned to avoid false positives on benign exact strings containing a `.`. Rule IDs are stable so findings can be suppressed by callers.
- `preview_custom_manager` honors `.gitignore` (including nested `.gitignore`s and `.git/info/exclude`) when walking the repo, so generated/vendored directories like `dist/`, `.next/`, `target/`, `__pycache__/` don't crowd out real hits against the `maxFilesWalked` cap. `node_modules/` and `.git/` are always skipped as a safety net even when no `.gitignore` is present.
- `preview_custom_manager` exposes two separate safety caps so the warning text can name which one tripped: `maxFilesWalked` (default 2000) bounds the directory walk before any `fileMatch` testing, and `maxFilesMatched` (default 500) bounds the result set after `fileMatch` is applied. Previously a single `maxFilesScanned` conflated the two, leaving the user unable to tell whether to narrow `fileMatch` or widen the walk.
- `preview_custom_manager` runs every user-supplied regex on a `worker_threads` worker with a wall-clock budget per operation (default 2 s, configurable via `matchTimeoutMs`). Catastrophic backtracking — e.g. `^(a+)+b$` against `aaaa…c`, or `(.*)*=` against a modestly sized file — would otherwise pin the MCP server's event loop indefinitely. On timeout the worker is terminated and a warning is appended identifying which `fileMatch[i]` or `matchStrings[i]` was aborted, so the user can simplify the pattern or raise the budget.
- `resolve_config` expands `extends` against a committed snapshot of Renovate's built-in presets (`src/data/presets.generated.ts`). External `github>` / `gitlab>` fetching is opt-in, uses each platform's contents API with a 10 s timeout, and caches results per call. The `endpoint` input swaps in a custom API base for GHE / self-hosted GitLab; `platform` additionally rewrites `local>` presets to be fetched against that endpoint.
- `resolve_config` merges preset bodies with a close approximation of Renovate's own `mergeChildConfig` — arrays concat, objects recursively merge, scalars overwrite — not a bit-identical port. Rule-specific semantics for `hostRules`, `regexManagers` / `customManagers`, and certain boolean flags aren't modeled here. Every response carries `mergeQuality: "preview"` plus a human-readable `disclaimer` so callers can't miss the limitation; run `dry_run` for authoritative output.
- When `resolve_config` encounters template tokens outside its supported subset, it records a structured entry in `warnings`: under-argument cases (`{{arg2}}` referenced when only one arg was passed) substitute an empty string, while non-positional tokens (`{{packageRules}}`, Handlebars helpers like `{{#if …}}`) pass through verbatim.
- `dry_run` uses `--report-type=file` so we get a structured JSON report instead of scraping stdout. When a `hostRules` input is passed it's written to a mode-0600 temp file in `os.tmpdir()`, handed to Renovate via `--config-file=`, and deleted in a `finally` block. Token/password values are scrubbed from both the detected `problems` list and the `logTail` fallback before returning.
- `write_config` writes to a temp file, validates, then atomically renames — so a failed validation never leaves a broken config on disk.
