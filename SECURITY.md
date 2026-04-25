# Security Policy

## Supported versions

Only the latest released minor on npm receives security fixes. `renovate-mcp` is pre-1.0, so expect breaking changes between minors; pin loosely and upgrade when an advisory ships.

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
- Handling of auth tokens read from the environment (`GITHUB_TOKEN`, `GITLAB_TOKEN`, `RENOVATE_TOKEN`).
- File writes performed by `write_config` against user-supplied paths.
- HTTPS fetches performed by `resolve_config` when `externalPresets: true` (github.com / gitlab.com / custom endpoints).

Out of scope:

- Vulnerabilities in [Renovate](https://github.com/renovatebot/renovate) itself — please report those upstream.
- Vulnerabilities in transitive dependencies that don't have a working exploit through `renovate-mcp`'s own surface (use [GitHub Dependabot alerts](https://github.com/tibuntu/renovate-mcp/security/dependabot) for those).
- Issues that require an attacker to already have local code execution or filesystem access on the host running the server.
