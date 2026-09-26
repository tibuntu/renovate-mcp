# Development

Build, test, and CI plumbing. The [README](../README.md) lists the npm scripts; this file covers the surrounding machinery.

## Snapshot files

The four `src/data/*.generated.ts` files are committed snapshots of Renovate's built-in presets, manager registry, config option registry, and renamed-property map:

- `src/data/presets.generated.ts` — preset catalogue
- `src/data/managers.generated.ts` — valid manager names for `lint_config`'s `matchManagers-unknown-name` rule, and for the `renovate://managers` resource
- `src/data/migrations.generated.ts` — deprecated-key rename map for `lint_config`'s `deprecated-key` rule
- `src/data/options.generated.ts` — config option definitions for the `renovate://options` / `renovate://option/{name}` resources

The main server process never imports the `renovate` package at runtime — only the build-time `scripts/generate-*.mjs` scripts do. The three `*WorkerImpl.ts` workers (migration, config merge, packageRules) are the narrow, documented exception: they import `renovate` library exports inside an isolated `worker_threads` worker, never from the main process — see CLAUDE.md's worker-isolation carve-outs. All four generated files are wired into a `postUpgradeTasks` block in this repo's `renovate.json` so a Renovate dependency bump auto-regenerates them on the bot's branch: `npm ci`, `npm run sync:jsonata-pin` (syncs the `jsonata` pin to Renovate's own), `npm install`, then the four `npm run generate:*` commands — assuming the operator's `RENOVATE_ALLOWED_POST_UPGRADE_COMMANDS` permits all of them; regenerate manually otherwise.

`npm run check:snapshot-versions` (also run in CI) compares the embedded version against `node_modules/renovate/package.json#version` and fails fast naming the stale file(s) and the `npm run generate:*` command to fix them. `npm run sync:jsonata-pin` keeps the `jsonata` dependency pin in `package.json` matching Renovate's own pin (see CLAUDE.md's JSONata worker-isolation note).

## Release flow

