# Tool reference

Detailed reference for every tool and resource exposed by `renovate-mcp`. The [README](../README.md) has a one-line summary table; this file holds the full prose.

## Tools

- [`check_setup`](#check_setup)
- [`get_version`](#get_version)
- [`read_config`](#read_config)
- [`suggest_presets`](#suggest_presets)
- [`resolve_config`](#resolve_config)
- [`explain_config`](#explain_config)
- [`preview_custom_manager`](#preview_custom_manager)
- [`validate_config`](#validate_config)
- [`lint_config`](#lint_config)
- [`dry_run`](#dry_run)
- [`dry_run_diff`](#dry_run_diff)
- [`resolve_config_diff`](#resolve_config_diff)
- [`migrate_config`](#migrate_config)
- [`write_config`](#write_config)

## Resources

- [`renovate://presets`](#renovatepresets)
- [`renovate://presets/{namespace}`](#renovatepresetsnamespace)
- [`renovate://preset/{name}`](#renovatepresetname)

---

## `check_setup`

Report Renovate CLI + validator availability, versions, and install hints. Also runs at server startup.

Surfaces a `platformContext` block with `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` values, token-presence booleans, the platform `dry_run` would pick when its input is unset, and notes about likely misconfigurations — so callers can verify env before invoking `dry_run`. Token values are never echoed; only presence booleans.

Compares the running Node version against the bundled Renovate's declared `engines.node` range and emits an actionable hint when they're incompatible — the same condition Renovate would otherwise log only as `Unsupported node environment` during a `dry_run`.

### Optional `repoPath` — repo-aware diagnosis

Pass an absolute `repoPath` to add a `repoContext` block. Three signals are combined into actionable hints *before* the user runs `dry_run`:

1. **Git origin remote** — read directly from `.git/config` (no `git` spawn). Both SSH (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo`) forms parse; nested GitLab subgroup paths are preserved. The host is classified as `github` (`github.com`), `gitlab` (`gitlab.com`), or `self-hosted` with a best-effort flavor (`github` / `gitlab` / `unknown`).
2. **Repo config endpoint / platform** — uses the same discovery path as [`read_config`](#read_config) to locate `renovate.json` / `renovate.json5` / etc., then pulls top-level `endpoint` and `platform` if present. Mismatches against the origin host land in `repoContext.inconsistencies`.
3. **Endpoint reachability** — best-effort HEAD (fallback GET on 405) against the resolved endpoint. Probe URL precedence: `config.endpoint` → `RENOVATE_ENDPOINT` → defaults derived from origin (`https://api.github.com`, `https://gitlab.com/api/v4/version`). Self-hosted with no configured endpoint deliberately skips the probe — the tool won't guess a path on a private host.

**Security invariant:** every probe URL goes through the same allowlist validator (`https://`-only, no userinfo, no RFC1918 / loopback / link-local / cloud-metadata addresses) used by `dry_run`, `resolve_config`, and `externalPresetFetcher`. Blocked URLs surface as a hint with `skipped: "endpoint-blocked"` and never reach `fetch`. The probe sends no credentials — it's a bare HEAD / GET with no `Authorization` header. See [Security & secrets — endpoint validation](security.md#endpoint-validation).

**Hint synthesis.** Examples of the hints the cross-reference can emit:

- Origin is `github.com` and no `GITHUB_TOKEN` / `RENOVATE_TOKEN` is set → "your github-actions deps will be skipped at `dry_run` time."
- Origin is `github.com` and the default `dry_run` `platform: local` would be used without `GITHUB_COM_TOKEN` → flags that the platform token (even when set) is **not** applied to github.com *datasource* lookups under a local run, and points at the two remedies (set `GITHUB_COM_TOKEN`, or run `platform: "github"`). This reconciles the otherwise-confusing split between `repoContext.effectivePlatform` (origin-derived, can read `github`) and `platformContext.effectiveDryRunPlatform` (what `dry_run` actually defaults to: `local`). See [Security — `GITHUB_COM_TOKEN`](security.md#github_com_token--a-separate-role).
- Origin is `gitlab.example.com` (self-hosted) and no `endpoint` is configured → "set `endpoint` in renovate.json or `RENOVATE_ENDPOINT` in the MCP server's env."
- Origin and `config.endpoint` point at different hosts → recorded under `inconsistencies` (Renovate will use the config endpoint).
- Endpoint probe failed → "If you're behind a VPN/proxy, `dry_run` will fail with the same network error."

Token-presence checks go through the same `credentialResolver` that `dry_run` and `resolve_config` use, so the diagnosis cannot drift from how Renovate actually resolves credentials.

`repoContext` is omitted entirely when `repoPath` is unset, so the startup-time invocation in `src/index.ts` keeps its existing output shape. The new diagnosis never flips `ok` to `false` — that flag remains tied to binary availability.

See also: [Operational notes — `check_setup` bundled-binary fast path](operations.md#check_setup-bundled-binary-fast-path) and [Platform setup](platform-setup.md).

## `get_version`

Report the renovate-mcp server version and whether it's a released build (running from `node_modules`) or a local/dev build (typically launched via `command: node` against a checkout).

## `read_config`

Locate and parse a repo's Renovate config (`renovate.json`, `renovate.json5`, `.renovaterc*`, `package.json#renovate`, …) in priority order, mirroring Renovate's own discovery logic.

## `suggest_presets`

Search Renovate presets by natural-language intent. Offline, native — no `renovate` invocation, no CLI, no network. Bridges the gap between browsing the `renovate://presets` resource family (which addresses presets by a known name/namespace) and authoring a config: here you describe *what you want* and get ranked candidates plus, when useful, a draft.

**Inputs:**

- `query` (required) — the intent, in natural language (e.g. `"automerge patch and minor updates and group my dev dependencies"`).
- `presetsPath` (optional) — absolute path to a local presets repo to index alongside the built-in catalogue. Flat `*.json` / `*.json5` files, one preset per file; name = filename without extension, namespace = `"local"`, description = top-level `description` → first `packageRules[].description` → `null`. Subdirectories are not recursed. Parsed with JSON5 (so `{{argN}}`-parameterized presets index fine); a malformed file becomes a warning, never a crash.
- `namespace` (optional) — restrict matches to one namespace (`config`, `group`, `schedule`, … or `local`).
- `limit` (optional, default 10) — max matches returned per corpus.
- `minScore` (optional, default 0.12) — drop matches scoring below this 0..1 threshold.
- `includeBody` (optional, default false) — inline each matched preset's full body. When false, fetch [`renovate://preset/{name}`](#renovatepresetname) for a body.
- `includeDraft` (optional, default true) — emit the draft skeleton (see below). Set false for discovery-only results.
- `maxFilesIndexed` / `maxPresetsIndexed` (optional, defaults 2000 / 500) — safety caps on the local-repo scan.

**Scoring model.** Lexical, deterministic, dependency-free. Each preset's name, namespace, description, and serialized body are matched as text against the query's tokens (camelCase-aware, so `automergeMinor` matches the token `automerge`). Field weighting favors name > namespace > description > body, and a load-time IDF-style rarity weight downweights ubiquitous tokens (e.g. `group` appears in hundreds of presets) so a preset sharing a rare, specific term outranks one that only shares a common one. A name-overlap confidence boost lifts presets whose name contains several query terms. Scores are normalized to `0..1`; ties break by name. This is a recall aid, not a stemmed IR engine.

**Result shape:**

- `builtIn` / `local` — ranked arrays of `{ name, namespace, description, score, matchedOn, file?, body? }`. `matchedOn` lists which fields a query token hit. `file` is present only for local presets.
- `bestScore` + `coverage` (`strong` | `partial` | `weak`) — how well the single best existing preset covers the intent.
- `draft` (present when `includeDraft` is true **and** coverage is not strong **or** ≥2 facets were recognized) — `{ config, unvalidated: true, hint, facets, notes }`. `config` is a **pasteable** Renovate config assembled from recognized intent; `facets` lists which curated intents fired; `notes` carries per-facet caveats (or, when nothing was recognized, an explanation). A single strongly-covered facet emits no draft — the top match already says it.
- `warnings` — local-indexing issues (parse failures, caps hit).

**The draft is never validated inside this tool** — that would require the Renovate CLI and break the tool's offline purity (the same honesty as `preview_custom_manager` telling you to run `dry_run` after). Pass `draft.config` (not the whole `draft` object — its `unvalidated`/`hint`/`facets`/`notes` keys are metadata, not valid Renovate config) to [`validate_config`](#validate_config), then [`lint_config`](#lint_config), before adopting it.

**Facet taxonomy.** The draft is assembled from a small, hand-maintained set of common-intent facets (automerge by update type, group dev dependencies, group non-major, group monorepo, schedule, pin digests, semantic commits, disable/separate major, lockfile maintenance, labels). This is a deliberately bounded maintenance surface — recognized intents map to current Renovate primitives that change rarely, and any stale recommendation is caught downstream by `validate_config` / `lint_config`. Unrecognized intents yield an empty `config` with an explanatory note.

See also: [Operational notes — `suggest_presets` caps](operations.md#suggest_presets-caps) and the [`renovate://presets`](#renovatepresets) resource family for browsing by name.

## `resolve_config`

Expand every `extends` preset offline. Opt in to fetching `github>` / `gitlab>` presets over HTTPS with `externalPresets: true`.

Built-in presets expand against a committed snapshot of Renovate's catalogue (`src/data/presets.generated.ts`). External `github>` / `gitlab>` fetching is opt-in, uses each platform's contents API with a 10 s timeout, and caches results per call. The `endpoint` input swaps in a custom API base for GHE / self-hosted GitLab; `platform` additionally rewrites `local>` presets to be fetched against that endpoint. `bitbucket>`, `gitea>`, and npm presets still land in `presetsUnresolved` with a reason.

Merging uses Renovate's own `mergeChildConfig`, run in a worker thread so the main process never imports `renovate` — mergeable arrays (`packageRules`, `hostRules`, `addLabels`, …) concatenate, non-mergeable arrays (`assignees`, `labels`, `schedule`, …) overwrite, objects recurse, `constraints` object-merges, and `force` applies last. Responses carry `mergeQuality: "faithful"` plus a `disclaimer`. A config that pulls in ≥2 sources spawns the worker, so the first such call pays a one-time cold start (~1-3 s); configs that don't actually merge skip it. If the worker is unavailable the tool falls back to a simplified in-process merge (arrays concat, objects merge, scalars overwrite), appends a warning, and reports `mergeQuality: "preview"`. `resolve_config` still doesn't run datasource lookups — run `dry_run` for full config resolution.

Template substitution implements only positional `{{argN}}` placeholders. Under-argument cases (`{{arg2}}` referenced when only one arg was passed) substitute an empty string; non-positional tokens (`{{packageRules}}`, Handlebars helpers like `{{#if …}}`) pass through verbatim and are flagged in `warnings`.

See also: [Security & secrets — Endpoint validation](security.md#endpoint-validation) and [Architecture — preset catalogue](architecture.md#preset-catalogue).

## `explain_config`

Inverse of `resolve_config`: walk the same preset tree but annotate every leaf field with the chain of presets that touched it. Each leaf is `{ value, setBy }` where `setBy` lists every contribution in merge order — last entry wins for scalars and overwritten (non-mergeable) arrays; for mergeable arrays each entry adds its own slice.

Same offline-by-default behaviour and same `externalPresets` / `endpoint` / `platform` opt-ins as `resolve_config`. Both tools share one expansion-and-merge core (`collectMergeSteps` plus the same worker-isolated faithful merge), so their resolved values are identical by construction. `explain_config` reconstructs provenance by diffing the merge's per-step snapshots: each contribution is pinned with a source name (literal `extends` entry, or `<own>` for the user's input config) and a `via` chain naming every parent preset traversed to reach it.

`mergeQuality` is `"faithful"`, matching `resolve_config` (same worker-isolated merge, same `"preview"` fallback). One attribution nuance: a preset that re-asserts an already-set value is **not** listed as a separate contributor — attribution credits whoever *changed* the value.

## `preview_custom_manager`

Preview a `customManagers` entry against a local repo. For `customType: "regex"`, shows file/line hits and extracted dep info. For `customType: "jsonata"` (`fileFormat: "json" | "yaml" | "toml"`), parses the file structure and extracts deps from each `matchStrings` JSONata projection. Offline.

**Supported `customType` matrix:**

- `regex` — `matchStringsStrategy` of `any`, `combination`, or `recursive`. Others warn and fall back to `any`.
- `jsonata` — `fileFormat` is required and must be one of `json`, `yaml`, or `toml`. The file is parsed structurally up front (via `JSON.parse`, the `yaml` package, or `smol-toml`), then each `matchStrings` entry is evaluated as a JSONata expression against the parsed value.

**JSONata return shape:** each expression must return either an array of objects whose keys map to dep fields (`depName`, `currentValue`, `datasource`, `versioning`, …) OR a single bare object that is auto-wrapped to a one-element array — mirroring Renovate's own `QueryResultZod` schema. Non-string primitive values are stringified for `{{groupName}}` template substitution (e.g. `currentValue: 1.2` → `"1.2"`); `null` / `undefined` and nested objects/arrays are dropped from the substitution bag.

**Template substitution is `{{groupName}}` only** — full Handlebars helpers/conditionals are not implemented for either path. This is the deliberate gap that distinguishes the preview from a real `dry_run`.

Other custom types (e.g. `html`) are out of scope. Use this tool for fast iteration; confirm with `dry_run`.

See also: [Operational notes — `preview_custom_manager` caps & timeouts](operations.md#preview_custom_manager-caps--timeouts) and [Architecture — JSONata worker isolation](architecture.md#jsonata-worker-isolation).

## `validate_config`

Run `renovate-config-validator` against a file or inline object. Pair with [`lint_config`](#lint_config) for footguns the schema validator declares valid.

## `lint_config`

Semantic lint pass that sits alongside `validate_config` rather than replacing it. Offline.

Schema validation catches structural bugs; the linter catches Renovate-specific footguns that schema validation declares valid — most commonly a pattern like `"matchPackageNames": ["/devops\\/pipelines\\/.+"]` where a trailing `/` is missing and Renovate silently degrades the value to an exact-string match that never hits, or a typo like `"matchManagers": ["npmm"]` that silently applies the rule to zero packages.

**Rule IDs (stable, suppressible by callers):**

- `dead-regex-missing-slash`
- `unwrapped-regex`
- `matchManagers-unknown-name`
- `deprecated-key`
- `automerge-without-automerge-type`
- `empty-extends`
- `contradictory-disabled-with-package-rules`
- `package-rule-without-action`
- `invalid-schedule`

The ruleset is intentionally small, scoped to the regex-aware and manager-aware fields plus a handful of `packageRules`-level footguns, and tuned to avoid false positives on benign exact strings containing a `.`. The valid-manager list is snapshotted from the `renovate` devDep; unknown names get a Damerau-Levenshtein "did you mean?" suggestion when something close enough exists. The `deprecated-key` rule scans the top level plus `packageRules` / `hostRules` / `customManagers` entries for keys Renovate has renamed (e.g. `masterIssue` → `dependencyDashboard`); the rename is embedded in the finding message and the user is pointed at [`migrate_config`](#migrate_config) to auto-apply.

## `dry_run`

Run Renovate with `--dry-run` and return the structured JSON report. No PRs, no pushes.

**Platform selection.** Defaults to `--platform=local` against `repoPath`. Pass `platform` + `endpoint` + `token` + `repository` to run as a real GitHub/GitLab client (needed when the config extends `local>` presets on a private host). When `platform` is not passed, the tool reads `RENOVATE_PLATFORM` from the MCP server's env before defaulting to `local`. The response echoes `platformSource` (`input` / `env` / `default`) and `effectivePlatform`, and an advisory warning fires when env-derived platform is non-local so a surprising `gitlab`/`github` is never mysterious. Preflight error messages also tag the platform origin.

**Token resolution.** When `token` is not passed, falls back to `RENOVATE_TOKEN` from MCP env, then to `GITLAB_TOKEN` (when `platform=gitlab`) or `GITHUB_TOKEN` (when `platform=github`) — auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI, since Renovate itself only reads that one var.

**Repository shape.** `repository` accepts GitHub-style `owner/repo` and GitLab nested-group paths like `group/subgroup/project`.

**Endpoint forwarding in local mode.** `endpoint` / `token` also flow through in default `platform=local` mode so `gitlab>…` / `github>…` preset shortcuts (otherwise hardcoded to gitlab.com / github.com) can be redirected at a self-hosted host without setting up a full remote run.

**Large-report escape hatch.** Two optional inputs handle reports that would exceed MCP response-content caps: `reportOutputPath` redirects the structured report to a file (mode 0600) and collapses `summary.report` to `{ reportPath, repoCount, updateCount }`; `summaryOnly: true` strips per-repo update arrays from the inline payload (only meaningful with `reportOutputPath`). See [Operational notes](operations.md#large-report-escape-hatch).

**Progress notifications.** Emitted during the run when the caller supplies a `progressToken`. See [Operational notes](operations.md#progress-notifications).

**Inline secrets.** When `token` or any `hostRules[].token` is passed inline, the result `warnings` array carries an advisory steering callers toward env-var auth. See [Security & secrets](security.md#inline-secrets-in-the-transcript).

**`ok` semantics and benign-noise filtering.** RE2 native-fallback noise and `Unsupported node environment` notices are filtered out of `reportErrors` — the former still surfaces under `warnings`, the latter under a separate `environmentWarnings` array — so `ok` reflects whether the run actually failed, not benign degradation. See [Operational notes](operations.md#ok-semantics-and-benign-noise-filtering).

## `dry_run_diff`

Semantic diff between two `dry_run` reports — `added` / `removed` / `changed` proposed updates plus a compact text rendering. Stateless; takes both reports as inputs.

Each side accepts either the inline report (raw `{ repositories }` or a full `dry_run` summary with a `report` key) or `{ reportPath: "<absolute path>" }` pointing at a file written by `dry_run`'s `reportOutputPath`. Inline and path forms can be mixed — pair the two when reports would otherwise hit the inline truncation cap.

Updates are keyed by `(manager, packageFile, depName)` so a version bump on the same dep shows up once under `changed` rather than twice as `removed + added`. Compared per identity: `newValue`, `newVersion`, `updateType`, `branchName`, `groupName`, `schedule`.

Useful when iterating on a config to see exactly what each tweak did.

## `resolve_config_diff`

Offline structural diff between two **fully-resolved** configs — the `before` and `after` of a config refactor. The resolve-level counterpart to [`dry_run_diff`](#dry_run_diff): where `dry_run_diff` shows how the *proposed PRs* change, this shows how the *effective settings* change. It answers "does the new config produce the same Renovate behaviour as the old one, modulo the intended changes?" without running Renovate — so it stays useful even when datasource lookups would fail (in a sandboxed/offline environment `dry_run` reports zero updates and `dry_run_diff` collapses to a vacuous 0-vs-0).

Each side accepts `repoPath` (locates the repo's config via the same discovery order as [`read_config`](#read_config)) **or** `configContent` (an inline config object). If both are provided for a side, `configContent` takes precedence (consistent with [`resolve_config`](#resolve_config)). Both sides are expanded with [`resolve_config`](#resolve_config)'s preset expansion + faithful worker-thread merge before being compared.

The shared `externalPresets` / `endpoint` / `platform` knobs mirror [`resolve_config`](#resolve_config) and apply to **both** sides — a refactor is diffed under one resolution context. Default is fully offline (no network I/O).

**Diff semantics (top-level keys only):**

- **Non-array keys** → deep-compared; a difference is reported in `fieldChanges` as `{ key, before, after }` carrying the full values. A nested array inside an object is part of that object's value and surfaces as a whole-field change.
- **Array-valued keys** (`packageRules`, `customManagers`, `matchManagers`, `addLabels`, …) → order-insensitive **set diff**. Members are JSON-normalized (recursive key-sort), so a reordered array reads as no change and reordered keys within a member compare equal. Members only in `before` are `removed`, only in `after` are `added`; there is **no pairing**, so a slightly-tweaked rule shows as one `removed` + one `added`. Because it is a *set* diff, duplicate members (entries with the same normalized form) collapse to one — if an array carries intentional duplicate entries, the diff may undercount changes to them.

Returns `summary` (`fieldsChanged`, `arraysChanged`, `arrayItemsAdded`, `arrayItemsRemoved`), `fieldChanges`, `arrayChanges` (keyed by config key), a human-readable `text` rendering, and a `resolution` block carrying each side's `mergeQuality`, `presetsUnresolved`, and `warnings`. When either side fell back to the approximate `"preview"` merge or has unresolved presets, the `text` is prefixed with a one-line advisory so the diff is never read as authoritative when it isn't.

## `test_package_rules`

Offline "what-if" for `packageRules`: given a hypothetical dependency context and a config, report which rules match, **which matcher decided each**, and what each matched rule contributes. Answers "why didn't my rule match?" without running Renovate.

Pass `repoPath` (locates + expands the repo's config via the same discovery order as [`read_config`](#read_config)) **or** `configContent` (an inline config). The config's `extends` are expanded first (via [`resolve_config`](#resolve_config)'s offline expansion + the same `externalPresets` / `endpoint` / `platform` opt-ins), so preset-provided `packageRules` are included. The dependency is described with optional synthetic fields — `depName`, `packageName`, `datasource`, `manager`, `depType`, `currentValue`, `currentVersion`, `packageFile`, `categories`, … — supply whatever you want to test against.

**Faithful by construction.** Rules are evaluated with Renovate's **real matchers** in a worker thread (see [Architecture — worker isolation for packageRules](architecture.md#worker-isolation-for-packagerules)), so match decisions are bit-faithful for the fields you supply. The crucial subtlety: a matcher returns `false` identically for "supplied-but-no-match" and "field-absent", so results are classified against what you actually passed:

- **`matchedRules`** — `{ index, rule, matchedBy, contributedConfig }`; `matchedBy` names the matchers that fired and `contributedConfig` is what the rule adds (match/exclude keys stripped).
- **`unmatchedRules`** — `{ index, rule, decidedBy }`; `decidedBy` names the matcher(s) that returned a **trustworthy** false (their fields were supplied).
- **`unevaluatable`** — `{ ruleIndex, matcher, requiredFields, reason }` for matchers we could not judge: `missing-input-field` (you didn't supply a field the matcher reads), `needs-merge-confidence-api` (`matchConfidence` needs the merge-confidence API — impossible offline), `jsonata-may-reference-computed-fields` (advisory — a `matchJsonata` verdict may depend on post-lookup fields), or `matcher-error`.

Matchers that need post-lookup data you didn't supply (`matchUpdateTypes`, `matchCurrentVersion`, `matchNewValue`, `matchCurrentAge`) surface as `unevaluatable`, never as silent non-matches. Also returned: `effectiveConfig` (the faithful merged config for the dependency, minus the echoed `packageRules`), `ruleCount`, `matchedRuleCount`, `matchQuality` (`"faithful"`, or `"preview"` when the worker was unavailable — then only `matchPackageNames` / `matchDepNames` / `matchManagers` / `matchDatasources` / `matchFileNames` / `matchCategories` are evaluated, glob-only), a `disclaimer`, and `warnings`.

Deprecated matcher keys (`matchPackagePatterns`, `matchPackagePrefixes`, `paths`, …) are detected and warned about — Renovate migrates them before applying rules, but this tool evaluates the post-migration matchers, so run [`migrate_config`](#migrate_config) first. Run [`dry_run`](#dry_run) for full-fidelity confirmation.

## `annotate_dry_run`

Attribute each proposed update in a `dry_run` report to the `packageRules` that caused it — "which of my rules produced these updates?". Stateless and offline: run [`dry_run`](#dry_run) first, then pass its report here.

Takes a report (inline `report` — raw `{ repositories }` or a full `dry_run` summary with a `report` key — **or** `{ reportPath: "<absolute path>" }`, the same shapes as [`dry_run_diff`](#dry_run_diff)) **plus** a config source (`repoPath` or `configContent`, with the same `externalPresets` / `endpoint` / `platform` opt-ins as [`resolve_config`](#resolve_config)). Updates are deduplicated by `(manager, packageFile, depName)` and each is matched — using the **real facts already in the report** — against the config's effective `packageRules` in a single worker round-trip.

Returns one `annotation` per update (`manager`, `packageFile`, `depName`, `currentVersion`, `newVersion`, `updateType`, plus `matchedRules` and `unevaluatable` with the same shapes as [`test_package_rules`](#test_package_rules)), and two aggregate signals:

- **`rulesNeverMatched`** — indices of `packageRules` that matched no update in the report (a likely-dead-rule signal).
- **`fieldGaps`** — context fields the config's matchers needed but **no** update in the report carried (e.g. `datasource` is often absent from the report shape, so `matchDatasources` rules can't be evaluated). These updates' matchers appear under `unevaluatable` rather than as non-matches.

Also returns `matchQuality` (`"faithful"` / `"preview"`), `reportSource` (`"inline"` / `"reportPath"`), `ruleCount`, `updateCount`, a `disclaimer`, and `warnings` (including the deprecated-matcher-key warning that points at [`migrate_config`](#migrate_config)). Run [`dry_run`](#dry_run) for full-fidelity confirmation.

## `migrate_config`

Apply Renovate's built-in config migrations (deprecated key renames like `masterIssue` → `dependencyDashboard`, template-variable rewrites, `packageRules` matcher consolidation, `host-rules` unification, …) and return the migrated config plus a unified diff.

Does **not** write — chain with [`write_config`](#write_config) to persist.

Runs in an isolated worker thread so the main MCP server process never imports the `renovate` package; first call carries a one-time cold-load cost of a few seconds. See [Architecture — worker isolation for migration](architecture.md#worker-isolation-for-migration).

## `write_config`

Validate, then atomically write a config to disk. A failed validation must never leave a broken config on disk.

**Round-trip preservation.** When the target file already exists and parses as JSON-with-comments, edits go through a round-trip serializer that preserves comments, key order, trailing commas, blank-line groupings, and any unrelated trivia — only the keys the caller actually changed are rewritten. Brand-new file writes (no prior file at the target path) fall back to plain `JSON.stringify(config, null, 2) + "\n"` — byte-identical to pre-round-trip behavior. See [Architecture — round-trip writer](architecture.md#round-trip-writer).

**Refusal reasons (part of the documented contract):**

- `reason: "json5-not-jsonc-compatible"` — `.json5` files that lean on JSON5-only syntax (unquoted keys, single-quoted strings, hex literals, etc.) cannot round-trip safely.
- `reason: "existing-file-unparseable"` — the file on disk doesn't parse as JSON / JSONC.

Both refusals hint at `force: true` as the escape hatch.

**`force: true` is destructive.** Pair it with `confirmForce: "YES_OVERRIDE_VALIDATION"` (the literal sentinel makes accidental overrides under prompt-injected tool calls harder). `force: true` skips both validation AND the round-trip path and rewrites the file with a clean `JSON.stringify` rendering — the user has accepted a clean rewrite.

## `renovate://presets`

Markdown index of all built-in presets grouped by namespace.

## `renovate://presets/{namespace}`

Markdown listing for a single namespace (e.g. `renovate://presets/config`) — cheaper than the full index when you only want to browse one namespace.

## `renovate://preset/{name}`

Expanded JSON body for one preset (e.g. `renovate://preset/config:recommended`).
