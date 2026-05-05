# Changelog

## [0.10.0](https://github.com/tibuntu/renovate-mcp/compare/v0.9.4...v0.10.0) (2026-05-05)


### Features

* warn when Renovate's RE2 native module is unusable ([343e976](https://github.com/tibuntu/renovate-mcp/commit/343e9762e961b6a5e373ef1c1f0714938d539641))

## [0.9.4](https://github.com/tibuntu/renovate-mcp/compare/v0.9.3...v0.9.4) (2026-05-01)


### Bug Fixes

* **Renovate:** ensure dependency updates trigger releases ([8d567d1](https://github.com/tibuntu/renovate-mcp/commit/8d567d115129c0a446e3a449e4f4928f8515b5b7))

## [0.9.3](https://github.com/tibuntu/renovate-mcp/compare/v0.9.2...v0.9.3) (2026-04-27)


### Bug Fixes

* **test:** swallow EPIPE on child stdin to avoid macOS-only flake ([0f62043](https://github.com/tibuntu/renovate-mcp/commit/0f62043b5379d41a454c000cc1ab438cd44086e1))

## [0.9.2](https://github.com/tibuntu/renovate-mcp/compare/v0.9.1...v0.9.2) (2026-04-26)


### Bug Fixes

* **ci:** use workflow_dispatch to preserver OIDC token identity ([31dd723](https://github.com/tibuntu/renovate-mcp/commit/31dd723cc70942ffed1c3ae052d7aa01c64cd3c5))

## [0.9.1](https://github.com/tibuntu/renovate-mcp/compare/v0.9.0...v0.9.1) (2026-04-26)


### Bug Fixes

* **security:** add least-privilege permissions to CI workflow ([c20d470](https://github.com/tibuntu/renovate-mcp/commit/c20d470ce34fec5b267238175158fba7bad86afb))

## [0.9.0](https://github.com/tibuntu/renovate-mcp/compare/v0.8.0...v0.9.0) (2026-04-25)


### Features

* declare Windows unsupported via package.json os field ([56b4f7e](https://github.com/tibuntu/renovate-mcp/commit/56b4f7e3a7b7a3509820381a3d62042f39683a99)), closes [#121](https://github.com/tibuntu/renovate-mcp/issues/121)
* register stderr-only handlers for unhandled rejections and exceptions ([3a9ebd6](https://github.com/tibuntu/renovate-mcp/commit/3a9ebd6932540b51693b397b4d6aaf7749b6ccd8)), closes [#126](https://github.com/tibuntu/renovate-mcp/issues/126)


### Bug Fixes

* **security:** bundle low-severity findings from 2026-04-25 audit ([#136](https://github.com/tibuntu/renovate-mcp/issues/136)) ([2a3eb2f](https://github.com/tibuntu/renovate-mcp/commit/2a3eb2fc67014d5e5c3822526774ebcd35844ff3))
* **security:** cap external preset response body at 1 MB ([b94708c](https://github.com/tibuntu/renovate-mcp/commit/b94708cb5ab7be268a38a4d517a33ba054322d65)), closes [#132](https://github.com/tibuntu/renovate-mcp/issues/132)
* **security:** cap tool input sizes to prevent DoS via oversized inputs ([df7d777](https://github.com/tibuntu/renovate-mcp/commit/df7d7777a10ef34412a550b49e77b6057fbc608c)), closes [#133](https://github.com/tibuntu/renovate-mcp/issues/133)
* **security:** pre-create dry_run report file with mode 0600 ([ca97fda](https://github.com/tibuntu/renovate-mcp/commit/ca97fda5b9c076adccbee2f5348ac216752eacc0))
* **security:** refuse redirects and suppress auth on non-https preset fetches ([e85c177](https://github.com/tibuntu/renovate-mcp/commit/e85c17737f1a8c59ee6b5141975908353c7a38c7))
* **security:** refuse to follow pre-existing symlinks in write_config temp path ([245a0cc](https://github.com/tibuntu/renovate-mcp/commit/245a0ccd5d9886d55cbfb138d664d21985a5995f)), closes [#129](https://github.com/tibuntu/renovate-mcp/issues/129)
* **security:** require confirmForce literal alongside force=true in write_config ([2f33d23](https://github.com/tibuntu/renovate-mcp/commit/2f33d2305f624e5456cade0e4204e92c35099532)), closes [#135](https://github.com/tibuntu/renovate-mcp/issues/135)
* **security:** validate endpoint input to refuse non-https and private-host targets ([95baf88](https://github.com/tibuntu/renovate-mcp/commit/95baf8840ec5fd161c0a5cefdf080640e9f81bd1))

## [0.8.0](https://github.com/tibuntu/renovate-mcp/compare/v0.7.0...v0.8.0) (2026-04-25)


### Features

* **explain_config:** trace which preset set each field ([4f35031](https://github.com/tibuntu/renovate-mcp/commit/4f35031fe6a7cbeebae06a872819dd16fefc09a7)), closes [#78](https://github.com/tibuntu/renovate-mcp/issues/78)
* **preview_custom_manager:** support recursive and combination strategies ([972a7e9](https://github.com/tibuntu/renovate-mcp/commit/972a7e998b91ce1f1dfbcb4965dd09a1acad3050))


### Bug Fixes

* **prepack:** guard against missing shebang before chmod ([dac8dcf](https://github.com/tibuntu/renovate-mcp/commit/dac8dcffc4416bf6cf8cfed943ce79c6806c5555)), closes [#76](https://github.com/tibuntu/renovate-mcp/issues/76)

## [0.7.0](https://github.com/tibuntu/renovate-mcp/compare/v0.6.0...v0.7.0) (2026-04-25)


### Features

* add get_version tool exposing server version and build mode ([d39d3f3](https://github.com/tibuntu/renovate-mcp/commit/d39d3f33ecdfaca8563a6e3adc716f2d9b50617d))
* **check_setup:** note GITLAB_TOKEN/GITHUB_TOKEN auto-translation for dry_run ([c69dbc2](https://github.com/tibuntu/renovate-mcp/commit/c69dbc208cc913631aa7583f36c51633aa2eb374))
* **check_setup:** surface platform context for dry_run preview ([93bc042](https://github.com/tibuntu/renovate-mcp/commit/93bc042432b72a9c2625d9e87be22970e2df934f))
* **dry_run_diff:** add semantic diff helper for two dry_run reports ([f934a1b](https://github.com/tibuntu/renovate-mcp/commit/f934a1b235996535bcfff71103e1abfdf190c98a))
* **dry_run:** auto-translate platform tokens to RENOVATE_TOKEN ([2f9c0fe](https://github.com/tibuntu/renovate-mcp/commit/2f9c0fe67b9276c3638421d44af189680a291dc4))
* **lint_config:** catch typos in matchManagers / excludeManagers ([0bd6418](https://github.com/tibuntu/renovate-mcp/commit/0bd6418a0f810b30e403122f58e25a5afe2c9dfb))
* **resolve_config:** point local&gt; error at the platform/endpoint workaround ([bcc6975](https://github.com/tibuntu/renovate-mcp/commit/bcc6975ff120ded6abc7409bd3a923a47f994f88))


### Bug Fixes

* **dry_run:** repair self-hosted-host invocation paths ([39ea59f](https://github.com/tibuntu/renovate-mcp/commit/39ea59f85d73877e5bf0052085be4b29f6820332))

## [0.6.0](https://github.com/tibuntu/renovate-mcp/compare/v0.5.0...v0.6.0) (2026-04-24)


### Features

* **dry_run:** accept platform/endpoint/token/repository inputs ([c1a76c8](https://github.com/tibuntu/renovate-mcp/commit/c1a76c86519fcee6acd0a27adf7a14bb4b3a6c1d))
* **dry_run:** preflight local&gt; presets under --platform=local ([b2ae7e4](https://github.com/tibuntu/renovate-mcp/commit/b2ae7e4b65d0ec17cc7126d974e07a54f8789c19))
* **dry_run:** surface validation errors as tool errors ([7cbba12](https://github.com/tibuntu/renovate-mcp/commit/7cbba12972fc9c5b97c9b9a892b31b0ad2d0b9f8))


### Bug Fixes

* **dry_run:** pass hostRules via RENOVATE_CONFIG_FILE env, not --config-file ([efc0ab2](https://github.com/tibuntu/renovate-mcp/commit/efc0ab2c1ba9cbda782b581b384da1d8bb7f29f6))

## [0.5.0](https://github.com/tibuntu/renovate-mcp/compare/v0.4.0...v0.5.0) (2026-04-24)


### Features

* **dry_run:** emit MCP progress notifications during long runs ([328ee52](https://github.com/tibuntu/renovate-mcp/commit/328ee528c75bc9c4cf523a346e9fe9cf76a88397)), closes [#81](https://github.com/tibuntu/renovate-mcp/issues/81)


### Bug Fixes

* **preview_custom_manager:** cap per-file read size to prevent OOM ([1d5a844](https://github.com/tibuntu/renovate-mcp/commit/1d5a84425fd7d670f2f3337987b01f17f97481e4)), closes [#62](https://github.com/tibuntu/renovate-mcp/issues/62)
* **preview_custom_manager:** cap user regex with worker + wall-clock timeout ([2283a6a](https://github.com/tibuntu/renovate-mcp/commit/2283a6a9a5add1a523a63e90304cab867e74d5a9)), closes [#56](https://github.com/tibuntu/renovate-mcp/issues/56)
* **preview_custom_manager:** split maxFilesScanned into walked + matched caps ([c0b07ca](https://github.com/tibuntu/renovate-mcp/commit/c0b07caf353af6f3f46b779340e21e386c72c5f3)), closes [#58](https://github.com/tibuntu/renovate-mcp/issues/58)
* **resolve_config:** reject unknown preset source prefixes at parse time ([0fa864c](https://github.com/tibuntu/renovate-mcp/commit/0fa864c96556082f9efb18bf0c43f65d0b25ea36)), closes [#54](https://github.com/tibuntu/renovate-mcp/issues/54)
* **test-helpers:** reject pending requests on server crash or timeout ([eee76a9](https://github.com/tibuntu/renovate-mcp/commit/eee76a9bf8afbaa69c006441d8b593b4bc0d5b66)), closes [#55](https://github.com/tibuntu/renovate-mcp/issues/55)
* **write_config:** clean up tmp file when final rename fails ([2127780](https://github.com/tibuntu/renovate-mcp/commit/21277809ceaabed4d0e6b1bf655375084ab10890)), closes [#57](https://github.com/tibuntu/renovate-mcp/issues/57)

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
