# Platform setup

Configure `renovate-mcp` for github.com, GitHub Enterprise, gitlab.com, self-hosted GitLab, Gitea / Forgejo (hosted or self-hosted), or Bitbucket Cloud. Only needed if you'll use `dry_run` against a remote platform, or the `resolve_config` family with `externalPresets: true` — the fully offline tools (`read_config`, `suggest_presets`, `resolve_config`, `explain_config`, `resolve_config_diff`, `test_package_rules`, `preview_custom_manager`, `lint_config`, `dry_run_diff`, `annotate_dry_run`, `explain_dependency`, `explain_schedule`, `migrate_config`) don't need any of this — the `resolve_config` family only when `externalPresets` stays unset.

## The matrix

The common configurations differ in three settings: `RENOVATE_PLATFORM`, `RENOVATE_ENDPOINT`, and which token env var you set. Pick the row that matches your environment and put the values in your client's `mcpServers.renovate.env` block.

> **Verify before you run.** Call [`check_setup`](tools.md#check_setup) with the absolute path to the repo you'll be operating on. It reads `.git/config`, cross-references with the env you've set here, and probes endpoint reachability — so you can confirm the matrix row matches your repo *before* `dry_run` discovers the mismatch the slow way.

| Setup | `RENOVATE_PLATFORM` | `RENOVATE_ENDPOINT` | Token env var |
| --- | --- | --- | --- |
| github.com | `github` | (omit — defaults to `https://api.github.com`) | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| GitHub Enterprise | `github` | `https://github.example.com/api/v3/` | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| gitlab.com | `gitlab` | (omit — defaults to `https://gitlab.com/api/v4`) | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |
| Self-hosted GitLab | `gitlab` | `https://gitlab.example.com/api/v4/` | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |
| gitea.com / Forgejo (code.forgejo.org) | — (`resolve_config` only) | (omit — defaults to `https://gitea.com/api/v1` / `https://code.forgejo.org/api/v1`) | `RENOVATE_TOKEN` *or* `GITEA_TOKEN` / `FORGEJO_TOKEN` |
| Self-hosted Gitea / Forgejo | — (`resolve_config` only) | `https://forgejo.example.com/api/v1/` | `RENOVATE_TOKEN` *or* `GITEA_TOKEN` / `FORGEJO_TOKEN` |
| Bitbucket Cloud | — (`resolve_config` only) | (omit — defaults to `https://api.bitbucket.org`) | `RENOVATE_TOKEN` *or* `BITBUCKET_TOKEN` |

## Notes that apply to every row

- **MCP server env, not your shell.** All env vars must be on the MCP server process — set them via the `env` key in `.mcp.json` / `claude_desktop_config.json`, not your shell. See [Security & secrets](security.md#where-env-vars-must-live).
- **Token precedence.** `RENOVATE_TOKEN` wins when both it and the platform-specific var are set. `dry_run` and `resolve_config` honour the same precedence; for `dry_run` the platform-specific var is auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI (Renovate itself only reads that one var).
- **github.com datasource token (`GITHUB_COM_TOKEN`).** Separate from the platform token: it authenticates github.com *datasource* lookups (release notes, `github-tags` / `github-releases` / `github-actions`) and is **never auto-derived** from `GITHUB_TOKEN` / `RENOVATE_TOKEN`. It only matters when github.com is *not* the run platform — i.e. the **default `dry_run` `platform: local`**, GHE, or GitLab rows. In those cases a repo with github.com-hosted deps will hit github.com anonymously (low rate limit, possible `skipReason`) unless you add `GITHUB_COM_TOKEN` (a read-only PAT) to the MCP server's `env`. On the `github` row against github.com it's redundant — the platform token already covers it. `check_setup` flags the gap when a github.com-origin repo would be dry-run as `local` without it.
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

## Worked example — self-hosted Forgejo (`resolve_config` family only)

```jsonc
{
  "mcpServers": {
    "renovate": {
      "command": "npx",
      "args": ["-y", "renovate-mcp"],
      "env": {
        "FORGEJO_TOKEN": "<your token>"
      }
    }
  }
}
```

Then call `resolve_config` (or `explain_config`, `resolve_config_diff`, `test_package_rules`, `annotate_dry_run`) with `externalPresets: true`, `platform: "forgejo"`, and `endpoint: "https://forgejo.example.com/api/v1"`. `forgejo>org/repo` entries are fetched from that endpoint, and `local>org/repo` entries are rewritten to `forgejo>org/repo` first. Hosted Gitea (`gitea>` + `GITEA_TOKEN`) works the same way without an `endpoint`. Codeberg is a Forgejo host too, but the `forgejo>` default is `code.forgejo.org` (Renovate's own default), so Codeberg-hosted presets need `endpoint: "https://codeberg.org/api/v1"`; `check_setup` points this out for a `codeberg.org` origin. For Bitbucket Cloud set `BITBUCKET_TOKEN` (a repository / workspace access token, or an Atlassian API token) and pass `platform: "bitbucket"` — Renovate has no `bitbucket>` prefix, so the preset must be spelled `local>workspace/repo`. `dry_run` does not support these platforms; it runs Renovate as `local` / `github` / `gitlab` only.

## `local>` presets

A config that extends `local>owner/repo:preset` only resolves when there's a platform context to expand it against:

- **For `dry_run`** — pass `platform` + `endpoint` + `repository` (token falls back to env). Use `dryRunMode=extract` if you only need manifest extraction; the preset preflight is skipped in that mode.
- **For `resolve_config`** — pass `platform` (`github`, `gitlab`, `gitea`, `forgejo`, or `bitbucket`) + `endpoint` as inputs and the tool rewrites `local>` into `<platform>>` and fetches over HTTPS. Without these inputs, `local>` stays in `presetsUnresolved` with a pointer to the workaround. `platform: "bitbucket"` is the only way to reach Bitbucket Cloud presets, since Renovate has no `bitbucket>` prefix. Run `dry_run` afterwards for full-fidelity merging.

## Private-registry credentials for `dry_run`

For private registries (npm, Docker, Composer, …), Renovate needs whatever it would normally need at lookup time:

- `COMPOSER_AUTH`
- `NPM_TOKEN` / `.npmrc`
- Docker registry creds
- A `RENOVATE_HOST_RULES` JSON blob

Alternatively encode these as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on `dry_run` (no MCP restart needed). Per-call `hostRules` are appended to whatever the repo's own config declares.

Values passed inline reach Renovate as JSON through the tool-call transport, so the calling LLM sees them in its context — **prefer the env route if that matters**. See [Security & secrets — inline secrets](security.md#inline-secrets-in-the-transcript).

Without any of these, Renovate's lookup often returns 0 updates silently; `dry_run` scans its logs for auth failures and surfaces them under `problems`.
