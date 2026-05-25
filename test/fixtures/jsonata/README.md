# JSONata customManager parity fixtures

Fixtures under this directory back the parity tests in
`test/unit/customManagerPreview.jsonata.parity.test.ts`.

## Attribution

These fixtures are **synthesized** to mirror Renovate's documented JSONata
customManager examples:

- Documentation: <https://docs.renovatebot.com/modules/manager/custom/jsonata/>
- Upstream source: <https://github.com/renovatebot/renovate/tree/main/lib/modules/manager/custom/jsonata>

No Renovate source code (test fixtures, documentation prose, or otherwise) is
copied byte-for-byte. The shapes are minimal toy examples of common ecosystems
(npm `package.json`, Helm `Chart.yaml`, Cargo `Cargo.toml`) chosen because they
exercise the three structured file formats Renovate's JSONata extractor
supports. License compatibility: synthesized fixtures are MIT (this project's
license); the upstream Renovate project is AGPL-3.0, which we do not depend on
for content.

## Parity strategy

Behavioral parity is enforced at test time by importing Renovate's own
`extractPackageFile` from `renovate/dist/modules/manager/custom/jsonata/index.js`
and asserting our `previewCustomManager` output matches its output for the same
fixture + manager config, after projecting both sides to the dep-shape key set
we emit (`depName`, `packageName`, `currentValue`, `currentDigest`,
`datasource`, `versioning`, `extractVersion`, `depType`, `registryUrl`).

Renovate emits `registryUrls: string[]` (plural, array); we emit
`registryUrl: string` (singular). The projection helper collapses Renovate's
`registryUrls[0]` to `registryUrl` so the comparison is apples-to-apples.

Hand-written expected literals in the parity test are a secondary readability
aid; the oracle comparison is the load-bearing claim.

Importing `renovate` is allowed in `test/` per CLAUDE.md (the "no `renovate`
import" rule applies to `src/`, where it would couple our runtime to
Renovate's library API).

## Files

- `json/package-deps.json` — npm-style package manifest with `dependencies` and
  `devDependencies` maps. Manager config: two `$each` matchStrings, one per
  dep map, projecting `depName`/`currentValue`/`datasource`/`depType`.
- `yaml/helm-chart.yaml` — Helm Chart.yaml-style file with a `dependencies`
  array of `{name, version, repository}` entries. Manager config: a single
  array-projection matchString mapping to `depName`/`currentValue`/
  `registryUrl`/`datasource`.
- `toml/cargo.toml` — Cargo.toml-style file with a `[dependencies]` table.
  Manager config: a single `$each` matchString over the dependencies table.

## Update protocol

When bumping the `renovate` devDep:

1. The pin-drift test (plan 05-01) catches `jsonata`-version drift between
   our `dependencies.jsonata` and Renovate's `dependencies.jsonata`.
2. The parity tests in this plan catch behavioral drift in Renovate's
   extractor itself.

If a parity test fails after a Renovate bump, read the bumped
`extractPackageFile` / `handleMatching` / `createDependency` and update
`src/lib/customManagerPreview.ts`' `previewJsonataManager` to match —
Renovate is the spec.
