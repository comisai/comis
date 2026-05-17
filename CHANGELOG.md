# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Unreleased / v2.1 — Backward-Compatibility + Dead-Code Removal

This release deletes every backward-compatibility shim, alias re-export, legacy gate-off path, legacy field alias, and dead export from the v2.1 source tree. No BC code remains in production source except one explicitly-kept config migration (under `@migration-since: 2026-04-22; @remove-after: v2.2`).

#### Intentional Behavior Breaks

**BREAKING**: Session-key serialization no longer includes an `agent:<agentId>:` prefix, and the matching parser branch is gone. Both halves of the round-trip (`formatSessionKey` + `parseFormattedSessionKey` in `packages/core/src/domain/session-key.ts`) now treat agent isolation as out-of-band; the canonical format is `{tenantId}:{userId}:{channelId}[:peer:...][:guild:...][:thread:...]`. Sessions persisted with the legacy `agent:<agentId>:<tenantId>:<peerId>:...` key format are un-mappable after upgrade. The `agents.*.session.dmScope.agentPrefix` config option is removed from the schema — operators with `agentPrefix: true` in their YAML will see a strict-object validation error at config load (loud, not silent). Operators upgrading from v2.0 should delete stale session files under `~/.comis/sessions/` and lock files under `~/.comis/.locks/` if any remain (these would normally have been migrated by the SDK SessionManager's first-write on any active session since v2.1). New sessions are unaffected.

**BREAKING**: The context-engine tool-result-cleared masker now recognizes only the canonical `[Tool result summarized:` prefix. Tool-result messages persisted with the pre-v2.1 `[Tool result cleared:` prefix are not re-recognized as already-masked after upgrade — they remain visible in the session history but cannot be re-compacted by the context-engine cleanup pass. The dag-annotator continues to recognize both prefixes for its own duplicate-annotation skip; only the `cleanup-helpers.ts:isAlreadyMasked` check has been narrowed. To clean up affected sessions, operators can manually delete the legacy-prefixed messages from the corresponding session file or restart the affected sessions.

**BREAKING**: The legacy `tooling.capabilityIndex.enabled` config gate is removed from the static-prompt path. The capability-index has been the default and only path for several releases; the legacy flat-tooling-block fallback in `packages/agent/src/bootstrap/sections/tooling-sections.ts` is no longer reachable. Operators with `tooling.capabilityIndex.enabled: false` in their config saw the flag silently ignored by the static-prompt assembler — the dynamic-preamble per-turn renderer still honors it. The `capabilityIndexEnabled` parameter is removed from every call site (`system-prompt-assembler.ts`, `prompt-assembly.ts`, `bootstrap-integration.test.ts`); operators can remove the key from their YAML for clarity.

#### Migration Code Audit

Every migration-code site was audited (don't blanket-delete). Results:

- **KEPT** — `packages/core/src/config/migrate.ts` (streaming-config schema migration: `defaultPacingMinMs/Max` + `coalesceMaxChars` → `defaultDeliveryTiming` / `coalescer`). Annotated with `@migration-since: 2026-04-22; @remove-after: v2.2`. Single entry in `noBackwardCompatAllowlist`. Operator-side migration is still realistic; the entry will be removed at v2.2 milestone close.

- **DELETED** — `packages/daemon/src/api/graph-handlers.ts:migrateLegacyDebate()` (30 lines including JSDoc + invocation + downstream rebind to `node`). The migration shipped on 2026-05-13 as part of the v2.0 Architecture Redesign squash; existing graph nodes have re-saved at least once since. Two test cases in `graph-handlers.test.ts` (`migrates legacy debate to typeId/typeConfig`, `downgrades single-agent legacy debate to regular node`) and the `transformNodes migration completeness` describe block were tombstoned with inline comments.

- **NO-OP** — `packages/orchestrator/src/cross-session/announcement-dead-letter.ts:108,316`. The design-doc claim of "legacy fields" was a stale carry-forward — both cited lines are raw-throw sites, not BC field aliases. No source change shipped.

#### Architectural Test

A new architecture rule at `test/architecture/no-backward-compat.test.ts` enforces 8 invariants on production source under `packages/*/src/`:

- Zero `/backward.?compat|backcompat|legacy.?(alias|mode|fallback)/i` text outside `noBackwardCompatAllowlist` (line-pinned, max 3 entries) and outside the in-file `BC_REM_02_PATH_TAIL_ALLOWLIST` (pre-existing benign-text files documented at baseline).
- Zero `@deprecated` JSDoc annotations (v2.1 no-deprecation policy).
- Zero `as` alias re-exports in `agent/src/index.ts`.
- Zero `@comis/shared` re-exports from `skills/src/index.ts` + `skills/src/skills/index.ts`.
- Zero `createCommandHandler` / `CommandHandlerDeps` exports from `agent/src/index.ts`.
- `cli/src/index.ts` public value exports exactly `{ withClient, credentialsStep }`.
- Zero `getGlobalHookRunner` / `hook-runner-global` references (defense-in-depth).
- Zero `eslint-disable` comments citing `legacy` or `backward compat` as justification (pragma-drift guard).

The `noBackwardCompatAllowlist` final state is **exactly 1 entry** (`migrate.ts:1`), well below the cap of 3.

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
