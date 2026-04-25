# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MCP server that helps users design Renovate configurations interactively. TypeScript, Node ≥ 24 (aligns with Renovate's own engine requirement), built with `@modelcontextprotocol/sdk` 1.x, stdio transport.

Surface is intentionally small: eleven tools (`check_setup`, `read_config`, `resolve_config`, `explain_config`, `preview_custom_manager`, `validate_config`, `lint_config`, `dry_run`, `dry_run_diff`, `write_config`, `get_version`) plus the `renovate://presets` resource family (namespace index, per-namespace listings, per-preset JSON). Don't grow this without a reason — the roadmap for expansion lives in the GitHub issues, not in ad-hoc additions.

## Commands

```bash
npm install
npm run typecheck         # tsc --noEmit (covers src + test)
npm run build             # tsc -p tsconfig.build.json → dist/
npm run dev               # build watch mode
npm start                 # run built server over stdio
npm test                  # vitest run (auto-builds via pretest)
npm run test:watch        # vitest watch mode
npm run test:coverage     # vitest run --coverage (writes coverage/ report)
npm run generate:presets  # regenerate src/data/presets.generated.ts
```

Run a single test file: `npx vitest run test/unit/configLocations.test.ts`. Filter by name: `npx vitest run -t "renovate.json5"`.

Two tsconfigs: the root `tsconfig.json` includes both `src/` and `test/` and is used by `typecheck`; `tsconfig.build.json` narrows to `src/` only and is what `build` uses so tests never leak into `dist/`.

## Architecture — the non-obvious bits

**Shell out to the Renovate CLI at runtime; never import `renovate` as a library in `src/`.** Every tool that needs Renovate goes through `src/lib/renovateCli.ts`, which resolves the binary name (overridable via `RENOVATE_BIN` / `RENOVATE_CONFIG_VALIDATOR_BIN` env vars) and spawns it as a child process. Importing `renovate` from `src/` is the wrong pattern — the whole runtime design hinges on staying decoupled from Renovate's API surface. (Exception: build-time scripts under `scripts/` may import Renovate to generate committed snapshots — see the preset catalogue.)

**Each tool is a `register<Name>(server)` function in its own file** under `src/tools/`. `src/index.ts` wires them all into a single `McpServer` instance. Same pattern for resources under `src/resources/`.

**Config-file discovery lives in `src/lib/configLocations.ts`** and mirrors Renovate's own priority order (`renovate.json`, `renovate.json5`, `.github/renovate.json`, `.gitlab/renovate.json`, `.renovaterc*`, then `package.json#renovate`). `read_config` and `write_config` both rely on this.

**`write_config` is temp-file → validate → atomic rename.** A failed validation must never leave a broken config on disk. `force: true` bypasses the validation gate but still uses the same rename path. Don't refactor this into a direct-write.

**`dry_run` uses `--report-type=file` with a temp report path**, reads the structured JSON report Renovate writes, and returns that rather than scraping stdout. Keeps the tool's output predictable across Renovate versions. If the report isn't produced (Renovate crashed), we fall back to surfacing the tail of stderr.

**Spawn errors never leak raw to users.** All three shell-out tools catch spawn failures and wrap them via `formatMissingBinaryError` in `src/lib/renovateCli.ts`, which also points users at the `check_setup` tool. `src/index.ts` runs `checkSetup()` at startup and, when anything's missing, appends the status to the server's `instructions` so the LLM sees the setup problem before a tool call fails.

**Integration tests use stdio + fake binaries, not mocks.** `test/helpers/mcpSession.ts` spawns `dist/index.js` as a real child process and speaks JSON-RPC over stdio — so the tests exercise the actual MCP handshake and tool registration. For code that shells out to Renovate (`write_config` rollback), the tests generate executable Node scripts (`#!/usr/bin/env node`) at runtime and point `RENOVATE_CONFIG_VALIDATOR_BIN` at them. Don't replace this with vi.mock of child_process; the whole point is that the real spawn path is tested. CI deliberately doesn't install Renovate, so `validate_config` / `dry_run` aren't covered end-to-end.

