# Roadmap

`renovate-mcp`'s original v1 roadmap (the early tracked GitHub issues: `resolve_config`, tests/CI, setup diagnostics, a custom-manager authoring helper, the full preset catalogue, npm publishing) is complete — every one of those tools ships today. Every item below that has been triaged links to its [GitHub issue](https://github.com/tibuntu/renovate-mcp/issues); the one other open issue is Renovate's own auto-generated Dependency Dashboard notice on this repo, which isn't a `renovate-mcp` feature request.

This page is the durable public summary of what's next. The maintainer keeps a more detailed working roadmap locally that isn't part of this repository; treat silence on an idea as "not yet triaged", not "rejected" — pick an item below, or open a new [GitHub issue](https://github.com/tibuntu/renovate-mcp/issues), if you're looking for something to work on. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) before starting.

## Carry-over candidates

Smaller items surfaced during recent work that haven't been scheduled yet:

- **Multi-version nightly matrix.** The nightly workflow already re-runs the full test suite against `renovate@latest` daily; testing against more than one Renovate version per run remains unpursued.
- **More snapshot-drift guards for hand-maintained allow-lists.** `PACKAGE_RULE_ACTION_KEYS` and `LATER_TEXT_ANCHOR_TOKENS` (both used by the `invalid-schedule` / `package-rule-without-action` lint rules) don't yet have a drift sentinel comparing them against Renovate's own schema, unlike `suggest_presets`'s facet taxonomy. `SKIP_HINTS` in the dependency-explainer library is a newer hand-maintained map with the same gap. Tracked in [#420](https://github.com/tibuntu/renovate-mcp/issues/420).
- **Worker cold-start flakiness under parallel test load.** The `annotate_dry_run` / `test_package_rules` integration tests have occasionally hit their spawn timeout when the full suite runs in parallel (they pass in isolation and on retry). A worker warm-up step or a longer first-spawn timeout would remove the flake. Tracked in [#421](https://github.com/tibuntu/renovate-mcp/issues/421).

## Vetted expansion backlog

- **Broader external preset support.** `bitbucket>`, `gitea>`, and npm preset sources currently land in `presetsUnresolved` rather than resolving. `github>` / `gitlab>` are supported today; `local>` is partly handled — see [Platform setup — `local>` presets](platform-setup.md#local-presets). Tracked in [#419](https://github.com/tibuntu/renovate-mcp/issues/419).
- **An `explain_schedule` tool.** `invalid-schedule` only answers "does this parse?". An offline tool that takes a `schedule` and an optional `timezone` and returns the next run windows would answer "when will this actually run?". Tracked in [#417](https://github.com/tibuntu/renovate-mcp/issues/417).
- **Rendered templates in `test_package_rules`.** Show the effective `branchName`, `commitMessage`, `prTitle` and `groupName` rendered for the hypothetical dependency, so template tuning doesn't need a `dry_run`. Tracked in [#418](https://github.com/tibuntu/renovate-mcp/issues/418).

## Parked (deliberately not planned)

- **Per-rule lint suppression** for `lint_config` findings.
- **Full Handlebars templating** (helpers, conditionals) in `preview_custom_manager` — it implements positional `{{argN}}` / `{{groupName}}` substitution only, by design; see [`docs/tools.md`](tools.md#preview_custom_manager).
- **A `preset-order-shadowing` lint rule.** Flagging a later `extends` entry that silently overrides an earlier one's fields is a real footgun, but detecting it needs preset expansion inside the linter, which would break `lint_config`'s pure/offline design. `explain_config` already exposes this provenance today.