Releases are driven by [Conventional Commits](https://www.conventionalcommits.org/) and [release-please](https://github.com/googleapis/release-please):

1. Commits to `main` use Conventional Commit prefixes (`feat:`, `fix:`, `chore:`, …).
2. `.github/workflows/release.yaml` runs `release-please` on every push to `main`. It opens/updates a release PR that bumps the version and rewrites `CHANGELOG.md` from those prefixes. The PR is opened with the `RELEASE_PLEASE_TOKEN` PAT rather than the default `GITHUB_TOKEN`, because a `GITHUB_TOKEN`-authored PR would not trigger `ci.yml`'s `pull_request` event — leaving the PR permanently blocked by the required `build-test` check.
3. Merging the release PR makes release-please tag the release and publish a GitHub Release.
4. The same workflow's `dispatch-publish` job then runs `gh workflow run publish.yml --ref <tag>` — a `workflow_dispatch` trigger rather than `release: published`, so npm's trusted-publisher OIDC check binds its `workflow_ref` claim to `publish.yml` itself (calling it as a reusable `workflow_call` would shift that claim to `release.yaml` and break the OIDC match). `dispatch-publish` intentionally uses the plain `GITHUB_TOKEN`, not the release-please PAT — the two tokens are not interchangeable here.
5. `publish.yml` checks out the tag, runs `typecheck` / `build` / `test`, then smoke-tests the actual artifact: `npm pack`, a global install of the resulting tarball, and `node scripts/smoke-test-tarball.mjs` (verifies the installed `renovate-mcp` binary answers an MCP `initialize` request) — catching `files` / `bin` / shebang / startup regressions the in-tree tests can't see. Finally `npm publish` runs with OIDC provenance (`id-token: write`; requires npm ≥ 11.5.1 for Trusted Publishers).

Node version for every workflow above comes from `.nvmrc` (currently 24) via `actions/setup-node`'s `node-version-file` input, rather than being hardcoded per workflow.

## CI workflows

**Per-PR CI** (`.github/workflows/ci.yml`) runs `typecheck`, `build`, and `test:coverage` on the `.nvmrc`-pinned Node version for every PR and push to `main`, across an OS matrix of `ubuntu-latest` and `macos-latest` with `fail-fast: false` so a platform-specific regression on either side surfaces. Coverage is uploaded as a per-run artifact from the Ubuntu job only (to avoid name collisions). `vitest.config.ts` enforces regression-floor coverage thresholds (statements / branches / functions / lines) via the v8 provider; files that are only exercised out-of-process — `src/index.ts`, `src/tools/**`, `src/prompts/**`, `src/resources/**`, `src/lib/*WorkerImpl.ts`, and `src/data/**` — are excluded from the measurement, since the integration tests that exercise them run in a separately spawned process the in-process v8 instrumentation can't see. A `gate` job skips the post-merge re-run on a push to `main` when that commit already arrived via a merged PR (the required `build-test` check already ran and passed there); a direct push to `main` still runs the full job. The Ubuntu job also re-runs `npm install --package-lock-only` and fails on a non-empty diff, catching drift between `package.json` root metadata (`os`, `engines`, `bin`, dep ranges) and `package-lock.json` that `npm ci` does not validate. The `build-test (ubuntu-latest)` / `build-test (macos-latest)` jobs are **required status checks** on `main`, but `ci.yml` skips them for PRs that only touch docs / non-build files (its `paths-ignore` list).

**Real-validator coverage** (`test/integration/realValidator.test.ts`, part of the same `test:coverage` run above) exercises the actual bundled `renovate-config-validator` binary — no `RENOVATE_CONFIG_VALIDATOR_BIN` fake — invoked with `--no-global`, the same flag `validate_config` / `write_config` pass in production. This closes the gap the fake-binary integration tests can't see: a real-validator-only regression (e.g. a CLI flag it no longer accepts) now fails per-PR instead of only surfacing on the nightly `renovate@latest` run.

**Required-check bypass** (`.github/workflows/ci-required-bypass.yml`) closes the gap that skip creates: a required check that is never reported leaves a PR permanently blocked (this is what stranded Renovate PRs that only bump a path-ignored workflow file). The companion workflow has the same `build-test` job name and OS matrix as `ci.yml` — so it reports identical check contexts — but as instant no-ops, and its `paths` filter is the exact inverse of `ci.yml`'s `paths-ignore`. The two lists must be kept in sync: any pattern added to `ci.yml`'s `paths-ignore` must also be added to this workflow's `paths`.

**Nightly upstream-drift check** (`.github/workflows/nightly-real-renovate.yml`) runs daily at 04:17 UTC, installs `renovate@latest` on top of `npm ci`, and re-runs the full suite. Failures notify the maintainer by email and do not gate per-PR CI.

**Dependency review** (`.github/workflows/dependency-review.yml`) runs [`actions/dependency-review-action`](https://github.com/actions/dependency-review-action) on every PR and fails the check when a newly introduced dependency carries a CVE of `high` severity or above. Findings also render inline in the PR's "Files changed" / Conversation tabs.

**Maintainer tooling** (`.github/workflows/claude.yml`) lets the repo owner trigger [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) by mentioning `@claude` in an issue, comment, or review. Gated on `sender.login == repository_owner`, so mentions from anyone else are ignored. Needs the `CLAUDE_CODE_OAUTH_TOKEN` secret on the repo; outside contributors and forks do not need any Anthropic credentials to work on this project. `.github/workflows/claude-code-review.yml` is a manual (`workflow_dispatch`) run that takes a PR number and runs the `code-review` plugin against that PR, using the same secret.

## Integration testing

Integration tests spawn the built `dist/index.js` as a real child process and speak JSON-RPC over stdio. For code that shells out to Renovate, the tests generate executable Node scripts at runtime and point `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` at them. See [Architecture — Integration testing](architecture.md#integration-testing--real-spawn-fake-binaries) for the rationale.
