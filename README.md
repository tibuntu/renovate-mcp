# renovate-mcp

An MCP server for designing [Renovate](https://github.com/renovatebot/renovate) configurations interactively. Point it at a local repo and let an LLM help you read, validate, preview, and save `renovate.json`.

## What it does

Seven tools plus a preset reference:

| Tool | What it does |
| --- | --- |
| `check_setup` | Report Renovate CLI + validator availability, versions, env overrides, and install hints. Also runs at server startup and embeds the result in the server's `instructions` when anything's missing. |
| `read_config` | Locate and parse `renovate.json` / `renovate.json5` / `.renovaterc*` / `.github/renovate.json` / `.gitlab/renovate.json` / `package.json#renovate` in a repo — in Renovate's priority order. |
| `resolve_config` | Expand every `extends` preset against the committed catalogue and return the fully resolved config (offline; no `renovate` invocation). Flags unresolvable entries with a reason. Opt in to fetching `github>` / `gitlab>` presets over HTTPS with `externalPresets: true` (auth via `GITHUB_TOKEN` / `GITLAB_TOKEN` / `RENOVATE_TOKEN`). For GitHub Enterprise or self-hosted GitLab, pass `endpoint` (API base URL) — and `platform` in addition to route `local>` presets through the same host. `bitbucket>`, `gitea>`, and npm presets remain in `presetsUnresolved` regardless. |
| `preview_custom_manager` | Preview a `customManagers` (regex) entry against a local repo — offline, no `renovate` invocation. Shows which files match `fileMatch`, which lines match each `matchStrings` regex with named capture groups, and what dep info the template fields produce. Intended for fast regex iteration; run `dry_run` afterwards for full-fidelity confirmation. |
| `validate_config` | Run `renovate-config-validator` against a file or inline object. |
| `dry_run` | Run Renovate with `--platform=local --dry-run`, return the structured JSON report (no PRs, no pushes). Scans Renovate's logs for registry-auth failures (401/403/unauthorized/etc.) and surfaces them under `problems` so an empty-updates result isn't mistaken for "no updates available" when credentials were actually missing. Accepts an optional `hostRules` input for per-invocation private-registry credentials so callers don't have to restart the MCP server with new env vars (written to a mode-0600 temp file, passed via `--config-file`, cleaned up after the run; token/password values are scrubbed from any log output). |
| `write_config` | Validate, then write a config to disk (temp-file → validate → atomic rename). Refuses to save invalid configs unless `force: true`. |
| `renovate://presets` (resource) | Thin markdown index of every namespace (with preset counts) covering all 1000+ built-in presets. Snapshot from the installed `renovate` devDep. |
| `renovate://presets/{namespace}` (resource template) | Markdown listing of every preset in a single namespace (e.g. `renovate://presets/config`). Fetch this instead of the full index when the LLM only cares about one namespace — cuts token cost by roughly 1/N where N is the number of namespaces. |
| `renovate://preset/{name}` (resource template) | Expanded JSON body (description, extends, packageRules, …) for any single built-in preset. E.g. `renovate://preset/config:recommended`. |

## Requirements

- Node.js ≥ 24 (aligns with Renovate's own engine requirement).
- Renovate available on your `PATH` — either a global install (`npm i -g renovate`) or a project-local install that exposes `renovate` and `renovate-config-validator` via `npm exec`. Only needed for `validate_config`, `dry_run`, and `write_config`; the offline tools (`read_config`, `resolve_config`, `preview_custom_manager`) work without it.
- Override binary locations with env vars if needed: `RENOVATE_BIN`, `RENOVATE_CONFIG_VALIDATOR_BIN`.
- Optional for `resolve_config` with `externalPresets: true`: `GITHUB_TOKEN` / `GITLAB_TOKEN` (or `RENOVATE_TOKEN` as a fallback) for fetching presets from private repos or to avoid rate limits. For GitHub Enterprise / self-hosted GitLab, pass the `endpoint` tool input (and `platform` if you also want `local>` presets routed there); `RENOVATE_ENDPOINT` is **not** read.
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

- `validate_config`, `dry_run`, and `write_config` shell out to the Renovate CLI rather than importing Renovate as a library — this decouples our Node version from Renovate's (currently Node 24).
- `resolve_config` and `preview_custom_manager` are fully in-process and never invoke the Renovate CLI, so they work without a Renovate install.
- `preview_custom_manager` honors `.gitignore` (including nested `.gitignore`s and `.git/info/exclude`) when walking the repo, so generated/vendored directories like `dist/`, `.next/`, `target/`, `__pycache__/` don't crowd out real hits against the `maxFilesScanned` cap. `node_modules/` and `.git/` are always skipped as a safety net even when no `.gitignore` is present.
- `resolve_config` expands `extends` against a committed snapshot of Renovate's built-in presets (`src/data/presets.generated.ts`). External `github>` / `gitlab>` fetching is opt-in, uses each platform's contents API with a 10 s timeout, and caches results per call. The `endpoint` input swaps in a custom API base for GHE / self-hosted GitLab; `platform` additionally rewrites `local>` presets to be fetched against that endpoint.
- `dry_run` uses `--report-type=file` so we get a structured JSON report instead of scraping stdout. When a `hostRules` input is passed it's written to a mode-0600 temp file in `os.tmpdir()`, handed to Renovate via `--config-file=`, and deleted in a `finally` block. Token/password values are scrubbed from both the detected `problems` list and the `logTail` fallback before returning.
- `write_config` writes to a temp file, validates, then atomically renames — so a failed validation never leaves a broken config on disk.
