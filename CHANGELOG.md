# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.11] - 2026-04-22

### Changed
- Upgraded 15+ dependencies to resolve all known security vulnerabilities (protobufjs, undici, hono, music-metadata, vite, yaml, axios, and others)
- Added pnpm overrides to enforce patched versions of transitive dependencies

### Fixed
- Stripped test files from published npm tarball, reducing package size by ~500KB
- Updated CHANGELOG to reflect all releases

## [1.0.10] - 2026-04-21

### Added
- `allowFrom` option for Telegram channels in wizard channel setup
- Auto-detection of Telegram user ID via `getUpdates` in wizard sender trust

### Fixed
- Skipped redundant sender ID prompt when Telegram ID is auto-detected

## [1.0.9] - 2026-04-21

### Added
- Initial public open-source release
- 13-package TypeScript monorepo: shared, core, infra, memory, gateway, skills, scheduler, agent, channels, cli, daemon, web, comisai (umbrella)
- Channel adapters for Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, and Email
- Multi-agent architecture with DAG pipeline orchestration
- Persistent semantic memory with vector search and trust partitioning
- 50+ built-in tool integrations with MCP (Model Context Protocol) support
- 17 security layers including OS-level sandbox, secret encryption, and approval gates
- 7-layer context engine with prompt cache optimization and compaction
- Three-tier budget guard for cost control (per-request, daily, monthly)
- HTTP, JSON-RPC 2.0, and WebSocket gateway with token authentication
- Full CLI with 64 commands across 15 command groups
- Web dashboard for monitoring and configuration
- One-line VPS installer with systemd integration and sudoers setup
- Support for Anthropic, OpenAI, and Google AI providers

[Unreleased]: https://github.com/comisai/comis/compare/v1.0.11...HEAD
[1.0.11]: https://github.com/comisai/comis/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/comisai/comis/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/comisai/comis/releases/tag/v1.0.9
