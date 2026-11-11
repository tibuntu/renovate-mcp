# Platform setup

Configure `renovate-mcp` for github.com, GitHub Enterprise, gitlab.com, self-hosted GitLab, Gitea / Forgejo (hosted or self-hosted), or Bitbucket Cloud. Only needed if you'll use `dry_run` against a remote platform, or the `resolve_config` family with `externalPresets: true` — the fully offline tools (`read_config`, `suggest_presets`, `resolve_config`, `explain_config`, `resolve_config_diff`, `test_package_rules`, `preview_custom_manager`, `lint_config`, `dry_run_diff`, `annotate_dry_run`, `explain_dependency`, `explain_schedule`, `explain_paths`, `migrate_config`) don't need any of this — the `resolve_config` family only when `externalPresets` stays unset.

## The matrix

The common configurations differ in three settings: `RENOVATE_PLATFORM`, `RENOVATE_ENDPOINT`, and which token env var you set. Pick the row that matches your environment and put the values in your client's `mcpServers.renovate.env` block.

> **Verify before you run.** Call [`check_setup`](tools.md#check_setup) with the absolute path to the repo you'll be operating on. It reads `.git/config`, cross-references with the env you've set here, and probes endpoint reachability — so you can confirm the matrix row matches your repo *before* `dry_run` discovers the mismatch the slow way.

| Setup | `RENOVATE_PLATFORM` | `RENOVATE_ENDPOINT` | Token env var |
| --- | --- | --- | --- |
| github.com | `github` | (omit — defaults to `https://api.github.com`) | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` |
| GitHub Enterprise | `github` | `https://github.example.com/api/v3/` | `RENOVATE_TOKEN` *or* `GITHUB_TOKEN` (both bound to the GHE host; github.com needs `GITHUB_COM_TOKEN`) |
| gitlab.com | `gitlab` | (omit — defaults to `https://gitlab.com/api/v4`) | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` |
| Self-hosted GitLab | `gitlab` | `https://gitlab.example.com/api/v4/` | `RENOVATE_TOKEN` *or* `GITLAB_TOKEN` (both bound to the endpoint host) |
| gitea.com / Forgejo (code.forgejo.org) | — (`resolve_config` only) | (omit — defaults to `https://gitea.com/api/v1` / `https://code.forgejo.org/api/v1`) | `GITEA_TOKEN` / `FORGEJO_TOKEN` |
| Self-hosted Gitea / Forgejo | `gitea` / `forgejo` (`resolve_config` only; `dry_run` falls back to `local`) | `https://forgejo.example.com/api/v1` | `RENOVATE_TOKEN` *or* `GITEA_TOKEN` / `FORGEJO_TOKEN` (bound to the endpoint host), or a `RENOVATE_MCP_HOST_TOKENS` entry |
| Bitbucket Cloud | — (`resolve_config` only) | (omit — defaults to `https://api.bitbucket.org`) | `BITBUCKET_TOKEN` |

## Notes that apply to every row

- **MCP server env, not your shell.** All env vars must be on the MCP server process — set them via the `env` key in `.mcp.json` / `claude_desktop_config.json`, not your shell. See [Security & secrets](security.md#where-env-vars-must-live).
- **Tokens are bound by the server env, never by a call.** Each per-platform token goes only to its own platform's public host, and `RENOVATE_TOKEN` only to the *home*: `RENOVATE_PLATFORM`, at `RENOVATE_ENDPOINT` when set. There `RENOVATE_TOKEN` wins over the platform's own token (as in Renovate), and the platform's own token moves from its public host to the endpoint host as the fallback. Without `RENOVATE_PLATFORM` there is no home and `RENOVATE_TOKEN` is not used. A `platform` / `endpoint` input (or `dry_run`'s `presetPlatform`, or a repo's origin) routes `local>` presets but never moves a token, so a prompt-injected call or an untrusted repo cannot send your token to its host. A token for any other host goes into `RENOVATE_MCP_HOST_TOKENS` (by variable name, not value); `check_setup` lists its entries by name and presence and says when a self-hosted origin's token is bound to the public host instead. Full rules: [Security & secrets — token resolution](security.md#token-resolution).
- **`dry_run` tokens.** The same binding: on a remote run the token bound to the API host is exported as `RENOVATE_TOKEN` (Renovate itself only reads that one var). Under `platform: local` no `RENOVATE_TOKEN` reaches Renovate as a platform token; every env token goes in as a host rule on its own host instead, so `GITLAB_TOKEN` authenticates gitlab.com lookups there.
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

This is enough for both `dry_run` (remote-platform runs) and `resolve_config` (private preset fetches). With this set, `dry_run` against `group/subgroup/project` works without passing `platform` / `endpoint` / `token` per call: `RENOVATE_PLATFORM` and `GITLAB_TOKEN` (bound to the `RENOVATE_ENDPOINT` host as the fallback for an unset `RENOVATE_TOKEN`, and exported as `RENOVATE_TOKEN`) cover the platform side, and `RENOVATE_ENDPOINT` is inherited naturally by the spawned Renovate CLI.

For `resolve_config`, `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` make gitlab.example.com the home: `local>` presets are fetched from that host and `GITLAB_TOKEN` authenticates those fetches, without passing `platform` / `endpoint` per call. A call that passes `platform: "github"` (or any platform other than `RENOVATE_PLATFORM`) ignores `RENOVATE_ENDPOINT`. `gitlab>` presets always go to gitlab.com, as in Renovate, and `GITLAB_TOKEN` is not sent there in this setup.

## Worked example — self-hosted Forgejo (`resolve_config` family only)

```jsonc
{
  "mcpServers": {
    "renovate": {
      "command": "npx",
      "args": ["-y", "renovate-mcp"],
      "env": {
        "RENOVATE_PLATFORM": "forgejo",
        "RENOVATE_ENDPOINT": "https://forgejo.example.com/api/v1",
        "FORGEJO_TOKEN": "<your token>"
      }
    }
  }
}
```

Then call `resolve_config` (or `explain_config`, `resolve_config_diff`, `test_package_rules`, `annotate_dry_run`, `explain_paths`) with `externalPresets: true` and reference the presets as `local>org/repo`. They are fetched from `RENOVATE_ENDPOINT`, and `FORGEJO_TOKEN` is sent there because the env makes it the home. Passing `platform: "forgejo"` + `endpoint` on the call instead routes the presets the same way but sends no token: a call never binds one. When `RENOVATE_PLATFORM` is taken by another platform, add a `RENOVATE_MCP_HOST_TOKENS` entry for the Forgejo host and pass `platform` + `endpoint` per call. `forgejo>org/repo` entries always go to `code.forgejo.org`, as in Renovate, and get `FORGEJO_TOKEN` only when no `RENOVATE_ENDPOINT` moves its binding. `RENOVATE_PLATFORM=forgejo` is outside `dry_run`'s platforms, so `dry_run` falls back to `local` (with a `check_setup` note). Hosted Gitea (`gitea>` + `GITEA_TOKEN`) needs no `endpoint`. Codeberg is a Forgejo host too, so Codeberg-hosted presets are `local>` presets with `platform: "forgejo"` and `endpoint: "https://codeberg.org/api/v1"`; `check_setup` points this out for a `codeberg.org` origin. For Bitbucket Cloud set `BITBUCKET_TOKEN` (a repository / workspace access token, or an Atlassian API token) and pass `platform: "bitbucket"` — Renovate has no `bitbucket>` prefix, so the preset must be spelled `local>workspace/repo`. `dry_run` does not support these platforms; it runs Renovate as `local` / `github` / `gitlab` only.

## `local>` presets

A config that extends `local>owner/repo:preset` (or the bare `owner/repo:preset` spelling, which Renovate treats as `local>`) only resolves when there's a platform context to expand it against:

- **For `dry_run`** — a local run flattens them with Renovate's own resolver into a temporary copy of the repository and runs there. The route comes from the origin remote, or from the `presetPlatform` input; a self-hosted host also needs `endpoint` (or `RENOVATE_PLATFORM` + `RENOVATE_ENDPOINT`, which also name the platform of a host such as `git.example.com` whose name does not show it). The fetches carry an env token only when the route is the env home or a public host, or a `RENOVATE_MCP_HOST_TOKENS` entry covers it. With the worked example above, a local `dry_run` of a gitlab.example.com checkout only needs `platform: "local"` (the example's `RENOVATE_PLATFORM=gitlab` otherwise makes it a remote run). Alternatively pass `platform` + `endpoint` + `repository` for a remote run. Bitbucket local presets are not flattened. See [`dry_run` — local presets in local mode](tools.md#dry_run).
- **For `resolve_config`** — set `RENOVATE_PLATFORM` + `RENOVATE_ENDPOINT`, or pass `platform` (`github`, `gitlab`, `gitea`, `forgejo`, or `bitbucket`) + `endpoint` as inputs (a token then only from a host-token entry), and the tool rewrites `local>` into `<platform>>` and fetches it from the endpoint over HTTPS, at every nesting depth (a `local>` inside a fetched preset routes the same way, as in Renovate). Bare `owner/repo` entries are rewritten the same way; scoped npm presets (`@scope/pkg`) stay unresolved, and relative (`./foo`) and `http(s)://` URL presets land in `presetsUnresolved` with a pointer at `dry_run`. `endpoint` routes only `local>`: a `gitlab>` entry next to it still goes to gitlab.com. Without `platform`, `local>` stays in `presetsUnresolved` with a pointer to the workaround. `platform: "bitbucket"` is the only way to reach Bitbucket Cloud presets, since Renovate has no `bitbucket>` prefix. Run `dry_run` afterwards for full-fidelity merging.

## Tokens for other hosts — `RENOVATE_MCP_HOST_TOKENS`

When a preset host is neither the env home nor a platform's public host — a second self-hosted GitLab, or an endpoint you pass per call — name its token in `RENOVATE_MCP_HOST_TOKENS`. The variable holds references, never values:

```jsonc
"env": {
  "RENOVATE_MCP_HOST_TOKENS": "[{\"matchHost\":\"gitlab.example.com\",\"hostType\":\"gitlab\",\"tokenEnv\":\"ACME_GITLAB_TOKEN\"}]",
  "ACME_GITLAB_TOKEN": "<your token>"
}
```

An entry wins over the per-platform token on its host. A malformed value makes every fetch-enabled call fail with an error naming the bad entry. See [Security & secrets — token resolution](security.md#token-resolution).

## Private-registry credentials for `dry_run`

For private registries (npm, Docker, Composer, …), Renovate needs whatever it would normally need at lookup time:

- `COMPOSER_AUTH`
- `NPM_TOKEN` / `.npmrc`
- Docker registry creds
- A `RENOVATE_HOST_RULES` JSON blob

Alternatively encode these as `hostRules` in the Renovate config, or pass them per-call via the `hostRules` input on `dry_run` (no MCP restart needed). Per-call `hostRules` are appended to whatever the repo's own config declares.

Values passed inline reach Renovate as JSON through the tool-call transport, so the calling LLM sees them in its context — **prefer the env route if that matters**. See [Security & secrets — inline secrets](security.md#inline-secrets-in-the-transcript).

Without any of these, Renovate's lookup often returns 0 updates silently; `dry_run` scans its logs for auth failures and surfaces them under `problems`.
