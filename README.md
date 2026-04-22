# renovate-mcp

An MCP server for designing [Renovate](https://github.com/renovatebot/renovate) configurations interactively. Point it at a local repo and let an LLM help you read, validate, preview, and save `renovate.json`.

## What it does

Seven tools plus a preset reference:

| Tool | What it does |
| --- | --- |
| `check_setup` | Report Renovate CLI + validator availability, versions, env overrides, and install hints. Also runs at server startup and embeds the result in the server's `instructions` when anything's missing. |
| `read_config` | Locate and parse `renovate.json` / `renovate.json5` / `.renovaterc*` / `.github/renovate.json` / `.gitlab/renovate.json` / `package.json#renovate` in a repo — in Renovate's priority order. |
| `resolve_config` | Expand every `extends` preset against the committed catalogue and return the fully resolved config (offline; no `renovate` invocation). Flags unresolvable entries with a reason. Opt in to fetching `github>` / `gitlab>` presets over HTTPS with `externalPresets: true` (auth via `GITHUB_TOKEN` / `GITLAB_TOKEN` / `RENOVATE_TOKEN`). |
| `preview_custom_manager` | Preview a `customManagers` (regex) entry against a local repo — offline, no `renovate` invocation. Shows which files match `fileMatch`, which lines match each `matchStrings` regex with named capture groups, and what dep info the template fields produce. Intended for fast regex iteration; run `dry_run` afterwards for full-fidelity confirmation. |
| `validate_config` | Run `renovate-config-validator` against a file or inline object. |
| `dry_run` | Run Renovate with `--platform=local --dry-run`, return the structured JSON report (no PRs, no pushes). |
| `write_config` | Validate, then write a config to disk (temp-file → validate → atomic rename). Refuses to save invalid configs unless `force: true`. |
| `renovate://presets` (resource) | Markdown index of every built-in preset (1000+), grouped by namespace. Snapshot from the installed `renovate` devDep. |
| `renovate://preset/{name}` (resource template) | Expanded JSON body (description, extends, packageRules, …) for any single built-in preset. E.g. `renovate://preset/config:recommended`. |

## Requirements

- Node.js ≥ 24 (aligns with Renovate's own engine requirement).
- Renovate available on your `PATH` — either a global install (`npm i -g renovate`) or a project-local install that exposes `renovate` and `renovate-config-validator` via `npm exec`. Only needed for `validate_config`, `dry_run`, and `write_config`; the offline tools (`read_config`, `resolve_config`, `preview_custom_manager`) work without it.
- Override binary locations with env vars if needed: `RENOVATE_BIN`, `RENOVATE_CONFIG_VALIDATOR_BIN`.
- Optional for `resolve_config` with `externalPresets: true`: `GITHUB_TOKEN` / `GITLAB_TOKEN` (or `RENOVATE_TOKEN` as a fallback) for fetching presets from private repos or to avoid rate limits.

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
- `resolve_config` expands `extends` against a committed snapshot of Renovate's built-in presets (`src/data/presets.generated.ts`). External `github>` / `gitlab>` fetching is opt-in, uses each platform's contents API with a 10 s timeout, and caches results per call.
- `dry_run` uses `--report-type=file` so we get a structured JSON report instead of scraping stdout.
- `write_config` writes to a temp file, validates, then atomically renames — so a failed validation never leaves a broken config on disk.
