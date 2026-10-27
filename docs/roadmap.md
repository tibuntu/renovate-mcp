# Roadmap

`renovate-mcp`'s original v1 roadmap (the early tracked GitHub issues: `resolve_config`, tests/CI, setup diagnostics, a custom-manager authoring helper, the full preset catalogue, npm publishing) is complete — every one of those tools ships today. Every item below that has been triaged links to its [GitHub issue](https://github.com/tibuntu/renovate-mcp/issues); the one other open issue is Renovate's own auto-generated Dependency Dashboard notice on this repo, which isn't a `renovate-mcp` feature request.

This page is the durable public summary of what's next. The maintainer keeps a more detailed working roadmap locally that isn't part of this repository; treat silence on an idea as "not yet triaged", not "rejected" — pick an item below, or open a new [GitHub issue](https://github.com/tibuntu/renovate-mcp/issues), if you're looking for something to work on. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) before starting.

## Carry-over candidates

Smaller items surfaced during recent work that haven't been scheduled yet:

- **Multi-version nightly matrix.** The nightly workflow already re-runs the full test suite against `renovate@latest` daily; testing against more than one Renovate version per run remains unpursued.

## Parked (deliberately not planned)

- **Per-rule lint suppression** for `lint_config` findings.
- **npm-hosted presets in `resolve_config`.** They would need a registry fetch plus tarball extraction, and `dry_run` already resolves them through the Renovate CLI. Every git-hosted source is covered: `github>` / `gitlab>` / `gitea>` / `forgejo>` directly, Bitbucket Cloud through `local>` + `platform: "bitbucket"` — see [#419](https://github.com/tibuntu/renovate-mcp/issues/419).
- **Full Handlebars templating** (helpers, conditionals) in `preview_custom_manager` — it implements positional `{{argN}}` / `{{groupName}}` substitution only, by design; see [`docs/tools.md`](tools.md#preview_custom_manager).
- **A `preset-order-shadowing` lint rule.** Flagging a later `extends` entry that silently overrides an earlier one's fields is a real footgun, but detecting it needs preset expansion inside the linter, which would break `lint_config`'s pure/offline design. `explain_config` already exposes this provenance today.
