# Changelog

This file records user-visible changes to Comis. Detailed release history is available in [GitHub Releases](https://github.com/comisai/comis/releases).

## [Unreleased]

### Added

- A focused public website, contributor onboarding, issue templates, and security reporting guidance.
- Clearer operator documentation for installation, configuration, providers, channels, and the supported API surfaces.

### Changed

- The Linux installer now supports a review-first workflow: download, inspect, run `--dry-run`, and then execute.
- The dashboard setup and configuration screens now expose only operations backed by the daemon.
- Public package documentation and metadata now describe the current source and package boundaries.

### Fixed

- New and recreated workspaces now enter first-run onboarding, and the active bootstrap state reaches prompt assembly instead of being omitted as an unchanged operator placeholder.
- Provider status, CLI setup guidance, token-limit labels, and degraded-response instructions now reflect the runtime behavior.
- Dashboard controls have clearer accessible names and reduce accidental secret exposure.
- Gateway RPC failures no longer return internal exception details to clients.
- The installer now fails closed on incomplete prerequisites and validates the installed CLI before reporting success.

### Security

- Installation guidance avoids executing remote scripts without an inspection and dry-run step.
- Labelled password, token, secret, credential, and API-key assignments are blocked from learned memory and redacted again during recall, including ordinary credential values without a provider-specific token prefix.
- Error responses and dashboard secret handling expose less sensitive operational detail.

### Operator action required

- None currently announced for the unreleased changes.

## [1.0.53] - 2026-07-13

Current published baseline. See the [v1.0.53 release](https://github.com/comisai/comis/releases/tag/v1.0.53) for its generated notes and artifacts.

[Unreleased]: https://github.com/comisai/comis/compare/v1.0.53...HEAD
[1.0.53]: https://github.com/comisai/comis/releases/tag/v1.0.53
