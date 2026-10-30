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
- [`test_package_rules`](#test_package_rules)
- [`annotate_dry_run`](#annotate_dry_run)
- [`explain_dependency`](#explain_dependency)
- [`explain_schedule`](#explain_schedule)
- [`migrate_config`](#migrate_config)
- [`write_config`](#write_config)

## Resources

- [`renovate://presets`](#renovatepresets)
- [`renovate://presets/{namespace}`](#renovatepresetsnamespace)
- [`renovate://preset/{name}`](#renovatepresetname)
- [`renovate://options`](#renovateoptions)
- [`renovate://option/{name}`](#renovateoptionname)
- [`renovate://managers`](#renovatemanagers)
- [`renovate://datasources`](#renovatedatasources)

## Prompt index

- [`design-renovate-config`](#design-renovate-config)
- [`debug-package-rule`](#debug-package-rule)
- [`author-custom-manager`](#author-custom-manager)
- [`onboard-repo`](#onboard-repo)

## Common input rules

Rules every tool applies the same way (implemented once in `src/lib/toolInputs.ts`):

- **`repoPath` must be an absolute path to an existing directory.** A relative path, a nonexistent path, or a file returns `isError` with `repoPath must be an absolute path to an existing directory (got: <value>)` before the tool does anything else. No tool creates a missing `repoPath`. (`check_setup` is the one exception: a diagnostic never returns `isError`.)
- **A config source is `repoPath` or `configContent`, never both.** The tools that read a config this way (`resolve_config`, `explain_config`, each side of `resolve_config_diff`, `test_package_rules`, `annotate_dry_run`, `explain_dependency`) return `isError` for both inputs together (`Pass either repoPath or configContent, not both.`), for neither (`Provide either repoPath or configContent.`), and for a repo with no Renovate config (`No Renovate configuration found in <repoPath>.`). `resolve_config_diff` prefixes the failing side (`before: …` / `after: …`). `read_config` is the exception on the last point: there, no config is an ordinary result that points at `write_config`.
- **A path input and its inline twin are never passed together.** The same rule covers `validate_config`, `lint_config` and `migrate_config` (`configPath` / `configContent`) and the report of `annotate_dry_run` and `explain_dependency` (`reportPath` / `report`): both at once is `isError` with `Pass either <a> or <b>, not both.`; neither keeps each tool's existing `Provide either …` message.
- **Every tool carries MCP annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can decide which calls need a permission prompt. `write_config` is the only tool that writes (`readOnlyHint: false`, `destructiveHint: true`); every other tool is read-only and idempotent. Open-world (`openWorldHint: true`) are the tools that can reach the network under some input: `check_setup` (endpoint probe), `dry_run` (registries and the platform API), and the tools that accept `externalPresets` (`resolve_config`, `explain_config`, `resolve_config_diff`, `test_package_rules`, `annotate_dry_run`). The rest are offline — `validate_config`, `migrate_config` and `explain_schedule` spawn a local validator / worker but never touch the network.
- **Symlinked config targets are written through.** When the file `write_config` targets is a symlink, the write lands on the link's real path — the link survives and the file it points at changes (a dangling link, whose target does not exist, is replaced by a regular file instead). The escape check runs against that real path, so a link pointing outside `repoPath` is refused with `filename escapes repoPath` and nothing is written. Format decisions — the `package.json` nested round-trip and the `.json5` refusal — follow the requested `filename`, not the link's real name.

---

## `check_setup`

Report Renovate CLI + validator availability, versions, and install hints. Also runs at server startup. Never returns `isError`: an incomplete setup is a successful diagnosis, reported through `ok: false` and `hints`.

Surfaces a `platformContext` block with `RENOVATE_PLATFORM` / `RENOVATE_ENDPOINT` values, token-presence booleans, the platform `dry_run` would pick when its input is unset, and notes about likely misconfigurations — so callers can verify env before invoking `dry_run`. Token values are never echoed; only presence booleans.

Compares the running Node version against the bundled Renovate's declared `engines.node` range and emits an actionable hint when they're incompatible — the same condition Renovate would otherwise log only as `Unsupported node environment` during a `dry_run`.

**Inputs:**

- `repoPath` (optional, string, max 4096 bytes) — absolute path to a repository root. When set, adds the `repoContext` block described below.

### Optional `repoPath` — repo-aware diagnosis

Pass an absolute `repoPath` to add a `repoContext` block. Three signals are combined into actionable hints *before* the user runs `dry_run`:

1. **Git origin remote** — read directly from `.git/config` (no `git` spawn). Both SSH (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo`) forms parse; nested GitLab subgroup paths are preserved. The host is classified as `github` (`github.com`), `gitlab` (`gitlab.com`), `bitbucket` (`bitbucket.org`), `gitea` (`gitea.com`), `forgejo` (`codeberg.org`, `code.forgejo.org`), or `self-hosted` with a best-effort flavor (`github` / `gitlab` / `gitea` / `forgejo` / `unknown` — never `bitbucket`, since a self-hosted Bitbucket is Server/Data Center with a different API).
2. **Repo config endpoint / platform** — uses the same discovery path as [`read_config`](#read_config) to locate `renovate.json` / `renovate.jsonc` / `renovate.json5` / etc., then pulls top-level `endpoint` and `platform` if present. Mismatches against the origin host land in `repoContext.inconsistencies`.
3. **Endpoint reachability** — best-effort HEAD (fallback GET on 405) against the resolved endpoint. Probe URL precedence: `config.endpoint` → `RENOVATE_ENDPOINT` → defaults derived from origin (`https://api.github.com`, `https://gitlab.com/api/v4/version`). Self-hosted with no configured endpoint deliberately skips the probe — the tool won't guess a path on a private host.

**Security invariant:** every probe URL goes through the same allowlist validator (`https://`-only, no userinfo, no RFC1918 / loopback / link-local / cloud-metadata addresses) used by `dry_run`, `resolve_config`, and `externalPresetFetcher`. Blocked URLs surface as a hint with `skipped: "endpoint-blocked"` and never reach `fetch`. The probe sends no credentials — it's a bare HEAD / GET with no `Authorization` header. See [Security & secrets — endpoint validation](security.md#endpoint-validation).

**Hint synthesis.** Examples of the hints the cross-reference can emit:

- Origin is `github.com` and no `GITHUB_TOKEN` / `RENOVATE_TOKEN` is set → "your github-actions deps will be skipped at `dry_run` time."
- Origin is `bitbucket.org`, `gitea.com`, or `codeberg.org` (or a self-hosted `gitea.`/`forgejo.` host) and neither the matching `BITBUCKET_TOKEN` / `GITEA_TOKEN` / `FORGEJO_TOKEN` nor `RENOVATE_TOKEN` is set → names the var and the `resolve_config` `platform` value that routes `local>` presets through that host. A Forgejo origin other than `code.forgejo.org` (Codeberg, say) without an `endpoint` in the repo config additionally gets the `endpoint: "https://<host>/api/v1"` to pass, since `forgejo>` defaults to `code.forgejo.org`.
- Origin is `github.com` and the default `dry_run` `platform: local` would be used without `GITHUB_COM_TOKEN` → flags that the platform token (even when set) is **not** applied to github.com *datasource* lookups under a local run, and points at the two remedies (set `GITHUB_COM_TOKEN`, or run `platform: "github"`). This reconciles the otherwise-confusing split between `repoContext.effectivePlatform` (origin-derived, can read `github`) and `platformContext.effectiveDryRunPlatform` (what `dry_run` actually defaults to: `local`). See [Security — `GITHUB_COM_TOKEN`](security.md#github_com_token--a-separate-role).
- Origin is `gitlab.example.com` (self-hosted) and no `endpoint` is configured → "set `endpoint` in renovate.json or `RENOVATE_ENDPOINT` in the MCP server's env."
- Origin and `config.endpoint` point at different hosts → recorded under `inconsistencies` (Renovate will use the config endpoint).
- Endpoint probe failed → "If you're behind a VPN/proxy, `dry_run` will fail with the same network error."

Token-presence checks go through the same `credentialResolver` that `dry_run` and `resolve_config` use, so the diagnosis cannot drift from how Renovate actually resolves credentials.

`repoContext` is omitted entirely when `repoPath` is unset, so the startup-time invocation in `src/index.ts` keeps its existing output shape. The new diagnosis never flips `ok` to `false` — that flag remains tied to binary availability.

See also: [Operational notes — `check_setup` bundled-binary fast path](operations.md#check_setup-bundled-binary-fast-path) and [Platform setup](platform-setup.md).

## `get_version`

Report the renovate-mcp server version and whether it's a released build (running from `node_modules`) or a local/dev build (typically launched via `command: node` against a checkout).

**Inputs:** none.

## `read_config`

Locate and parse a repo's Renovate config (`renovate.json`, `renovate.jsonc`, `renovate.json5`, the same under `.github/` and `.gitlab/`, `.renovaterc*`, `package.json#renovate`) in priority order, mirroring Renovate's own discovery order when no platform is set (Renovate's per-platform directories such as `.forgejo/` are not searched). A `.jsonc` file reports `format: "json"`. JSON, JSONC (comments, trailing commas) and JSON5 are accepted for every candidate filename, matching Renovate's own parser.

**Inputs:**

- `repoPath` (required, string, max 4096 bytes) — absolute path to the repository root; see [Common input rules](#common-input-rules).

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

Expand every `extends` preset offline. Opt in to fetching `github>` / `gitlab>` / `gitea>` / `forgejo>` presets over HTTPS with `externalPresets: true`; Bitbucket Cloud presets are reached through `local>` + `platform: "bitbucket"`.

**Inputs:**

- `repoPath` (optional, string, max 4096 bytes) — absolute path to the repository root; the tool locates the repo's config automatically. Use instead of `configContent`.
- `configContent` (optional, object, max ~1,000,000 bytes serialized) — inline config object to resolve. Use instead of `repoPath`. (One of `repoPath` / `configContent` is required, never both — see [Common input rules](#common-input-rules).)
- `externalPresets` (optional boolean, default `false`) — fetch `github>` / `gitlab>` / `gitea>` / `forgejo>` presets (and `local>` presets routed via `platform`) over HTTPS.
- `endpoint` (optional, string, max 2048 bytes) — API base URL for external fetches (GitHub Enterprise / self-hosted GitLab / self-hosted Gitea or Forgejo, e.g. `https://forgejo.example.com/api/v1`). Defaults to `https://api.github.com`, `https://gitlab.com/api/v4`, `https://gitea.com/api/v1`, `https://code.forgejo.org/api/v1`, and `https://api.bitbucket.org`.
- `platform` (optional, enum `"github"` | `"gitlab"` | `"gitea"` | `"forgejo"` | `"bitbucket"`) — platform flavour of `endpoint`; when set, `local>owner/repo` presets are fetched as `<platform>>owner/repo`.

Built-in presets expand against a committed snapshot of Renovate's catalogue (`src/data/presets.generated.ts`). External `github>` / `gitlab>` / `gitea>` / `forgejo>` fetching is opt-in, uses each platform's raw-contents API with a 10 s timeout, and caches results per call. Tokens come from `RENOVATE_TOKEN` or the per-platform `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEA_TOKEN` / `FORGEJO_TOKEN` / `BITBUCKET_TOKEN` (see [Security & secrets — token resolution](security.md#token-resolution)). The `endpoint` input swaps in a custom API base for GHE / self-hosted GitLab / self-hosted Gitea or Forgejo; `platform` additionally rewrites `local>` presets to be fetched against that endpoint. Renovate has no `bitbucket>` prefix — Bitbucket Cloud presets are `local>workspace/repo` resolved with `platform: "bitbucket"` (Bitbucket Server / Data Center is not supported), and a literal `bitbucket>` entry lands in `presetsUnresolved` with a pointer at that spelling. npm presets still land in `presetsUnresolved` with a reason. Rate limiting: a GitHub `403` with `X-RateLimit-Remaining: 0` and a GitLab `429` surface as a dedicated reason naming the reset time and the token to set; Gitea / Forgejo / Bitbucket `429`s surface as the generic `HTTP 429 … when fetching <preset>` reason.

Merging uses Renovate's own `mergeChildConfig`, run in a worker thread so the main process never imports `renovate` — mergeable arrays (`packageRules`, `hostRules`, `addLabels`, …) concatenate, non-mergeable arrays (`assignees`, `labels`, `schedule`, …) overwrite, objects recurse, `constraints` object-merges, and `force` applies last. Responses carry `mergeQuality: "faithful"` plus a `disclaimer`. A config that pulls in ≥2 sources spawns the worker, so the first such call pays a one-time cold start (~1-3 s); configs that don't actually merge skip it. If the worker is unavailable the tool falls back to a simplified in-process merge (arrays concat, objects merge, scalars overwrite), appends a warning, and reports `mergeQuality: "preview"`. `resolve_config` still doesn't run datasource lookups — run `dry_run` for full config resolution.

Template substitution implements only positional `{{argN}}` placeholders. Under-argument cases (`{{arg2}}` referenced when only one arg was passed) substitute an empty string; non-positional tokens (`{{packageRules}}`, Handlebars helpers like `{{#if …}}`) pass through verbatim and are flagged in `warnings`.

See also: [Security & secrets — Endpoint validation](security.md#endpoint-validation) and [Architecture — preset catalogue](architecture.md#preset-catalogue).

## `explain_config`

Inverse of `resolve_config`: walk the same preset tree but annotate every leaf field with the chain of presets that touched it. Each leaf is `{ value, setBy }` where `setBy` lists every contribution in merge order — last entry wins for scalars and overwritten (non-mergeable) arrays; for mergeable arrays each entry adds its own slice.

**Inputs:** same shape as [`resolve_config`](#resolve_config) — `repoPath` (optional, string, max 4096 bytes; use instead of `configContent`), `configContent` (optional, object, max ~1,000,000 bytes serialized; use instead of `repoPath`; one of the two is required, never both — see [Common input rules](#common-input-rules)), `externalPresets` (optional boolean, default `false`), `endpoint` (optional, string, max 2048 bytes), `platform` (optional, enum `"github"` | `"gitlab"` | `"gitea"` | `"forgejo"` | `"bitbucket"`).

Same offline-by-default behaviour and same `externalPresets` / `endpoint` / `platform` opt-ins as `resolve_config`. Both tools share one expansion-and-merge core (`collectMergeSteps` plus the same worker-isolated faithful merge), so their resolved values are identical by construction. `explain_config` reconstructs provenance by diffing the merge's per-step snapshots: each contribution is pinned with a source name (literal `extends` entry, or `<own>` for the user's input config) and a `via` chain naming every parent preset traversed to reach it.

`mergeQuality` is `"faithful"`, matching `resolve_config` (same worker-isolated merge, same `"preview"` fallback). One attribution nuance: a preset that re-asserts an already-set value is **not** listed as a separate contributor — attribution credits whoever *changed* the value.

## `preview_custom_manager`

Preview a `customManagers` entry against a local repo. For `customType: "regex"`, shows file/line hits and extracted dep info. For `customType: "jsonata"` (`fileFormat: "json" | "yaml" | "toml"`), parses the file structure and extracts deps from each `matchStrings` JSONata projection. Offline.

`repoPath` follows the [Common input rules](#common-input-rules) — a missing repo is an `isError`, never a silent `filesWalked: 0`.

**File selection (`managerFilePatterns`):** entries are matched against POSIX-style paths relative to `repoPath` exactly like Renovate's extract phase (`getMatchingFiles` in `workers/repository/extract/file-match.js`): every entry is evaluated on its own and the results are unioned, so a file is selected when *any* entry matches it. Per entry: `*` matches everything; `/…/` (or `/…/i` for case-insensitive) is a regex, and `!/…/` matches the files the regex does *not* match; anything else is a glob evaluated with `minimatch` using `{ dot: true, nocase: true }` (so `**/*.yml` also matches `.github/workflows/ci.yml`, and `dockerfile` matches `Dockerfile`), with minimatch's own leading-`!` negation. Because entries are unioned, a `!` pattern adds files rather than excluding them — `["**/*.yaml", "!**/vendor/**"]` selects every YAML file *plus* every file outside `vendor/` — so exclude with Renovate's top-level `ignorePaths` instead (which this preview does not apply; confirm with `dry_run`). Regex entries still run in the worker under `matchTimeoutMs`; globs are evaluated in-process. An invalid `/…/` regex is reported as an error (`Invalid regex in managerFilePatterns[i] …`) that also says what Renovate would do: silently treat the entry as a glob, which almost certainly matches nothing.

**Deprecated `fileMatch`:** the pre-Renovate-44 `fileMatch` (bare regex strings) is still accepted. Each entry is converted to `/…/` exactly like Renovate's own `FileMatchMigration` — when both are given, the converted `fileMatch` entries are appended to `managerFilePatterns` — and the result carries the warning `fileMatch is deprecated in Renovate 44; use managerFilePatterns (each entry became /…/). Run migrate_config to convert the config.` The input schema requires at least one of the two.

**Supported `customType` matrix:**

- `regex` — `matchStringsStrategy` of `any`, `combination`, or `recursive`. Others warn and fall back to `any`.
- `jsonata` — `fileFormat` is required and must be one of `json`, `yaml`, or `toml`. The file is parsed structurally up front (via `JSON.parse`, the `yaml` package, or `smol-toml`), then each `matchStrings` entry is evaluated as a JSONata expression against the parsed value.

**JSONata return shape:** each expression must return either an array of objects whose keys map to dep fields (`depName`, `currentValue`, `datasource`, `versioning`, …) OR a single bare object that is auto-wrapped to a one-element array — mirroring Renovate's own `QueryResultZod` schema. Non-string primitive values are stringified for `{{groupName}}` template substitution (e.g. `currentValue: 1.2` → `"1.2"`); `null` / `undefined` and nested objects/arrays are dropped from the substitution bag.

**Template substitution is `{{groupName}}` only** — full Handlebars helpers/conditionals are not implemented for either path. This is the deliberate gap that distinguishes the preview from a real `dry_run`.

Other custom types (e.g. `html`) are out of scope. Use this tool for fast iteration; confirm with `dry_run`.

See also: [Operational notes — `preview_custom_manager` caps & timeouts](operations.md#preview_custom_manager-caps--timeouts) and [Architecture — JSONata worker isolation](architecture.md#jsonata-worker-isolation).

## `validate_config`

Run `renovate-config-validator` against a file or inline object. Pair with [`lint_config`](#lint_config) for footguns the schema validator declares valid.

**Inputs.** `configPath` (absolute path) **or** `configContent` (inline object, written to a mode-0600 temp file that is removed afterwards) — never both, see [Common input rules](#common-input-rules). `strict: true` passes `--strict` so warnings and pending migrations fail validation too.

**Validated as a repo config.** The validator treats a positional file as *global* self-hosted config by default, which silently accepts global-only options such as `token` or `platform`. The tool always passes `--no-global`, so those options are rejected the same way Renovate would reject them in a repository's `renovate.json`. (`write_config` validates the same way.)

**Timeout.** The validator has a fixed 30 s budget. Overrunning it returns an `isError` that says `timed out after` — distinct from the missing-binary error, which points at `check_setup`.

## `lint_config`

Semantic lint pass that sits alongside `validate_config` rather than replacing it. Offline. A `configPath` file is parsed as JSON, JSONC or JSON5 regardless of extension, matching Renovate's own parser. `configPath` and `configContent` are exclusive — see [Common input rules](#common-input-rules).

Schema validation catches structural bugs; the linter catches Renovate-specific footguns that schema validation declares valid — most commonly a pattern like `"matchPackageNames": ["/devops\\/pipelines\\/.+"]` where a trailing `/` is missing and Renovate silently degrades the value to an exact-string match that never hits, or a typo like `"matchManagers": ["npmm"]` that silently applies the rule to zero packages.

**Rule IDs (stable, suppressible by callers):**

- `dead-regex-missing-slash`
- `unwrapped-regex`
- `matchManagers-unknown-name`
- `matchDatasources-unknown-name`
- `deprecated-key`
- `automerge-without-automerge-type`
- `empty-extends`
- `contradictory-disabled-with-package-rules`
- `package-rule-without-action`
- `invalid-schedule`
- `automerge-includes-major`
- `duplicate-package-rule-matchers`
- `host-rule-inline-secret`
- `schedule-without-timezone`
- `package-rule-labels-overrides`

The ruleset is intentionally small, scoped to the regex-aware and manager-aware fields plus a handful of `packageRules`-level footguns, and tuned to avoid false positives on benign exact strings containing a `.`:

- **`dead-regex-missing-slash`** (error) — a value starts with `/` but doesn't end with it (or vice versa), so Renovate treats it as an exact-match string rather than the intended regex. Add the missing slash, or remove the stray one if a literal match was intended.
- **`unwrapped-regex`** (warn) — a value contains regex metacharacters but isn't wrapped in `/…/`, so Renovate treats it as an exact-match string. Wrap it (`/…/`, or `!/…/` to negate) if a regex match was intended.
- **`matchManagers-unknown-name`** (error) — a `matchManagers` / `excludeManagers` entry isn't a name Renovate recognizes. `/…/` regexes and globs are accepted (`!` negation is stripped before checking), since Renovate matches those as patterns. The valid-manager list is snapshotted from the installed `renovate` runtime dependency; unknown names get a Damerau-Levenshtein "did you mean?" suggestion when something close enough exists.
- **`matchDatasources-unknown-name`** (error) — a `matchDatasources` entry, or a literal (non-`{{ }}`) `customManagers[].datasourceTemplate`, isn't a datasource id Renovate recognizes. Renovate's own validator doesn't check these, so a typo silently matches nothing. `custom.<name>` entries, `/…/` regexes and globs are accepted (`!` negation is stripped before checking), except in `datasourceTemplate`, which is always a literal id and gets no pattern leniency; the id list is snapshotted like the manager list (see [`renovate://datasources`](#renovatedatasources)) and gets the same "did you mean?" suggestion.
- **`deprecated-key`** (warn) — the top level, or a `packageRules` / `hostRules` / `customManagers` entry, uses a key Renovate has renamed (e.g. `masterIssue` → `dependencyDashboard`) — the rename is embedded in the finding message and `suggestion` — or a key handled by Renovate's deprecated custom migrations (value coercions such as `stabilityDays`, structural rewrites such as `fileMatch` → `managerFilePatterns`), where the finding says Renovate migrates the key automatically. Both point at [`migrate_config`](#migrate_config) to see and apply the replacement.
- **`automerge-without-automerge-type`** (warn) — `automerge: true` is set (at the top level or in a `packageRules` entry) without `automergeType`. Renovate defaults to `"pr"` here; set it explicitly to avoid surprises if the default ever changes.
- **`empty-extends`** (warn) — `extends: []` is present but empty, almost always a paste error since it inherits no presets.
- **`contradictory-disabled-with-package-rules`** (error) — the root config has `enabled: false` but a `packageRules` entry has `enabled: true`, trying to re-enable a subset. Renovate does **not** re-enable specific deps from `packageRules` when the root is disabled — the whole repo stays off.
- **`package-rule-without-action`** (warn) — a `packageRules` entry has selector key(s) but no action keys, so Renovate matches deps and does nothing with them. `description` is metadata and `matchUpdateTypes` / `paths` are selectors — neither counts as an action.
- **`invalid-schedule`** (error) — a `schedule` value isn't a recognizable Renovate schedule (later-text like `"before 5am every weekday"`, or cron with a `*` minutes field). Renovate silently falls back to "at any time" on a parse failure, so this footgun goes undetected at runtime otherwise.
- **`automerge-includes-major`** (warn) — a `packageRules` entry has `automerge: true` with `matchUpdateTypes` absent or including `"major"`, so major bumps merge automatically without review. Suppressed for the whole config only when a later entry pairs `matchUpdateTypes: ["major"]` with `automerge: false` as an explicit guard (a heuristic that doesn't verify the guard actually covers the same deps).
- **`duplicate-package-rule-matchers`** (warn) — a `packageRules` entry's selector keys and values exactly match an earlier entry's (array order ignored); the later entry's action keys silently win over the earlier one's wherever they overlap.
- **`host-rule-inline-secret`** (warn) — a `hostRules` entry has a plain-string `token` or `password` (anything not wrapped as a `{{ }}` template). Since repo config is committed and readable by everyone with repo access, the secret belongs in the `encrypted` sub-object, a `{{ secrets.NAME }}` template, or the self-hosted/global config instead.
- **`schedule-without-timezone`** (warn) — a `schedule` (top level, in a `packageRules` entry, in `lockFileMaintenance`, or anywhere else `invalid-schedule` looks) restricts timing, but the root config has no `timezone`, so Renovate evaluates it in UTC. Reported once per config, at the first offending path; set a top-level `timezone` to an IANA name such as `Europe/Berlin`. `"at any time"` / empty schedules don't count. The linter doesn't expand `extends`, so ignore the finding if a preset sets the timezone.
- **`package-rule-labels-overrides`** (warn) — a `packageRules` entry sets `labels` while the root config has a non-empty `labels` array. Inside a rule `labels` replaces the inherited labels; `addLabels` appends to them. Doesn't fire when the root has no labels, and root labels that come from an extended preset aren't seen, since the linter doesn't expand `extends`.

## `dry_run`

Run Renovate with `--dry-run` and return the structured JSON report. No PRs, no pushes.

**Inputs.** `repoPath` follows the [Common input rules](#common-input-rules) and is checked before anything is spawned (a missing `cwd` would otherwise surface as a spawn `ENOENT`, indistinguishable from a missing binary). `dryRunMode` is `extract` (detect manifests only), `lookup` (also resolve latest versions) or `full` (default; full simulation including branches/PRs). `logLevel` is `info` (default) or `debug`. `timeoutMs` defaults to 5 minutes and is capped at 15; on overrun the run is killed (including its child processes) and the tool returns an `isError` that says `timed out after`. `repository` must not start with `-` (Renovate would parse it as a flag). `reportOutputPath` must be an absolute path inside an existing directory, and must not exist yet itself — both are checked before Renovate is spawned (a missing parent directory returns an `isError` naming it); the file is created with `O_EXCL` and mode 0600, and a pre-existing file or symlink at that path yields an `isError` saying `already exists` instead of an overwrite.

**Platform selection.** Defaults to `--platform=local` against `repoPath`. Pass `platform` + `endpoint` + `token` + `repository` to run as a real GitHub/GitLab client (needed when the config extends `local>` presets on a private host). When `platform` is not passed, the tool reads `RENOVATE_PLATFORM` from the MCP server's env before defaulting to `local`. The response echoes `platformSource` (`input` / `env` / `default`) and `effectivePlatform`, and an advisory warning fires when env-derived platform is non-local so a surprising `gitlab`/`github` is never mysterious. Preflight error messages also tag the platform origin.

**Token resolution.** When `token` is not passed, falls back to `RENOVATE_TOKEN` from MCP env, then to `GITLAB_TOKEN` (when `platform=gitlab`) or `GITHUB_TOKEN` (when `platform=github`) — auto-translated to `RENOVATE_TOKEN` for the spawned Renovate CLI, since Renovate itself only reads that one var.

**Repository shape.** `repository` accepts GitHub-style `owner/repo` and GitLab nested-group paths like `group/subgroup/project`.

**Endpoint forwarding in local mode.** `endpoint` / `token` also flow through in default `platform=local` mode so `gitlab>…` / `github>…` preset shortcuts (otherwise hardcoded to gitlab.com / github.com) can be redirected at a self-hosted host without setting up a full remote run.

**Custom base branches.** By default Renovate evaluates the repository's default branch. Pass `baseBranches` to evaluate other branches instead — the way to dry-run a Renovate config change living on a feature branch before merging. Each entry is an **exact branch name** unless wrapped in slashes: only `/…/`-delimited entries are regex (negate with `!/…/`) — a bare `^release/.*` is matched literally and will never match a real branch. The magic value `$default` expands to the default branch. `baseBranchPatterns` is `cli:false` in Renovate, so the tool passes it via the `RENOVATE_BASE_BRANCH_PATTERNS` env var (JSON-encoded). `readConfigFromBaseBranch` (default `true`) additionally sets `useBaseBranchConfig=merge` so Renovate reads its config from those branches — set it `false` to scan the branches' manifests with the default branch's config. Only effective for remote-platform runs; ignored with a warning under `platform=local`. An empty `baseBranches` array or a `readConfigFromBaseBranch` passed without `baseBranches` is ignored with a warning.

**Large-report escape hatch.** `reportOutputPath` handles reports that would exceed MCP response-content caps: it redirects the structured report to a fresh file (mode 0600, see **Inputs** above) and collapses `summary.report` to `{ reportPath, repoCount, updateCount }`, so nothing per-repo stays inline. See [Operational notes](operations.md#large-report-escape-hatch).

**Progress notifications.** Emitted during the run when the caller supplies a `progressToken`. See [Operational notes](operations.md#progress-notifications).

**Inline secrets.** When `token` or any `hostRules[].token` is passed inline, the result `warnings` array carries an advisory steering callers toward env-var auth. See [Security & secrets](security.md#inline-secrets-in-the-transcript).

**Per-call `hostRules`.** Written to a mode-0600 temp file that is handed to Renovate via `RENOVATE_CONFIG_FILE` and removed after the run; appended to whatever `hostRules` the repo's own config declares. Their `token` / `password` values (and the platform `token`) are scrubbed from `logTail`, `problems`, and progress messages — values shorter than 4 characters are left alone, since redacting a one-character "token" would blank every occurrence of that character. If `RENOVATE_CONFIG_FILE` is already set on the MCP server's env, the tool refuses `hostRules` with an `isError` naming that file instead of silently replacing the operator's global config for the run — put the hostRules in that file instead.

**`ok` semantics and benign-noise filtering.** RE2 native-fallback noise and `Unsupported node environment` notices are filtered out of `reportErrors` — the former still surfaces under `warnings`, the latter under a separate `environmentWarnings` array — so `ok` reflects whether the run actually failed, not benign degradation. See [Operational notes](operations.md#dry_run--ok-semantics-and-benign-noise-filtering).

**Diagnostics on failure.** Whenever Renovate exits non-zero (or produced no report at all) the result carries `logTail` — the last 40 non-empty log lines, secrets scrubbed. Captured output is capped at 4 MiB per stream (tail kept); when that cap was hit the result carries `outputTruncated: true`, meaning `logTail` and `problems` were derived from a truncated log. See [Operational notes](operations.md#dry_run--timeouts-and-output-capture).

## `dry_run_diff`

Semantic diff between two `dry_run` reports — `added` / `removed` / `changed` proposed updates plus a compact text rendering. Stateless; takes both reports as inputs.

Each side accepts either the inline report (raw `{ repositories }` or a full `dry_run` summary with a `report` key) or `{ reportPath: "<absolute path>" }` pointing at a file written by `dry_run`'s `reportOutputPath`. The collapsed `{ reportPath, repoCount, updateCount }` that `dry_run` returns under `report` in that mode is accepted as-is — directly, or still nested inside the full summary — and followed to the file. Inline and path forms can be mixed — pair the two when reports would otherwise hit the inline truncation cap. An unreadable or non-JSON file returns an `isError` naming the side (`before` / `after`) and the path.

Updates are keyed by `(manager, packageFile, depName)` so a version bump on the same dep shows up once under `changed` rather than twice as `removed + added`. Compared per identity: `newValue`, `newVersion`, `updateType`, `branchName`, `groupName`, `schedule`.

Useful when iterating on a config to see exactly what each tweak did.

## `resolve_config_diff`

Offline structural diff between two **fully-resolved** configs — the `before` and `after` of a config refactor. The resolve-level counterpart to [`dry_run_diff`](#dry_run_diff): where `dry_run_diff` shows how the *proposed PRs* change, this shows how the *effective settings* change. It answers "does the new config produce the same Renovate behaviour as the old one, modulo the intended changes?" without running Renovate — so it stays useful even when datasource lookups would fail (in a sandboxed/offline environment `dry_run` reports zero updates and `dry_run_diff` collapses to a vacuous 0-vs-0).

Each side accepts `repoPath` (locates the repo's config via the same discovery order as [`read_config`](#read_config)) **or** `configContent` (an inline config object). Passing both for a side is an error, and a side's input error is prefixed with its name (`before: …` / `after: …`) — see [Common input rules](#common-input-rules). Both sides are expanded with [`resolve_config`](#resolve_config)'s preset expansion + faithful worker-thread merge before being compared.

The shared `externalPresets` / `endpoint` / `platform` knobs mirror [`resolve_config`](#resolve_config) and apply to **both** sides — a refactor is diffed under one resolution context. Default is fully offline (no network I/O).

**Inputs:**

- `before` (required, object `{ repoPath?, configContent? }`) — one side of the diff.
- `after` (required, object `{ repoPath?, configContent? }`) — the other side.
- `externalPresets` (optional boolean, default `false`) — applies to both sides.
- `endpoint` (optional, string, max 2048 bytes) — applies to both sides.
- `platform` (optional, enum `"github"` | `"gitlab"` | `"gitea"` | `"forgejo"` | `"bitbucket"`) — applies to both sides.

**Diff semantics (top-level keys only):**

- **Non-array keys** → deep-compared; a difference is reported in `fieldChanges` as `{ key, before, after }` carrying the full values. A nested array inside an object is part of that object's value and surfaces as a whole-field change.
- **Array-valued keys** (`packageRules`, `customManagers`, `matchManagers`, `addLabels`, …) → order-insensitive **set diff**. Members are JSON-normalized (recursive key-sort), so a reordered array reads as no change and reordered keys within a member compare equal. Members only in `before` are `removed`, only in `after` are `added`; there is **no pairing**, so a slightly-tweaked rule shows as one `removed` + one `added`. Because it is a *set* diff, duplicate members (entries with the same normalized form) collapse to one — if an array carries intentional duplicate entries, the diff may undercount changes to them.

Returns `summary` (`fieldsChanged`, `arraysChanged`, `arrayItemsAdded`, `arrayItemsRemoved`), `fieldChanges`, `arrayChanges` (keyed by config key), a human-readable `text` rendering, and a `resolution` block carrying each side's `mergeQuality`, `presetsUnresolved`, and `warnings`. When either side fell back to the approximate `"preview"` merge or has unresolved presets, the `text` is prefixed with a one-line advisory so the diff is never read as authoritative when it isn't.

## `test_package_rules`

Offline "what-if" for `packageRules`: given a hypothetical dependency context and a config, report which rules match, **which matcher decided each**, and what each matched rule contributes. Answers "why didn't my rule match?" without running Renovate.

Pass `repoPath` (locates + expands the repo's config via the same discovery order as [`read_config`](#read_config)) **or** `configContent` (an inline config). The config's `extends` are expanded first (via [`resolve_config`](#resolve_config)'s offline expansion + the same `externalPresets` / `endpoint` / `platform` opt-ins), so preset-provided `packageRules` are included. The dependency is described with optional synthetic fields — `depName`, `packageName`, `datasource`, `manager`, `depType`, `currentValue`, `currentVersion`, `packageFile`, `categories`, … — supply whatever you want to test against.

**Inputs:**

- `repoPath` (optional, string, max 4096 bytes) — absolute path to the repository root; the tool locates and expands its config. Use instead of `configContent`.
- `configContent` (optional, object, max ~1,000,000 bytes serialized) — inline config whose `packageRules` to test. Use instead of `repoPath`. (One of `repoPath` / `configContent` is required, never both — see [Common input rules](#common-input-rules).)
- `externalPresets` (optional boolean, default `false`), `endpoint` (optional, string, max 2048 bytes), `platform` (optional, enum `"github"` | `"gitlab"` | `"gitea"` | `"forgejo"` | `"bitbucket"`) — same semantics as [`resolve_config`](#resolve_config).
- Synthetic dependency-context fields — all optional, all strings unless noted, supply whichever you're testing: `depName`, `packageName`, `datasource`, `manager`, `depType` (max 2048 bytes each), `depTypes` (string array, max 256 items), `currentValue`, `currentVersion`, `lockedVersion`, `versioning`, `packageFile`, `lockFiles` (array), `categories` (array), `repository`, `baseBranch`, `registryUrls` (array), `sourceUrl`, `newValue`, `newVersion`, `updateType`, `isBump` (boolean), `isBreaking` (boolean), `currentVersionTimestamp`, `mergeConfidenceLevel` (see each field's tool description for which matcher it feeds). `newVersion` feeds no matcher — it exists for the rendered names below (it is what Renovate derives `newMajor` / `newMinor` / `newPatch` from) and defaults to `newValue` when that is a single version rather than a range.

**Faithful by construction.** Rules are evaluated with Renovate's **real matchers** in a worker thread (see [Architecture — worker isolation for packageRules](architecture.md#worker-isolation-for-packagerules)), so match decisions are bit-faithful for the fields you supply. The crucial subtlety: a matcher returns `false` identically for "supplied-but-no-match" and "field-absent", so results are classified against what you actually passed:

- **`matchedRules`** — `{ index, rule, matchedBy, contributedConfig }`; `matchedBy` names the matchers that fired and `contributedConfig` is what the rule adds (match/exclude keys stripped).
- **`unmatchedRules`** — `{ index, rule, decidedBy }`; `decidedBy` names the matcher(s) that returned a **trustworthy** false (their fields were supplied).
- **`unevaluatable`** — `{ ruleIndex, matcher, requiredFields, reason }` for matchers we could not judge: `missing-input-field` (you didn't supply a field the matcher reads), `needs-merge-confidence-api` (`matchConfidence` needs the merge-confidence API — impossible offline), `jsonata-may-reference-computed-fields` (advisory — a `matchJsonata` verdict may depend on post-lookup fields), or `matcher-error`.

Matchers that need post-lookup data you didn't supply (`matchUpdateTypes`, `matchIsBreaking`, `matchCurrentVersion`, `matchNewValue`, `matchCurrentAge`) surface as `unevaluatable`, never as silent non-matches. Also returned: `effectiveConfig` (the faithful merged config for the dependency, minus the echoed `packageRules`), `ruleCount`, `matchedRuleCount`, `matchQuality` (`"faithful"`, or `"preview"` when the worker was unavailable — then only `matchPackageNames` / `matchDepNames` / `matchManagers` / `matchDatasources` / `matchFileNames` / `matchCategories` are evaluated, glob-only), a `disclaimer`, and `warnings`.

Deprecated matcher keys (`matchPackagePatterns`, `matchPackagePrefixes`, `paths`, …) are detected and warned about — Renovate migrates them before applying rules, but this tool evaluates the post-migration matchers, so run [`migrate_config`](#migrate_config) first. Run [`dry_run`](#dry_run) for full-fidelity confirmation.

**Rendered names (`rendered`).** The same call also shows what Renovate would *name* things for this dependency, so tuning `branchPrefix`, `additionalBranchPrefix`, `branchTopic`, `commitMessagePrefix`, `semanticCommit*`, `prTitle` or `groupName` doesn't need a `dry_run` round-trip:

- `branchName`, `commitMessage`, `prTitle`, and `groupName` (only when the merged config sets one) — rendered with Renovate's own template engine and branch-name generator (`generateBranchName`, including `branchNameStrict` and `hashedBranchLength`) against Renovate's option defaults ← the repo's resolved top-level config ← the synthetic dependency ← the matched rules' contributions. A `groupName` is rendered as a multi-update group (group `branchTopic` / `commitMessageTopic`, no `commitMessageExtra`), which is what Renovate does whenever two or more updates share the group.
- `renderQuality` — always `"preview"`, and `disclaimer` says why: the templates reference post-lookup fields (`newMajor`, `prettyNewVersion`, `newDigestShort`, …) that only a real lookup fills. The tool derives what it can — `is<UpdateType>` from `updateType`, `depNameSanitized` from `depName`, `parentDir` / `packageFileDir` from `packageFile`, `sourceRepo*` from `sourceUrl`, `newMajor` / `newMinor` / `newPatch` and `isSingleVersion` from `newVersion` / `newValue` via the `versioning` you supplied (default: semver) — and renders the rest empty, exactly as Renovate would with those fields absent.
- `missingTemplateVariables` — the post-lookup variables that actually reached the output with no value (found by rendering a second time with a sentinel in every unset post-lookup field, so variables in untaken `{{#if}}` branches are not reported). An empty list means every placeholder was filled; `["newMajor"]` means "supply `newVersion`".

Three situations are surfaced as `warnings`: when `semanticCommits` is `"auto"` (the default) and no `commitMessagePrefix` is set, the names carry no semantic prefix, because Renovate decides that from the repo's git history at run time (set it to `"enabled"` to preview the prefix); when a template in the config does not compile (a Handlebars syntax error), the `rendered` block is omitted and the warning carries the parse error — the match results above it stay faithful; and when the packageRules worker is unavailable (`matchQuality: "preview"`) the `rendered` block is omitted altogether, since the renderer lives in the same worker.

## `annotate_dry_run`

Attribute each proposed update in a `dry_run` report to the `packageRules` that caused it — "which of my rules produced these updates?". Stateless and offline: run [`dry_run`](#dry_run) first, then pass its report here.

Takes a report (inline `report` — raw `{ repositories }` or a full `dry_run` summary with a `report` key — **or** `{ reportPath: "<absolute path>" }`, the same shapes as [`dry_run_diff`](#dry_run_diff)) **plus** a config source (`repoPath` or `configContent`, with the same `externalPresets` / `endpoint` / `platform` opt-ins as [`resolve_config`](#resolve_config)). Updates are deduplicated by `(manager, packageFile, depName)` and each is matched — using the **real facts already in the report** — against the config's effective `packageRules` in a single worker round-trip.

**Inputs:**

- `report` (optional, object, max ~10,000,000 bytes serialized) — inline report (raw `{ repositories }` or a full `dry_run` summary with a `report` key). Use instead of `reportPath`.
- `reportPath` (optional, string, max 4096 bytes) — absolute path to a JSON report file (pair with `dry_run`'s `reportOutputPath`). Use instead of `report`. (One of `report` / `reportPath` is required, never both — see [Common input rules](#common-input-rules).)
- `repoPath` (optional, string, max 4096 bytes) — locates and expands the repo's config for its `packageRules`. Use instead of `configContent`.
- `configContent` (optional, object, max ~1,000,000 bytes serialized) — inline config whose `packageRules` to attribute against. Use instead of `repoPath`. (One of `repoPath` / `configContent` is required, never both — see [Common input rules](#common-input-rules).)
- `externalPresets` (optional boolean, default `false`), `endpoint` (optional, string, max 2048 bytes), `platform` (optional, enum `"github"` | `"gitlab"` | `"gitea"` | `"forgejo"` | `"bitbucket"`) — same semantics as [`resolve_config`](#resolve_config).

Returns one `annotation` per update (`manager`, `packageFile`, `depName`, `currentVersion`, `newVersion`, `updateType`, plus `matchedRules` and `unevaluatable` with the same shapes as [`test_package_rules`](#test_package_rules)), and two aggregate signals:

- **`rulesNeverMatched`** — indices of `packageRules` that matched no update in the report (a likely-dead-rule signal).
- **`fieldGaps`** — context fields the config's matchers needed but **no** update in the report carried (e.g. `datasource` is often absent from the report shape, so `matchDatasources` rules can't be evaluated). These updates' matchers appear under `unevaluatable` rather than as non-matches.

Also returns `matchQuality` (`"faithful"` / `"preview"`), `reportSource` (`"inline"` / `"reportPath"`), `ruleCount`, `updateCount`, a `disclaimer`, and `warnings` (including the deprecated-matcher-key warning that points at [`migrate_config`](#migrate_config)). Run [`dry_run`](#dry_run) for full-fidelity confirmation.

## `explain_dependency`

Answer the most common Renovate support question — "why was/wasn't dependency X updated?" — from an existing `dry_run` report. Stateless and offline (no CLI, no network): run [`dry_run`](#dry_run) first, then pass its report here.

The report already carries the answer: every extracted dependency under `repositories[*].packageFiles[manager][*].deps[]` has a `skipReason` / `skipStage`, an `updates` array, and `warnings`. `dry_run` either inlines the whole report (large, often truncated by clients) or collapses it to a path plus counts with `reportOutputPath`, so this tool walks it for you.

**Inputs.** A report — inline `report` (raw `{ repositories }` or a full `dry_run` summary with a `report` key) **or** `reportPath` (absolute path; pair with `dry_run`'s `reportOutputPath`), the same shapes as [`annotate_dry_run`](#annotate_dry_run), never both (see [Common input rules](#common-input-rules)) — plus `depName` (required). Matching is case-insensitive against both `depName` and `packageName`; exact by default, `partial: true` for substring matching. Optional `manager` restricts hits to one manager. Optionally add a config source — `repoPath` (same discovery as [`read_config`](#read_config)) or `configContent`, never both (see [Common input rules](#common-input-rules)) — to attach `matchedRules` per hit.

**Output.**

- **`verdict`** — one line: `not found in report`, `skipped: <skipReason>` (one entry per distinct reason when hits differ), `up to date`, or `N update(s) available`.
- **`hits`** — one per extracted occurrence: `repository`, `manager`, `packageFile`, `depName`, `packageName`, `currentValue`, `currentVersion`, `datasource`, `depType`, `skipReason`, `skipStage`, `updates` (`newVersion`, `newValue`, `updateType`, `branchName`; absent when the report came from `dryRunMode: "extract"`, where no lookup runs), `warnings` (`topic`, `message`), and — when a config source was given — `matchedRules` (`index`, `rule`, `matchedBy`, `contributedConfig`; the same entry shape as [`test_package_rules`](#test_package_rules)), evaluated with Renovate's real matchers in the same worker as [`test_package_rules`](#test_package_rules).
- **`hints`** — remedies. `not found` points at `enabledManagers`, `fileMatch` / `managerFilePatterns`, `ignorePaths`, and a `dryRunMode: "extract"` re-run; a small hand-maintained map turns the common skip reasons (`ignored`, `disabled`, `invalid-value`, `unsupported-datasource`, `github-token-required`, `internal-package`, …) into a one-line fix, and unknown reasons get a generic hint.
- **`relatedProblems`** — report-level and per-repository `problems` entries whose message (or structured `depName` / `packageName`) mentions the dependency; repo-level entries carry a `repository` key.
- **`reportSource`** (`"inline"` / `"reportPath"`), `configPath` and `matchQuality` (`"faithful"` / `"preview"`, only when a config source was given), and `warnings`. If the matcher worker is unavailable the tool degrades to the same approximate glob-only preview as `annotate_dry_run` and says so in `warnings`.

## `explain_schedule`

Answer "when will this schedule actually run?". [`lint_config`](#lint_config)'s `invalid-schedule` rule only says whether a schedule parses; this tool reports whether it is active right now and the next run windows, in both UTC and the config's timezone — the usual way to catch a `before 4am on Monday` that was meant in Berlin time but runs in UTC, a cron with the wrong field order, or an entry that never fires.

**Inputs:**

- `schedule` (required, string or string array, max 32 entries × 256 bytes) — the schedule exactly as written in the config: later-text (`before 4am on Monday`, `every weekend`, `after 10pm`) and/or cron with `*` as minutes (`* 0-3 * * 1`). Same shape as the `schedule` / `automergeSchedule` options and a `packageRules` entry's `schedule`.
- `timezone` (optional, string, max 128 bytes) — IANA zone, e.g. `Europe/Berlin`: the config's `timezone`. When omitted the schedule is evaluated in **UTC** — which is what Renovate does when the config sets no `timezone` and its runner's clock is UTC (the hosted app and most containers) — and the result says so (`timezoneAssumed: true` plus a `warnings` entry).
- `from` (optional, string, max 64 bytes) — ISO 8601 instant to evaluate from, e.g. `2026-10-29T12:00:00Z`. Defaults to now. An unparseable value is `isError` (`from must be an ISO 8601 timestamp`).
- `count` (optional, integer 1–50, default 5) — how many upcoming windows to return.

**Output** (JSON):

- `schedule` (normalised to an array), `timezone` (the effective zone), `timezoneAssumed`, `from` (`{ utc, local }`).
- `valid` — Renovate's own verdict. When `false`, `error` carries Renovate's message verbatim (`Invalid schedule: "0 3 * * *" has cron syntax, but doesn't have * as minutes`, `Invalid schedule: Unsupported timezone …`, …) and `renovateBehavior` spells out the consequence: Renovate logs a warning and **ignores the schedule**, updating on every run. This is a result, not `isError`.
- `alwaysActive` — `true` for `at any time` / an empty schedule (Renovate never consults the clock; `windows` is empty).
- `activeNow` — whether the schedule matches at `from`; when it does, `activeUntil` (`{ utc, local }`) is the end of the current window (absent if it is still active at the end of the horizon).
- `windows` — the next `count` windows that **start after** `from`, in order: `{ start: { utc, local }, end: { utc, local }, hours }` with an exclusive `end`.
- `horizonDays` (366), `truncated` (`true` when fewer than `count` windows start inside the horizon), `warnings`, `disclaimer`.

**Faithful by construction.** The windows are computed with Renovate's **own** validator and matcher — `hasValidSchedule`, `hasValidTimezone`, `cronMatches` and the `@breejs/later` text matcher Renovate ships — in a worker thread (see [Architecture — worker isolation for schedules](architecture.md#worker-isolation-for-schedules)). Renovate's `isScheduledNow` reads the wall clock, so the worker replicates its per-entry check with an injectable instant and probes every local hour over a 366-day horizon; Renovate forbids minutes in both schedule forms, so hourly probes are exact and every window edge lies on a local hour. A parity test pins the replication against `isScheduledNow` itself. Quirks are reproduced on purpose: the `at any time` short-circuit looks at the **first** entry only, `every month` / `monthly` expand to `before 5am on the first day of the month`, and a single entry combining `after …` and `before …` (`after 10pm and before 5am`) is ANDed by the parser and never fires — the tool reports zero windows and a warning telling you to split it.

Keep in mind that Renovate only *starts* work on a run that falls inside a window: the real PR time also depends on how often your Renovate runs. There is no approximate fallback — if the worker cannot load, the call is `isError` with `explain_schedule failed: …`. First call carries a one-time cold-load cost of a few seconds.

## `migrate_config`

Apply Renovate's built-in config migrations (deprecated key renames like `masterIssue` → `dependencyDashboard`, template-variable rewrites, `packageRules` matcher consolidation, `host-rules` unification, …) and return the migrated config plus a unified diff.

Does **not** write — chain with [`write_config`](#write_config) to persist.

**Inputs:**

- `configPath` (optional, string, max 4096 bytes) — absolute path to a JSON or JSON5 config file to migrate. Use instead of `configContent`.
- `configContent` (optional, object, max ~1,000,000 bytes serialized) — inline config object to migrate. Use instead of `configPath`. (One of the two is required, never both — see [Common input rules](#common-input-rules).)

Runs in an isolated worker thread so the main MCP server process never imports the `renovate` package; first call carries a one-time cold-load cost of a few seconds. See [Architecture — worker isolation for migration](architecture.md#worker-isolation-for-migration).

## `write_config`

Validate, then atomically write a config to disk. A failed validation must never leave a broken config on disk.

`repoPath` follows the [Common input rules](#common-input-rules): the repository directory must already exist (the tool creates subdirectories named by `filename`, never the repo itself), and a symlinked target file is written through rather than replaced (a dangling link is replaced by a regular file; `package.json` / `.json5` handling follows the requested `filename`).

**Default target.** With no `filename`, the tool writes the config file Renovate already reads in `repoPath` — the same discovery order as [`read_config`](#read_config) (`renovate.json`, `renovate.jsonc`, `renovate.json5`, the `.github/` and `.gitlab/` variants, the `.renovaterc*` files, then `package.json#renovate`) — and falls back to `renovate.json` when the repo has none. Discovery here is existence-based (an unparseable candidate still counts), and an untracked file on disk counts even though hosted Renovate only sees committed files. User-visible consequences: a live `renovate.json5` is the target, so JSON5-only syntax there refuses with `json5-not-jsonc-compatible`; a live `package.json#renovate` is edited in place under its `renovate` key. Pass `filename` to choose a different file explicitly.

**Round-trip preservation.** When the target file already exists and parses as JSON-with-comments, edits go through a round-trip serializer that preserves comments, key order, trailing commas, blank-line groupings, and any unrelated trivia — only the keys the caller actually changed are rewritten. Brand-new file writes (no prior file at the target path) fall back to plain `JSON.stringify(config, null, 2) + "\n"` — byte-identical to pre-round-trip behavior. The result reports which branch ran as `mode: "round-trip"` or `mode: "fresh-write"` (alongside `wrote`, `path`, `bytes`, `valid`, and `validationOutput` / `warnings` / `configConflict` when present). See [Architecture — round-trip writer](architecture.md#round-trip-writer).

**`configConflict`.** Renovate reads only the first config file it finds. When an explicit `filename` names a recognised config file and a *different* one already exists in the repo, the successful result carries `configConflict: { readByRenovate, ignored, message }`. It works in both directions: writing `renovate.json` next to a live `.github/renovate.json` reports `renovate.json` as read and the `.github` file as ignored, while writing `.renovaterc` next to a live `renovate.json` reports the `.renovaterc` as ignored. It is advisory only: the write still happens and it never appears on a refusal.

**`package.json` targets.** With `filename: "package.json"` the Renovate config lives under the top-level `renovate` key, so the round-trip edit is scoped to that key: `name`, `version`, `dependencies`, every other key, comments, and ordering are left untouched, and the `renovate` key is added if absent. Validation runs on the Renovate slice alone (written to its own temp file, never named `package.json`, removed afterwards) — the validator would otherwise reject `name` / `version` / `dependencies` as unknown options. The tool will not create a `package.json` just to hold Renovate config.

**Refusal reasons (part of the documented contract):**

- `reason: "json5-not-jsonc-compatible"` — `.json5` files that lean on JSON5-only syntax (unquoted keys, single-quoted strings, hex literals, etc.) cannot round-trip safely.
- `reason: "existing-file-unparseable"` — the file on disk doesn't parse as JSON / JSONC.
- `reason: "package-json-missing"` — `filename` is `package.json` but no such file exists; write `renovate.json` instead.
- `reason: "validator-timeout"` — the validator ran but overran its fixed 30 s budget, so the config was **not** validated. `validationOutput` says `timed out after`; the hint is to retry or check machine load, not to reach for `force: true`.

The first two hint at `force: true` as the escape hatch (except for an unparseable `package.json`, which `force` never rewrites — fix it by hand). `package-json-missing` and `validator-timeout` suggest no `force` escape hatch.

A validator that cannot be spawned yields `reason: "validator-unavailable"` (fix `RENOVATE_CONFIG_VALIDATOR_BIN` or reinstall); a timeout is never reported as unavailable, and `validation-failed` is reserved for a config the validator actually rejected.

**`force: true` is destructive.** Pair it with `confirmForce: "YES_OVERRIDE_VALIDATION"` (the literal sentinel makes accidental overrides under prompt-injected tool calls harder). `force: true` skips both validation AND the round-trip path and rewrites the file with a clean `JSON.stringify` rendering — the user has accepted a clean rewrite. **Exception: `package.json`.** There `force: true` skips validation only; the nested round-trip at the `renovate` key still runs, because a whole-file rewrite would destroy the rest of the manifest.

## `renovate://presets`

Markdown index of all built-in presets grouped by namespace.

## `renovate://presets/{namespace}`

Markdown listing for a single namespace (e.g. `renovate://presets/config`) — cheaper than the full index when you only want to browse one namespace.

## `renovate://preset/{name}`

Expanded JSON body for one preset (e.g. `renovate://preset/config:recommended`).

## `renovate://options`

Markdown index of all Renovate config options, split into "Repository config options" and "Global / self-hosted-only options" sections. Each line names the option's type and a truncated description, tagged `[deprecated]` / `[experimental]` where applicable. Fetch `renovate://option/{name}` for one option's full definition.

## `renovate://option/{name}`

Full definition of a single Renovate config option as JSON (e.g. `renovate://option/rangeStrategy`) — description, type, default, `allowedValues`, `globalOnly`, `deprecationMsg`, and the rest of the snapshot fields listed in [Architecture](architecture.md).

## `renovate://managers`

Markdown list of all manager names accepted by `matchManagers` / `excludeManagers`, plus a "Custom managers" section noting the `custom.`-prefixed form (e.g. `custom.regex`).

## `renovate://datasources`

Markdown list of all built-in datasource ids accepted by `matchDatasources` and `customManagers[].datasourceTemplate`. Custom datasources defined under `customDatasources` are referenced as `custom.<name>` and are not listed.

## Prompts

MCP prompts package the documented multi-tool workflows into ready-to-run starting points. Claude Code surfaces each one as a slash command, e.g. `/mcp__renovate__design-renovate-config`. Every prompt calls `check_setup` first with the same `repoPath`, and calls `write_config` only after the user explicitly confirms.

### `design-renovate-config`

**Arguments:** `repoPath` (required) — absolute path to the repository root. `intent` (optional) — free-text description of what Renovate should do.

Drives `check_setup` → `read_config` → `suggest_presets` (with `intent`) → `resolve_config` + `explain_config` on the resulting draft → `validate_config` + `lint_config` → `dry_run` → `write_config` on confirmation.

### `debug-package-rule`

**Arguments:** `repoPath` (required) — absolute path to the repository root. `depName` (optional) — the dependency to investigate.

Drives `check_setup` → `read_config` → `test_package_rules` for the (hypothetical) dependency (which rules match, and the `rendered` branch / commit / PR names with their `missingTemplateVariables`) → `dry_run` with `reportOutputPath` → `annotate_dry_run` on that report → `explain_dependency` for the dependency's `skipReason`, updates and matched rules → a verdict naming the packageRules index/indices and matcher(s) that decided the outcome, and the names the matched rules produce.

### `author-custom-manager`

**Arguments:** `repoPath` (required) — absolute path to the repository root. `description` (required) — what to extract, and from which files.

Drives drafting a `customManagers` entry (regex or jsonata) → `preview_custom_manager` iteratively until the hits look right → `validate_config` + `lint_config` → `dry_run` → `write_config` on confirmation.

### `onboard-repo`

**Arguments:** `repoPath` (required) — absolute path to the repository root. `intent` (optional) — free-text description of what Renovate should do.

For a repo with no Renovate config yet (if `read_config` finds one, it redirects to `design-renovate-config`). Drives `check_setup` → `read_config` (expecting no config) → `dry_run` with `dryRunMode: "extract"` to detect managers and package files → `suggest_presets` with a query built from the detected ecosystems plus `intent` → `lint_config` + `validate_config` on the draft → `write_config` on confirmation → a full `dry_run` with the written config. `dry_run` has no inline config input, so the full dry run comes after the write.
