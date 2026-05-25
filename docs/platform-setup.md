# Platform setup

Configure `renovate-mcp` for github.com, GitHub Enterprise, gitlab.com, or self-hosted GitLab. Only needed if you'll use `dry_run` against a remote platform or `resolve_config` with `externalPresets: true` — the fully offline tools (`read_config`, `resolve_config` without external presets, `preview_custom_manager`, `lint_config`) don't need any of this.

## The matrix

The four common configurations differ in three settings: `RENOVATE_PLATFORM`, `RENOVATE_ENDPOINT`, and which token env var you set. Pick the row that matches your environment and put the values in your client's `mcpServers.renovate.env` block.

> **Verify before you run.** Call [`check_setup`](tools.md#check_setup) with the absolute path to the repo you'll be operating on. It reads `.git/config`, cross-references with the env you've set here, and probes endpoint reachability — so you can confirm the matrix row matches your repo *before* `dry_run` discovers the mismatch the slow way.

| Setup | `RENOVATE_PLATFORM` | `RENOVATE_ENDPOINT` | Token env var |
| --- | --- | --- | --- |
| github.com | `github` | (omit — defaults to `https://api.github.com`) | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| GitHub Enterprise | `github` | `https://github.example.com/api/v3/` | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| gitlab.com | `gitlab` | (omit — defaults to `https://gitlab.com/api/v4`) | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |
| Self-hosted GitLab | `gitlab` | `https://gitlab.example.com/api/v4/` | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |

## Notes that apply to every row

- **MCP server env, not your shell.** All env vars must be on the MCP server process — set them via the `env` key in `.mcp.json` / `claude_desktop_config.json`, not your shell. See [Security & secrets](security.md#where-env-vars-must-live).
- **Token precedence.** `RENOVATE_TOKEN` wins when both it and the platform-specific var are set. `dry_run` and `resolve_config` honour the same precedence; for `dry_run` the platform-specific var is auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI (Renovate itself only reads that one var).
- **GitLab repo paths.** For repository identifiers, GitLab accepts nested-group paths like `group/subgroup/project`, not just `group/project`.

## Worked example — self-hosted GitLab

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

This is enough for both `dry_run` (remote-platform runs) and `resolve_config` (private preset fetches). With this set, `dry_run` against `group/subgroup/project` works without passing `platform` / `endpoint` / `token` per call: `RENOVATE_PLATFORM` and the auto-translated `GITLAB_TOKEN` cover the platform side, and `RENOVATE_ENDPOINT` is inherited naturally by the spawned Renovate CLI.

For `resolve_config`, `platform` and `endpoint` are tool **inputs** (not env vars) — pass them when you need `local>` presets routed through your host, since `resolve_config` is in-process and doesn't read `RENOVATE_*` env vars itself.

## `local>` presets

A config that extends `local>owner/repo:preset` only resolves when there's a platform context to expand it against:

- **For `dry_run`** — pass `platform` + `endpoint` + `repository` (token falls back to env). Use `dryRunMode=extract` if you only need manifest extraction; the preset preflight is skipped in that mode.
- **For `resolve_config`** — pass `platform` + `endpoint` as inputs and the tool rewrites `local>` into `<platform>>` and fetches over HTTPS. Without these inputs, `local>` stays in `presetsUnresolved` with a pointer to the workaround. Run `dry_run` afterwards for full-fidelity merging.

## Private-registry credentials for `dry_run`

For private registries (npm, Docker, Composer, …), Renovate needs whatever it would normally need at lookup time:

- `COMPOSER_AUTH`
- `NPM_TOKEN` / `.npmrc`
- Docker registry creds
- A `RENOVATE_HOST_RULES` JSON blob

Alternatively encode these as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on `dry_run` (no MCP restart needed). Per-call `hostRules` are appended to whatever the repo's own config declares.

Values passed inline reach Renovate as JSON through the tool-call transport, so the calling LLM sees them in its context — **prefer the env route if that matters**. See [Security & secrets — inline secrets](security.md#inline-secrets-in-the-transcript).

Without any of these, Renovate's lookup often returns 0 updates silently; `dry_run` scans its logs for auth failures and surfaces them under `problems`.
