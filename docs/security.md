# Security & secrets

How `renovate-mcp` handles tokens, where to put them, and the validation it applies to outbound URLs.

## Where env vars must live

**MCP servers do NOT inherit your shell env.** Tokens (and every other env var — `COMPOSER_AUTH`, `RENOVATE_HOST_RULES`, `RENOVATE_PLATFORM`, …) must be set via the `env` key in `claude_desktop_config.json` / `.mcp.json`, not your shell. The MCP server runs as a child of the client; exporting `GITLAB_TOKEN` in your terminal does not reach it.

This is the single most common setup mistake. If `dry_run` returns 0 updates silently or `resolve_config` refuses to fetch a private preset, check this first.

## Token resolution

**Env-var auth is the preferred path, and every token is bound to a host** (ADR-0008, `src/lib/hostTokens.ts`). A request never carries a token that belongs to another platform.

**Preset fetching** (`resolve_config`, `explain_config`, `resolve_config_diff`, `test_package_rules`, `annotate_dry_run`, `explain_paths` with `externalPresets: true`) builds the same host rule list `dry_run` hands to Renovate, then picks the token for a request to host H of platform P the way Renovate's own host-rule lookup does:

1. One rule per platform: `<P>_TOKEN` (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITEA_TOKEN`, `FORGEJO_TOKEN`, `BITBUCKET_TOKEN`) on P's bound host — the `RENOVATE_ENDPOINT` host when `RENOVATE_PLATFORM` is P, otherwise P's public host (github.com, gitlab.com, gitea.com, code.forgejo.org, bitbucket.org; subdomains such as api.github.com included, look-alikes such as `evilgitlab.com`, `gitlab.com.evil.example` or `gitlab.com.` not). On the home platform's rule `RENOVATE_TOKEN` comes first, as in Renovate, which uses `RENOVATE_TOKEN` for its platform rule and deletes `GITLAB_TOKEN` and friends from its env; `<P>_TOKEN` is the fallback there.
2. Then one rule per `RENOVATE_MCP_HOST_TOKENS` entry.
3. Last, `GITHUB_COM_TOKEN` on github.com, where Renovate itself appends it.

Of the rules with hostType P whose host matches H and whose variable is set, the one with the longest `matchHost` wins, and the later one on a tie. So a host-token entry beats the platform token for the same host, `GITHUB_COM_TOKEN` beats `GITHUB_TOKEN` on github.com, and an entry for `api.github.com` beats `GITHUB_COM_TOKEN` there.

The **home** comes from the server env only: `RENOVATE_PLATFORM` (a hosted platform) and `RENOVATE_ENDPOINT`. Without a hosted `RENOVATE_PLATFORM` there is no home: nothing defaults to github, and `RENOVATE_TOKEN` is not sent anywhere. A `RENOVATE_PLATFORM` that is not a hosted platform (`local`, `azure`, …) leaves no home either.

**Call inputs and repository content never bind a token.** A tool's `platform` / `endpoint` input, `dry_run`'s `presetPlatform`, and the platform `dry_run` derives from the repo's origin remote decide where requests go (`local>` routing), never which env token they carry. The threat is a call steered by a prompt injection, or an untrusted repository whose `.git/config` names some host: if routing could move a token, either could send `RENOVATE_TOKEN` or `GITLAB_TOKEN` to a host of its choosing. So a `local>` preset routed to a host that only the call or the origin names is fetched without an env token, unless a `RENOVATE_MCP_HOST_TOKENS` entry covers that host. A self-hosted endpoint used per call needs `RENOVATE_PLATFORM` + `RENOVATE_ENDPOINT` on the server, or a host-token entry.

This reverses two earlier rules. `RENOVATE_TOKEN` no longer wins for every platform: a GitHub token set as `RENOVATE_TOKEN` is not sent to gitlab.com. And a `platform` / `endpoint` on the call no longer makes its host the token home. An auth failure names the variables it tried, or says that no token is bound to the host.

**`RENOVATE_MCP_HOST_TOKENS`** covers the hosts the rules above don't: a JSON array of `{"matchHost", "hostType", "tokenEnv"}` objects. `tokenEnv` names *another* env var that holds the token, so no secret is written into this variable:

```json
[{ "matchHost": "gitlab.example.com", "hostType": "gitlab", "tokenEnv": "ACME_GITLAB_TOKEN" }]
```

`matchHost` is a bare lowercase host (subdomains match too, as in Renovate) or an `https://` URL prefix without credentials; `hostType` is a lowercase Renovate host type; `tokenEnv` is a variable name. At most 256 entries; every entry must have exactly these three keys. One malformed entry rejects the whole variable, and every fetch-enabled call then returns `isError` instead of fetching. The error names the entry index and field, never the value. An entry whose `tokenEnv` is unset is skipped.

**`dry_run`** applies the same binding to the Renovate it spawns. Renovate reads only `RENOVATE_TOKEN` as its platform token and deletes `GITHUB_TOKEN` / `GITLAB_TOKEN` / `BITBUCKET_TOKEN` from its env, so:

- On a remote run (`platform: github` / `gitlab`) the API host is `endpoint`, else `RENOVATE_ENDPOINT` when it belongs to that platform, else the public API. The `token` input, else the token the list above picks for the API host (`GITHUB_COM_TOKEN` left out), is exported as `RENOVATE_TOKEN`. No such token → `isError` before spawning; an `endpoint` that only the call names therefore needs a host-token entry or the `token` input.
- Under `platform=local` the child gets no `RENOVATE_TOKEN`: an inherited one is removed from the child env, because Renovate's platform rule there has hostType `local` and no host. `RENOVATE_TOKEN` still reaches Renovate as the host rule on the env home host, never on the route of flattened local presets unless that route is the env home.
- The rule list above (without `GITHUB_COM_TOKEN`, which Renovate turns into its own rule from env) is written into a temp config as `hostRules`, ahead of any per-call `hostRules`. With an operator `RENOVATE_CONFIG_FILE`, it travels in `RENOVATE_ADDITIONAL_CONFIG_FILE` instead; with both set it is skipped with a warning.

Renovate's own `<HOSTTYPE>_<HOST>_TOKEN` style variables (for example `NPM_REGISTRY_EXAMPLE_COM_TOKEN`) still reach the child, but Renovate only reads them when `RENOVATE_DETECT_HOST_RULES_FROM_ENV=true` is also set on the MCP server.

Gitea / Forgejo tokens go out as `Authorization: Bearer …`; Bitbucket tokens as HTTP Basic auth under the `x-token-auth` pseudo-user (Atlassian API tokens starting with `ATAT` under `x-bitbucket-api-token-auth`), mirroring the Bitbucket platform in Renovate itself.

## Other env vars the server reads

- `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` — override which `renovate` / `renovate-config-validator` binary `validate_config`, `dry_run`, and `write_config` spawn. When set, the override always wins over the bundled binary (see CLAUDE.md's shell-out design).
- `RENOVATE_MCP_REQUIRE_CLI=false` — suppresses the startup "partial availability" banner for users who only intend to use the offline tools.
- `RENOVATE_ENDPOINT` — with `RENOVATE_PLATFORM`, the home host that `RENOVATE_TOKEN` (and the home platform's own token) is bound to. Also read by `check_setup` (when called with a `repoPath`) as one step in its endpoint-probe precedence, and by `dry_run` and the `resolve_config` family as the routing fallback when the `endpoint` input is unset — but only when the call's `platform` input is unset or equals `RENOVATE_PLATFORM`; otherwise it is ignored for routing and `dry_run` removes it from the child's environment. See [Platform setup](platform-setup.md).
- `RENOVATE_PLATFORM` — the home platform for token binding, whatever a call passes, and `dry_run`'s platform fallback.
- `RENOVATE_MCP_HOST_TOKENS` — extra host-scoped tokens by reference, see [Token resolution](#token-resolution).
- `RENOVATE_CONFIG_FILE` / `RENOVATE_ADDITIONAL_CONFIG_FILE` — when the operator sets them, `dry_run` passes them through untouched and puts its host-rules file in whichever is free; with both set it skips the env-token rules (warning) and refuses per-call `hostRules`.
- `RENOVATE_BASE_BRANCH_PATTERNS` — set (JSON-encoded) on the Renovate child spawned by `dry_run` when `baseBranches` is passed, since `baseBranchPatterns` is `cli:false` in Renovate and has no CLI flag.

### Test/debug hooks — never set these in production

`RENOVATE_MCP_MIGRATION_WORKER_ENTRY`, `RENOVATE_MCP_MERGE_WORKER_ENTRY`, `RENOVATE_MCP_PACKAGE_RULES_WORKER_ENTRY`, `RENOVATE_MCP_SCHEDULE_WORKER_ENTRY`, and `RENOVATE_MCP_PRESET_FLATTEN_WORKER_ENTRY` redirect which compiled worker file `migrate_config`, `resolve_config`/`explain_config`, `test_package_rules`/`annotate_dry_run`/`explain_dependency`, `explain_schedule`, and `dry_run`'s local-preset flattening spawn, respectively. The flattening worker receives the env tokens as host rules, so redirecting it hands them to whatever file it names. The test suite points them at the compiled `dist/lib/*WorkerImpl.js` files so vitest's TS-source worker entry (which has no sibling `.js` until after a build) still resolves. Because they redirect which code actually executes, treat them like any other code-injection vector — never set them outside the test suite.

### `GITHUB_COM_TOKEN` — a separate role

`GITHUB_COM_TOKEN` authenticates Renovate's **github.com datasource** lookups (release notes, `github-tags` / `github-releases` / `github-actions`) — distinct from the **platform** token above, which authenticates "where Renovate runs" (reading the repo, opening PRs). It is **never auto-derived** from `GITHUB_TOKEN` / `RENOVATE_TOKEN`: the platform token may be a GitHub Enterprise, GitLab, or otherwise-scoped credential, and silently forwarding it to an external host (github.com) is a credential-leak path we refuse to take.

This matters most under the **default `dry_run` `platform: local`** (and on GHE/GitLab platforms): the platform token is *not* applied to github.com datasource requests, so those lookups run anonymously (low rate limit, possible `skipReason`) unless you set `GITHUB_COM_TOKEN`. When `platform: "github"` is used against github.com, Renovate registers the platform token as the github.com host rule automatically, so `GITHUB_COM_TOKEN` is redundant there. `check_setup` surfaces this gap as a hint when a github.com-origin repo would be dry-run as `local` without `GITHUB_COM_TOKEN`. `GITHUB_COM_TOKEN` (and any other env var) is forwarded verbatim to the spawned Renovate CLI — set it in the MCP server's `env`. A read-only PAT is sufficient.

See [Platform setup](platform-setup.md) for the full env-var matrix per platform.

## Inline secrets in the transcript

Anything passed as a tool input — `token`, `hostRules[].token`, `hostRules[].password` — is stored in the MCP transcript that the client may share, replay, or feed back into the LLM. Prefer env vars.

`dry_run` detects inline `token` / `hostRules[].token` on its input and appends a single advisory entry to the result `warnings` array steering callers toward env-var auth. The warning is advisory only — it does not change `isError`, does not block the spawn, and does not alter the report shape. (`password`-only host rules are not yet covered by the warning; the locked trigger is `token`-only.)

This warning is `dry_run`-only: it is the only tool that accepts inline tokens. The preset-fetching tools read tokens from env vars only.

## Endpoint validation

The `endpoint` input on `resolve_config` / `explain_config` / `dry_run` is validated before any token-bearing request is built or forwarded to the Renovate child as `--endpoint=`. The check is string-level (no DNS) — the goal is to make a prompt-injected `endpoint` value unable to coerce a token-bearing request to an attacker-controlled or internal-only address.

Anything that isn't an `https://` URL with a non-empty public host is refused:

- Non-https schemes (`http:`, `file:`, `data:`, …)
- Userinfo (`user:pass@host`)
- Any RFC 1918 / loopback / link-local literal: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (incl. cloud-metadata), `0.0.0.0/8`, `::1`, `::`, `::ffff:*`, `fc00::/7`, `fe80::/10`

Self-hosted GitHub Enterprise / GitLab / Gitea / Forgejo on public-DNS https URLs is unaffected.

## Redirects and auth headers

External preset fetches refuse to follow HTTP redirects (`redirect: "manual"`) and never attach `Authorization: Bearer …` / `Authorization: Basic …` / `PRIVATE-TOKEN: …` headers to non-`https://` URLs.

Following redirects with custom auth headers can leak `RENOVATE_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` / `FORGEJO_TOKEN` / `BITBUCKET_TOKEN` cross-host (undici only strips the standard `Authorization` header on cross-*origin* redirects, not `PRIVATE-TOKEN`); rejecting them outright avoids the leak path and matches the fact that the GitHub / GitLab / Gitea / Bitbucket content APIs do not normally redirect for valid presets.

## Preset path validation

External preset fetches validate the parts of a preset string that become URL path segments before any request (and so before any credential is attached): the repository/project path, the preset file path (`:presetName` / `//subpath`) and, for Bitbucket where it is a path segment, the `#ref`. Empty, `.` and `..` segments are rejected, and repository paths must be exactly `owner/repo` on GitHub, Gitea, Forgejo and Bitbucket (GitLab allows nested groups but still needs a namespace). The values are then percent-encoded: per segment on GitHub, Gitea, Forgejo and Bitbucket, and as a single escaped component on GitLab.

Without this, URL normalisation would collapse dot segments, so a hostile config in the inspected repository could reference e.g. `github>a/../../user?` and make the server issue an authenticated `GET https://api.github.com/user` and surface the response as a preset body.

This does not stop a config from naming any JSON file in any repository the token can read (e.g. `github>some-org/private-repo//any/file.json`) — that is Renovate's own preset semantics — so only enable `externalPresets` for configs you trust, with a token scoped to what those presets need.

## Response body caps

External preset fetches cap the response body at 1 MB. A `Content-Length` over the cap is rejected up front; chunked responses without a declared length are streamed into a bounded buffer that aborts the read once the running total passes the cap. Auth-failure bodies (401/403) are read with an 8 KB cap so a misconfigured endpoint returning a giant HTML error page can't OOM the long-lived MCP process. Preset bodies are tiny in practice, so the cap is well above any legitimate value.

## On-disk artifacts during `dry_run`

`dry_run` uses `--report-type=file` so we get a structured JSON report instead of scraping stdout. The report path is pre-created with mode 0600 before Renovate is spawned (Renovate overwrites in place with `O_TRUNC`, preserving the mode), so the on-disk JSON is never world-readable while the run is in flight — Renovate's `problems` array can carry host-rule values that we don't want exposed under the default `umask`. The file is unlinked in a `finally` block.

Host rules — the env-token rules on most runs, plus any `hostRules` input — are written to a temp file created with `O_EXCL` and mode 0600 inside a fresh mode-0700 `mkdtemp` directory under `os.tmpdir()`, so no other local user can read it or plant a file at its path. It is handed to Renovate via the `RENOVATE_CONFIG_FILE` env var (or `RENOVATE_ADDITIONAL_CONFIG_FILE` when the operator already uses the first; the CLI has no `--config-file` flag), and the directory is removed in a `finally` block. A process killed hard (SIGKILL, power loss) can leave it behind, holding the tokens in clear.

When a local run flattens local presets ([ADR-0009](adrs/0009-dry-run-local-preset-flattening.md)), the repository is copied into a fresh mode-0700 `mkdtemp` directory (`renovate-mcp-dryrun-*`) under `os.tmpdir()`, and the copy is removed in a `finally` block, on refusals and failures too. The original is only read. The copy skips files whose directory resolves outside the repository and relative symlinks that point outside it, each with a warning. An absolute symlink into the repository is rewritten as a relative link to the same place inside the copy, so the run never reads from or reaches back into `repoPath` through it. Absolute symlinks to places outside the repository are recreated as they are: Renovate under `platform=local` forces `dryRun=lookup` and writes no artifacts, so such a link can make it read a file outside the repository, as it would in `repoPath` itself. The flattened config is only written when its directory resolves inside the copy, and the existing file is unlinked first, so a symlinked config is replaced in the copy and its target is never written. The child gets `GIT_CEILING_DIRECTORIES` set to the copy's parent, so a temp directory inside a git checkout cannot hand Renovate the enclosing repository's file list. A process killed hard can leave the copy behind; it holds the repository's tracked files and the flattened config, not tokens.

The preset fetches of the flattening run in a worker thread inside the server process, with the same host rules the spawned Renovate gets: the env-token rules, the per-call `hostRules`, and `GITHUB_COM_TOKEN` for github.com. Nothing of that is written to disk beyond the host-rules file described above.

Token/password values — including the platform `token` input, every env token written as a host rule, and `GITHUB_COM_TOKEN` — are scrubbed from the detected `problems` list, the `logTail` fallback, progress messages, and every string of the structured report (so the inline `report`, `reportErrors` and a file written to `reportOutputPath` too) before returning.
