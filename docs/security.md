# Security & secrets

How `renovate-mcp` handles tokens, where to put them, and the validation it applies to outbound URLs.

## Where env vars must live

**MCP servers do NOT inherit your shell env.** Tokens (and every other env var — `COMPOSER_AUTH`, `RENOVATE_HOST_RULES`, `RENOVATE_PLATFORM`, …) must be set via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell. The MCP server runs as a child of the client; exporting `GITLAB_TOKEN` in your terminal does not reach it.

This is the single most common setup mistake. If `dry_run` returns 0 updates silently or `resolve_config` refuses to fetch a private preset, check this first.

## Token resolution

**Env-var auth is the preferred path.** Precedence is:

1. `RENOVATE_TOKEN` (wins when set)
2. `GITHUB_TOKEN` / `GITLAB_TOKEN` (platform-specific fallback)

For `dry_run`, the platform-specific var is auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI (Renovate itself only reads that one var). `resolve_config` follows the same precedence.

### `GITHUB_COM_TOKEN` — a separate role

`GITHUB_COM_TOKEN` authenticates Renovate's **github.com datasource** lookups (release notes, `github-tags` / `github-releases` / `github-actions`) — distinct from the **platform** token above, which authenticates "where Renovate runs" (reading the repo, opening PRs). It is **never auto-derived** from `GITHUB_TOKEN` / `RENOVATE_TOKEN`: the platform token may be a GitHub Enterprise, GitLab, or otherwise-scoped credential, and silently forwarding it to an external host (github.com) is a credential-leak path we refuse to take.

This matters most under the **default `dry_run` `platform: local`** (and on GHE/GitLab platforms): the platform token is *not* applied to github.com datasource requests, so those lookups run anonymously (low rate limit, possible `skipReason`) unless you set `GITHUB_COM_TOKEN`. When `platform: "github"` is used against github.com, Renovate registers the platform token as the github.com host rule automatically, so `GITHUB_COM_TOKEN` is redundant there. `check_setup` surfaces this gap as a hint when a github.com-origin repo would be dry-run as `local` without `GITHUB_COM_TOKEN`. `GITHUB_COM_TOKEN` (and any other env var) is forwarded verbatim to the spawned Renovate CLI — set it in the MCP server's `env`. A read-only PAT is sufficient.

See [Platform setup](platform-setup.md) for the full env-var matrix per platform.

## Inline secrets in the transcript

Anything passed as a tool input — `token`, `hostRules[].token`, `hostRules[].password` — is stored in the MCP transcript that the client may share, replay, or feed back into the LLM. Prefer env vars.

As of v0.12, `dry_run` detects inline `token` / `hostRules[].token` on its input and appends a single advisory entry to the result `warnings` array steering callers toward env-var auth. The warning is advisory only — it does not change `isError`, does not block the spawn, and does not alter the report shape. (`password`-only host rules are not yet covered by the warning; the locked v0.12 trigger is `token`-only.)

This warning is `dry_run`-only as of v0.12. Other tools that accept inline tokens (e.g. `resolve_config`) follow the same env-var precedence but do not currently emit the warning.

## Endpoint validation

The `endpoint` input on `resolve_config` / `explain_config` / `dry_run` is validated before any token-bearing request is built or forwarded to the Renovate child as `--endpoint=`. The check is string-level (no DNS) — the goal is to make a prompt-injected `endpoint` value unable to coerce a token-bearing request to an attacker-controlled or internal-only address.

Anything that isn't an `https://` URL with a non-empty public host is refused:

- Non-https schemes (`http:`, `file:`, `data:`, …)
- Userinfo (`user:pass@host`)
- Any RFC 1918 / loopback / link-local literal: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (incl. cloud-metadata), `0.0.0.0/8`, `::1`, `::`, `::ffff:*`, `fc00::/7`, `fe80::/10`

Self-hosted GitHub Enterprise / GitLab on public-DNS https URLs is unaffected.

## Redirects and auth headers

External preset fetches refuse to follow HTTP redirects (`redirect: "manual"`) and never attach `Authorization: Bearer …` / `PRIVATE-TOKEN: …` headers to non-`https://` URLs.

Following redirects with custom auth headers can leak `RENOVATE_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN` cross-host (undici only strips the standard `Authorization` header on cross-*origin* redirects, not `PRIVATE-TOKEN`); rejecting them outright avoids the leak path and matches the fact that the GitHub/GitLab content APIs don't normally redirect for valid presets.

## Response body caps

External preset fetches cap the response body at 1 MB. A `Content-Length` over the cap is rejected up front; chunked responses without a declared length are streamed into a bounded buffer that aborts the read once the running total passes the cap. Auth-failure bodies (401/403) are read with an 8 KB cap so a misconfigured endpoint returning a giant HTML error page can't OOM the long-lived MCP process. Preset bodies are tiny in practice, so the cap is well above any legitimate value.

## On-disk artifacts during `dry_run`

`dry_run` uses `--report-type=file` so we get a structured JSON report instead of scraping stdout. The report path is pre-created with mode 0600 before Renovate is spawned (Renovate overwrites in place with `O_TRUNC`, preserving the mode), so the on-disk JSON is never world-readable while the run is in flight — Renovate's `problems` array can carry host-rule values that we don't want exposed under the default `umask`. The file is unlinked in a `finally` block.

When a `hostRules` input is passed it's written to a mode-0600 temp file in `os.tmpdir()`, handed to Renovate via the `RENOVATE_CONFIG_FILE` env var (the CLI has no `--config-file` flag), and deleted in a `finally` block.

Token/password values — including the platform `token` input — are scrubbed from the detected `problems` list and the `logTail` fallback before returning.
