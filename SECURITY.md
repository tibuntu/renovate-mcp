# Security Policy

## Supported versions

Only the latest released minor on npm receives security fixes; pin loosely and upgrade promptly when an advisory ships.

| Version | Supported |
| --- | --- |
| Latest minor on npm | Yes |
| Older minors | No |

## Reporting a vulnerability

Please **do not file public GitHub issues for security problems.** Instead, use GitHub's private vulnerability reporting on this repository:

- <https://github.com/tibuntu/renovate-mcp/security/advisories/new>

A maintainer will acknowledge the report within a few business days. If the issue is confirmed, we'll coordinate a fix and a coordinated disclosure timeline before publishing an advisory and a patched release.

## Scope

In scope:

- The `renovate-mcp` server itself (code under `src/`, the published npm package, the resources and tools it exposes over MCP).
- Handling of auth tokens read from the environment (`RENOVATE_TOKEN`, `GITHUB_COM_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITEA_TOKEN`, `FORGEJO_TOKEN`, `BITBUCKET_TOKEN`, and `RENOVATE_MCP_HOST_TOKENS`; see [`docs/security.md`](docs/security.md)).
- File writes performed by `write_config` against user-supplied paths.
- The config the spawned Renovate CLI and `renovate-config-validator` load: only what the operator or the caller named, and only as data (see [`docs/security.md`](docs/security.md#working-directory-config)).
- HTTPS fetches performed by `resolve_config` and the other preset-expanding tools when `externalPresets: true` (the GitHub, GitLab, Gitea, Forgejo and Bitbucket hosts, plus custom endpoints; see [`docs/security.md`](docs/security.md)).

Out of scope:

- Vulnerabilities in [Renovate](https://github.com/renovatebot/renovate) itself — please report those upstream.
- Vulnerabilities in transitive dependencies that don't have a working exploit through `renovate-mcp`'s own surface (use [GitHub Dependabot alerts](https://github.com/tibuntu/renovate-mcp/security/dependabot) for those).
- Issues that require an attacker to already have local code execution or filesystem access on the host running the server.