**`preview_custom_manager` is offline and native — does NOT shell out.** `src/lib/customManagerPreview.ts` walks the repo directly (skipping `.git/` and `node_modules/`), applies `fileMatch` regexes to relative paths, runs each `matchStrings` regex against file content, and surfaces per-line hits with named capture groups plus extracted dep info. It deliberately mirrors only a subset of Renovate's customManager behavior: `customType: "regex"` only, `matchStringsStrategy` of `any` / `combination` / `recursive` (others warn and fall back to `any`), and `{{groupName}}` template substitution only (not full Handlebars). The point is fast iterative authoring feedback; users are expected to run `dry_run` afterwards for full-fidelity confirmation. Keep this tool pure — do not route it through `renovateCli.ts`.

**`resolve_config` never shells out to the Renovate CLI.** Built-in presets expand offline against the committed preset catalogue via `src/lib/presetResolver.ts`. External presets are opt-in through the `externalPresets: true` input: `github>` and `gitlab>` are fetched over HTTPS by `src/lib/externalPresetFetcher.ts` (auth via `GITHUB_TOKEN` / `GITLAB_TOKEN` / `RENOVATE_TOKEN` env vars, 10s timeout, per-call cache), while `bitbucket>`, `gitea>`, `local>`, and npm still land in `presetsUnresolved` with a clear reason. The default (`externalPresets` unset or `false`) performs no network I/O. Don't route any of this through `renovateCli.ts` — the fetcher is intentionally a narrow, direct HTTP client.

**Preset catalogue is a committed snapshot at `src/data/presets.generated.ts`.** Generated by `scripts/generate-presets.mjs`, which is the ONLY place allowed to import from the `renovate` package (build-time only — the generated file is plain data, no runtime coupling). Regenerate after a `renovate` devDep bump with `npm run generate:presets`. The resource layer exposes three things: `renovate://presets` (markdown namespace index), the `renovate://presets/{namespace}` template (markdown listing of one namespace's presets), and the `renovate://preset/{name}` template (a single preset's expanded JSON). Don't hand-edit the generated file — re-run the generator.

## MCP SDK usage

Use the `registerTool(name, config, handler)` and `registerResource(name, uriOrTemplate, metadata, handler)` forms (current 1.x API with structured config objects). Input schemas are zod raw shapes (plain object with zod types as values — not `z.object(...)`).

## Keep `README.md` in sync

`README.md` is the user-facing surface description — treat it as part of the feature, not as documentation that can lag. Whenever you change any of the following, update `README.md` in the same change:

- **Adding, removing, or renaming a tool or resource** → update the tool count in the intro line and the tool table under "What it does".
- **Changing a tool's inputs or externally-visible behavior** (new option, changed default, new env var) → update that tool's row in the table, and — if it's a notable design decision — the "Design notes" section.
- **Adding or changing env vars** (auth tokens, binary overrides, etc.) → update the "Requirements" section.
- **Changing what the user needs installed** (Node version, Renovate CLI requirement for a specific tool) → update "Requirements".
- **Changing the release/publish flow or CI setup** → update "Release flow" / "Development".
- **Touching anything that the "Example prompts" or "Example session" demonstrate** → re-read both sections and update them. The example session is a transcript that walks through `preview_custom_manager` → `validate_config` → `dry_run` → `write_config`; if you change inputs, outputs, defaults, error shapes, or the recommended workflow ordering for any tool the transcript uses, the transcript must be updated to match. Pay special attention to: tool names (a rename breaks every line that calls them), result shapes the example narrates ("4 files, 4 line hits", "2 updates", "valid", "written atomically"), and the prose around what each step achieves. A stale example is worse than none — it teaches users a workflow that no longer works.

If a change doesn't touch any of those, `README.md` probably doesn't need edits. When in doubt, re-read the README — including both example sections — and diff it against the change mentally before assuming it's fine.

## Roadmap

Open GitHub issues on `tibuntu/renovate-mcp` (#1–#6) track everything deliberately left out of v1: `resolve_config`, tests/CI, setup diagnostics, custom manager authoring helper, full preset catalogue, npm publishing. Read the relevant issue before starting any of these — each has scope and acceptance criteria already written.
