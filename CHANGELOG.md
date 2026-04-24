# Changelog

## [0.4.0](https://github.com/tibuntu/renovate-mcp/compare/v0.3.0...v0.4.0) (2026-04-24)


### Features

* **dry_run:** accept per-invocation hostRules for private registry auth ([1a0dd48](https://github.com/tibuntu/renovate-mcp/commit/1a0dd484e8d63eda1469b2cab695446cc3d8d3a6)), closes [#42](https://github.com/tibuntu/renovate-mcp/issues/42)
* **dry_run:** surface registry-auth failures via problems[] ([fa272f3](https://github.com/tibuntu/renovate-mcp/commit/fa272f3447a873a00f778b1d4f566f9a003115ca))
* **lint_config:** add semantic lint tool for Renovate footguns ([68e2bf9](https://github.com/tibuntu/renovate-mcp/commit/68e2bf9c1b1d4bfa9440719629ddbb4dbdbd7c0b)), closes [#28](https://github.com/tibuntu/renovate-mcp/issues/28)
* **resolve_config:** distinguish rate-limit from auth failures on preset fetches ([17325f8](https://github.com/tibuntu/renovate-mcp/commit/17325f83d91c6fba13f3d6d0498c664fe83ad036))
* **resolve_config:** enrich 401/403 preset-fetch errors with credential source and URL ([b69b875](https://github.com/tibuntu/renovate-mcp/commit/b69b87563e3ad009177676789752841b15cdbc09))
* **resolve_config:** flag responses as preview-quality ([e704e3b](https://github.com/tibuntu/renovate-mcp/commit/e704e3b9c49a1a06ab9e82336bb1ba25288577d5)), closes [#23](https://github.com/tibuntu/renovate-mcp/issues/23)
* **resolve_config:** prefer RENOVATE_TOKEN over platform tokens for external preset fetches ([be60624](https://github.com/tibuntu/renovate-mcp/commit/be60624728e9f9fa1ee8cbc5a9977995b37d1c95)), closes [#22](https://github.com/tibuntu/renovate-mcp/issues/22)
* **resolve_config:** surface preset template warnings ([5d19941](https://github.com/tibuntu/renovate-mcp/commit/5d19941a391ec9d655c8a2b5f3e24c7787af407f)), closes [#24](https://github.com/tibuntu/renovate-mcp/issues/24)
* **setup:** reword startup banner for partial CLI availability ([1b1c9a3](https://github.com/tibuntu/renovate-mcp/commit/1b1c9a31f113af19a2a0e34c3a08ae823e4a3564)), closes [#25](https://github.com/tibuntu/renovate-mcp/issues/25)

## [0.3.0](https://github.com/tibuntu/renovate-mcp/compare/v0.2.0...v0.3.0) (2026-04-23)


### Features

* **presets:** add renovate://presets/{namespace} sub-resources ([3e5d59f](https://github.com/tibuntu/renovate-mcp/commit/3e5d59ff16b370aa2d6beed5a11f9031be1318ec)), closes [#26](https://github.com/tibuntu/renovate-mcp/issues/26)
* **preview_custom_manager:** honor .gitignore when walking the repo ([00eed89](https://github.com/tibuntu/renovate-mcp/commit/00eed8962175ee0e81f77cc7f0161d35b4d7b261)), closes [#21](https://github.com/tibuntu/renovate-mcp/issues/21)
* **resolve_config:** accept endpoint/platform for self-hosted GitLab/GHE ([08861eb](https://github.com/tibuntu/renovate-mcp/commit/08861ebebf2b3c4897771dba79b2232bbaac3233)), closes [#30](https://github.com/tibuntu/renovate-mcp/issues/30)


### Bug Fixes

* **resolve_config:** unify unresolved reason for unsupported external presets across externalPresets flag ([b6696fc](https://github.com/tibuntu/renovate-mcp/commit/b6696fcbf57bd6380df3c7625f9e135230a74506)), closes [#29](https://github.com/tibuntu/renovate-mcp/issues/29)
* **write_config:** realpath repoPath before escape check ([e788e23](https://github.com/tibuntu/renovate-mcp/commit/e788e230ae8778b918133890b8dee79e7a851f5c))

## [0.2.0](https://github.com/tibuntu/renovate-mcp/compare/v0.1.0...v0.2.0) (2026-04-23)


### Features

* initial release ([4612741](https://github.com/tibuntu/renovate-mcp/commit/4612741fd895b1db8c64ea6de1ace1c69c675b77))
