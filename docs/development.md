# Development

Build, test, and CI plumbing. The [README](../README.md) lists the npm scripts; this file covers the surrounding machinery.

## Snapshot files

The three `src/data/*.generated.ts` files are committed snapshots of Renovate's built-in presets, manager registry, and renamed-property map:

- `src/data/presets.generated.ts` — preset catalogue
- `src/data/managers.generated.ts` — valid manager names for `lint_config`'s `matchManagers-unknown-name` rule
- `src/data/migrations.generated.ts` — deprecated-key rename map for `lint_config`'s `deprecated-key` rule

Runtime code never imports the `renovate` package — only the `scripts/generate-*.mjs` scripts do. All three are wired into a `postUpgradeTasks` block in this repo's `renovate.json` so a Renovate bump auto-regenerates them on the bot's branch (assuming the operator's `RENOVATE_ALLOWED_POST_UPGRADE_COMMANDS` permits `npm ci` and the three `npm run generate:*` commands); regenerate manually otherwise.

`npm run check:snapshot-versions` (also run in CI) compares the embedded version against `node_modules/renovate/package.json#version` and fails fast naming the stale file(s) and the `npm run generate:*` command to fix them.

## CI workflows

**Per-PR CI** (`.github/workflows/ci.yml`) runs `typecheck`, `build`, and `test:coverage` on Node 24 for every PR and push to `main`, across an OS matrix of `ubuntu-latest` and `macos-latest` with `fail-fast: false` so a platform-specific regression on either side surfaces. Coverage is uploaded as a per-run artifact from the Ubuntu job only (to avoid name collisions); no threshold is enforced yet. The Ubuntu job also re-runs `npm install --package-lock-only` and fails on a non-empty diff, catching drift between `package.json` root metadata (`os`, `engines`, `bin`, dep ranges) and `package-lock.json` that `npm ci` does not validate. The `build-test (ubuntu-latest)` / `build-test (macos-latest)` jobs are **required status checks** on `main`, but `ci.yml` skips them for PRs that only touch docs / non-build files (its `paths-ignore` list).

**Required-check bypass** (`.github/workflows/ci-required-bypass.yml`) closes the gap that skip creates: a required check that is never reported leaves a PR permanently blocked (this is what stranded Renovate PRs that only bump a path-ignored workflow file). The companion workflow has the same `build-test` job name and OS matrix as `ci.yml` — so it reports identical check contexts — but as instant no-ops, and its `paths` filter is the exact inverse of `ci.yml`'s `paths-ignore`. The two lists must be kept in sync: any pattern added to `ci.yml`'s `paths-ignore` must also be added to this workflow's `paths`.

**Nightly upstream-drift check** (`.github/workflows/nightly-real-renovate.yml`) runs daily at 04:17 UTC, installs `renovate@latest` on top of `npm ci`, and re-runs the full suite. Failures notify the maintainer by email and do not gate per-PR CI.

**Dependency review** (`.github/workflows/dependency-review.yml`) runs [`actions/dependency-review-action`](https://github.com/actions/dependency-review-action) on every PR and fails the check when a newly introduced dependency carries a CVE of `high` severity or above. Findings also render inline in the PR's "Files changed" / Conversation tabs.

**Maintainer tooling** (`.github/workflows/claude.yml`) lets the repo owner trigger [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) by mentioning `@claude` in an issue, comment, or review. Gated on `sender.login == repository_owner`, so mentions from anyone else are ignored. Needs the `CLAUDE_CODE_OAUTH_TOKEN` secret on the repo; outside contributors and forks do not need any Anthropic credentials to work on this project.

## Integration testing

Integration tests spawn the built `dist/index.js` as a real child process and speak JSON-RPC over stdio. For code that shells out to Renovate, the tests generate executable Node scripts at runtime and point `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` at them. See [Architecture — Integration testing](architecture.md#integration-testing--real-spawn-fake-binaries) for the rationale.
