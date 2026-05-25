# renovate-mcp

[![npm](https://img.shields.io/npm/v/renovate-mcp.svg)](https://www.npmjs.com/package/renovate-mcp)
[![CI](https://github.com/tibuntu/renovate-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tibuntu/renovate-mcp/actions/workflows/ci.yml)
[![Node ≥ 24](https://img.shields.io/node/v/renovate-mcp.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An MCP server for designing [Renovate](https://github.com/renovatebot/renovate) configurations interactively. Point it at a local repo and let an LLM help you read, validate, preview, and save `renovate.json`.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/tibuntu/renovate-mcp/main/install.sh | bash
```

Or add this entry manually to your client's `mcpServers` config:

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

Restart your client and try the prompt: *"List the namespaces available under `renovate://presets`."* A response listing `config`, `docker`, `npm`, … confirms the server is reachable. Long-form install options are under [Install](#install) below.

## What you can do

- **Read and explain configs** — locate the active `renovate.json*`, expand every `extends` preset offline, and trace which preset set each field.
- **Preview custom managers** before running Renovate — regex and JSONata, with file/line hits and extracted dep info.
- **Validate and lint** — schema validation plus a semantic lint pass for Renovate-specific footguns (unwrapped regexes, unknown manager names, deprecated keys).
- **Dry-run** against a local checkout or a remote GitHub/GitLab — see exactly which PRs Renovate would open.
- **Save back atomically** — round-trip writes preserve comments and key order in existing JSON-with-comments files.

## Tools & resources

Twelve tools and three resource templates. Each tool name below links to its full reference in [`docs/tools.md`](docs/tools.md).

| Tool | Purpose |
| --- | --- |
| [`check_setup`](docs/tools.md#check_setup) | Report Renovate CLI + validator availability, versions, install hints, and a `platformContext` block for env diagnosis. Also runs at startup. |
| [`get_version`](docs/tools.md#get_version) | Report the renovate-mcp server version and whether it's a released or local/dev build. |
| [`read_config`](docs/tools.md#read_config) | Locate and parse a repo's Renovate config in Renovate's own discovery order. |
| [`resolve_config`](docs/tools.md#resolve_config) | Expand every `extends` preset offline. Opt in to fetching `github>` / `gitlab>` presets over HTTPS. |
| [`explain_config`](docs/tools.md#explain_config) | Inverse of `resolve_config`: annotate every leaf field with the chain of presets that set it. |
| [`preview_custom_manager`](docs/tools.md#preview_custom_manager) | Preview a `customManagers` entry (regex or JSONata) against a local repo. Offline. |
| [`validate_config`](docs/tools.md#validate_config) | Run `renovate-config-validator` against a file or inline object. |
| [`lint_config`](docs/tools.md#lint_config) | Semantic lint pass for Renovate-specific footguns the schema validator declares valid. Offline. |
| [`dry_run`](docs/tools.md#dry_run) | Run Renovate with `--dry-run` and return the structured JSON report. Local-by-default; remote with `platform` + `endpoint` + `token` + `repository`. No PRs, no pushes. |
| [`dry_run_diff`](docs/tools.md#dry_run_diff) | Stateless semantic diff between two `dry_run` reports — added / removed / changed updates. |
| [`migrate_config`](docs/tools.md#migrate_config) | Apply Renovate's built-in migrations and return the migrated config plus a unified diff. Does not write. |
| [`write_config`](docs/tools.md#write_config) | Validate, then atomically write a config to disk. Preserves comments/key order on existing JSON-with-comments files. |
| [`renovate://presets`](docs/tools.md#renovatepresets) (resource) | Markdown index of all built-in presets grouped by namespace. |
| [`renovate://presets/{namespace}`](docs/tools.md#renovatepresetsnamespace) (resource) | Markdown listing for a single namespace. |
| [`renovate://preset/{name}`](docs/tools.md#renovatepresetname) (resource) | Expanded JSON body for one preset. |

## Requirements

- **Linux or macOS.** Windows is not supported — `package.json` declares `"os": ["darwin", "linux"]`, so `npm i` surfaces an `EBADPLATFORM` warning on Windows and the server exits with a clear stderr message at startup. Use WSL2 or a Linux/macOS host instead.
- **Node.js ≥ 24** (aligns with Renovate's own engine requirement).

Renovate ships bundled — the `renovate` package is a runtime dependency, so `validate_config`, `dry_run`, and `write_config` work out of the box with no separate install. The offline tools (`read_config`, `resolve_config`, `explain_config`, `preview_custom_manager`, `lint_config`) never spawn Renovate at all.

**Optional env vars:**

- `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` — override the bundled binaries. When set, the override always wins.
- `RENOVATE_MCP_REQUIRE_CLI=false` — suppress the startup "partial availability" notice when you only intend to use the offline tools.
- Platform + token env vars — see [`docs/platform-setup.md`](docs/platform-setup.md) for the per-platform matrix.

> Heads up: MCP servers do **not** inherit your shell env. Set every env var via the `env` key in `.mcp.json` / `claude_desktop_config.json`. See [`docs/security.md`](docs/security.md#where-env-vars-must-live).

## Install

### Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/tibuntu/renovate-mcp/main/install.sh | bash
```

The script checks Node ≥ 24, asks whether you want `npx`-on-demand or a global install, runs an MCP `initialize` handshake to verify the binary works, and — when the Claude Code CLI is on PATH — auto-registers `renovate` in user scope via `claude mcp add`. Useful flags (pass after `bash -s --`): `--global`, `--npx`, `--no-mcp-add`, `--mcp-scope=user|project|local`, `--version=X.Y.Z`. The same flags are also accepted as env vars (`RENOVATE_MCP_GLOBAL=1`, `RENOVATE_MCP_NO_MCP_ADD=1`, `RENOVATE_MCP_VERSION=…`).

### Manual install

`npx` fetches the [published package](https://www.npmjs.com/package/renovate-mcp) on demand — no manual install needed. For local development, clone and build first:

```bash
npm install
npm run build
```

### Client config locations

- **Claude Code** — `.mcp.json` (project) or `~/.claude.json` (user).
- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **Other MCP clients** — any client that can launch a stdio MCP server works; point it at the same `npx -y renovate-mcp` command.

For local development, swap to `"command": "node"` with `"args": ["/absolute/path/to/renovate-mcp/dist/index.js"]`.

## Platform setup

For `dry_run` against a remote platform or `resolve_config` with `externalPresets: true`:

| Setup | `RENOVATE_PLATFORM` | `RENOVATE_ENDPOINT` | Token |
| --- | --- | --- | --- |
| github.com | `github` | (omit) | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| GitHub Enterprise | `github` | `https://github.example.com/api/v3/` | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| gitlab.com | `gitlab` | (omit) | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |
| Self-hosted GitLab | `gitlab` | `https://gitlab.example.com/api/v4/` | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |

See [`docs/platform-setup.md`](docs/platform-setup.md) for a worked self-hosted GitLab example, `local>` preset handling, and private-registry credentials.

## Example prompts

Once the server is wired up, try prompts like these. Written for Claude but work with any MCP-capable client.

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

**Authoring a custom manager (regex or JSONata)**

- "I have `# renovate: datasource=docker depName=...` comments above image tags in my Dockerfiles. Draft a `customManagers` regex entry and preview it against this repo so I can see what it extracts."
- "Here's a `customManagers` entry — preview it and tell me which files match, which lines hit each `matchStrings` regex, and what dep info gets extracted."
- "Draft a `customType: \"jsonata\"` customManager with `fileFormat: \"yaml\"` to extract Helm chart dependencies (`name`, `version`, `repository`) from `Chart.yaml`, and preview it against this repo."

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
> **Claude** calls `write_config` on `renovate.json`. → validated, written atomically; because the file already existed and parsed as JSON-with-comments, the round-trip serializer preserved the surrounding comments and key order — only the `customManagers` slice was edited in place.

## Development

```bash
npm run dev                     # build watch mode
npm run typecheck               # tsc --noEmit
npm run build                   # compile to dist/
npm start                       # run the built server over stdio
npm test                        # vitest run (builds first)
npm run test:watch              # vitest watch mode
npm run test:coverage           # vitest run --coverage
npm run generate:presets        # regenerate src/data/presets.generated.ts
npm run generate:managers       # regenerate src/data/managers.generated.ts
npm run generate:migrations     # regenerate src/data/migrations.generated.ts
npm run check:snapshot-versions # fail if any src/data/*.generated.ts is stale vs installed renovate
```

See [`docs/development.md`](docs/development.md) for snapshot-file mechanics, CI matrix, the nightly upstream-drift workflow, dependency review, and integration-test setup.

## Further reading

- [`docs/tools.md`](docs/tools.md) — full per-tool reference with all inputs, outputs, and edge cases.
- [`docs/platform-setup.md`](docs/platform-setup.md) — per-platform env vars, worked example, `local>` presets, private-registry credentials.
- [`docs/security.md`](docs/security.md) — token handling, env-var precedence, endpoint allowlist, redirect/body-cap policy, inline-secrets warning.
- [`docs/operations.md`](docs/operations.md) — timeouts, caps, large-report escape hatch, `ok` semantics, RE2 / nodeEnv handling, progress notifications.
- [`docs/architecture.md`](docs/architecture.md) — shell-out vs import, worker isolation, round-trip writer, preset catalogue.
- [`docs/development.md`](docs/development.md) — snapshot mechanics, CI matrix, nightly drift workflow, integration testing.

## What this is NOT

- **Not a Renovate replacement.** This server doesn't open PRs, run scheduled updates, or execute in CI — it's a design-time companion for a local `renovate.json`. Use the real Renovate for the actual dependency-update pipeline.
- **`resolve_config` is preview-quality.** Preset expansion runs against a committed snapshot, and template substitution implements only positional `{{argN}}` placeholders — non-positional tokens and Handlebars helpers are flagged in `warnings` and pass through verbatim. For authoritative output, run `dry_run`.
- **`preview_custom_manager` is a subset of Renovate's custom managers.** It covers `customType: "regex"` (with `matchStringsStrategy` of `any` / `combination` / `recursive`) and `customType: "jsonata"` (with `fileFormat: "json" | "yaml" | "toml"`). Template substitution is `{{groupName}}` only — full Handlebars helpers/conditionals are not implemented. Other custom types (e.g. `html`) are out of scope. Use it for fast iteration; confirm with `dry_run`. Full coverage matrix in [`docs/tools.md#preview_custom_manager`](docs/tools.md#preview_custom_manager).
- **`validate_config` / `dry_run` aren't exercised end-to-end in CI.** The bundled Renovate is available (it's a runtime dep), but the integration tests use fake binaries via `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` env overrides for determinism and speed. Run the tools locally against a real config to validate behaviour.
