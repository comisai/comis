# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Phase 48 — Observability Stack Hardening: Workstream A Closeout

This release closes three drifts between `design/observability-stack-workstream-a.md` and shipped code (cache-breaks dir-mode invariant, `diagnostics.cacheTrace.enabled` default flip without doc-update, and the §7.2 stage-taxonomy divergence), and adds a build-failing architecture-test layer that prevents future drift.

#### Operator-Facing Changes

- **`diagnostics.cacheTrace.enabled` default flipped to `true`** (commit `0b157dd2`, 2026-05-20). The PII gate `includeMessages: false` is retained — payloads carry `messagesDigest` only by default. Operators who want full message payloads must explicitly set `includeMessages: true`.
- **New `diagnostics.cacheTrace.maxFileBytes` operator knob** (default 50 MB, parity with `diagnostics.trajectory.maxFileBytes`). Operators can tune the per-file cap in `~/.comis/config.yaml`. When the cap is hit, the cache-trace runtime emits a `cache_trace.write_failures` sentinel event (see below) instead of silently dropping events.
- **Proactive `cache_trace.write_failures` sentinel** — when the queued writer rejects an append due to `FileSizeLimitExceeded`, the cache-trace runtime emits exactly ONE inline sentinel event at first rejection (`data.firstDropAt`, `data.droppedEvents`, `data.droppedBytes`, `data.reason`) — visible immediately to `tail -f | jq` operators. A second summary sentinel fires at session `flushAndClose` carrying `data.sessionLifetimeMs` + `data.totalDroppedBytes`. Sessions that never hit the cap produce zero sentinels.

#### Engineering-Facing Changes

- **~10 observability-adjacent writers migrated to `@comis/observability/shared/fs-safe.ts`** — `cache-break-diff-writer.ts`, `background-task-persistence.ts`, `microcompaction-guard.ts`, `comis-session-manager.ts`, `sanitize-session-secrets.ts`, `restart-continuation.ts`, `setup-shutdown.ts`, `device-pairing.ts`, `device-identity.ts`, `skill-handlers.ts`, plus 6 graph-* writers. All now use `ensureContainedDir` + `writeRegularFile` from the shared substrate, restoring the design §1.4 `0o700`/`0o600` mode invariant for every artifact under `~/.comis/`.
- **New `ensureContainedDir` substrate helper** in `@comis/observability/shared/fs-safe.ts`, joining `appendRegularFile` and `writeRegularFile` as the three canonical entry points for any writer under `~/.comis/`. Unifies the previously-duplicated `mkdir + lstat-gated chmod + symlink-rejection` pattern; opt-in `confinedBaseDir` real-path check via the existing `assertConfinedPath` internal helper.
- **Design doc §§1.3/1.4/2.8/7.2/7.4/12 parity sweep** — six edits to `.planning/design/observability-stack-workstream-a.md` aligning the design language with shipped code (default-on cacheTrace, new maxFileBytes knob, §7.2 stage taxonomy rewrite to enumerate the 11 shipped stages).
- **EventBus extension:** the existing `prompt:submitted` event is now consumed by both trajectory (via `attachTrajectoryToEventBus`) and cache-trace (via the extended `attachCacheTraceToEventBus`) bridges. The cache-trace bridge's mapping table extends from 1 → 8 event subscriptions, wiring the 7 previously-reserved-but-unwired stages from the §7.2 taxonomy.

#### Architecture Tests

Three new tests form the design ↔ code enforcement layer:

- **`test/architecture/observability-mode-invariants.test.ts`** — AST walker over `packages/**/src/**/*.ts` flagging any direct `fs.mkdirSync` / `fs.writeFileSync` / `fs.promises.mkdir` / `fs.promises.writeFile` call lacking an explicit literal `mode:` arg of `0o700` (mkdir) or `0o600` (writeFile). Allowlist is empty after the Phase 48 sweep; the `fs-safe.ts` substrate is path-allowlisted (it's the layer the rule defers to). Inline `// fs-safe-allowed: <reason>` opt-out follows the `// @allow-throw:` precedent.
- **`test/architecture/cache-trace-stages-known.test.ts`** — closed-union enforcement on every `recordStage(<literal>, ...)` call site in `packages/observability/src/cache-trace/` and `packages/agent/src/` — the first arg must be a member of `CACHE_TRACE_STAGES`. Also asserts every member of `CACHE_TRACE_STAGES` has at least one producer call site (excluding `cache_trace.write_failures` which is sentinel-only).
- **`test/architecture/design-schema-parity.test.ts`** — parses the §12 Zod block in `.planning/design/observability-stack-workstream-a.md` and asserts field-by-field default parity against the runtime `DiagnosticsConfigSchema` in `packages/core/src/config/schema-diagnostics.ts` for every `diagnostics.*` default (`trajectory.enabled`, `trajectory.maxFileBytes`, `cacheTrace.enabled`, `cacheTrace.maxFileBytes`, `cacheTrace.includeMessages`, `cacheTrace.includePrompt`, `cacheTrace.includeSystem`, `configAudit.enabled`, `configAudit.rotateAtBytes`, `configAudit.keepRotated`).

#### SemVer note

The cache-trace v1 schema (`schemaVersion: 1` in `traceSchema: "comis-cache-trace"`) is the now-stable baseline. The §7.2 stage taxonomy was rewritten on 2026-05-21 to match shipped code (closing the pre-Phase-48 reserved-but-unwired gap); the append-only insertion-order rule applies from 2026-05-21 forward. New stages may be appended; existing stages may not be reordered or removed without bumping `schemaVersion`.

#### Roadmap

Phase 48 `Depends on:` is corrected to `Phase 46 (CACHE-OBS substrate)`. Phase 48 is technically independent of Phase 47 (MCP-PERSIST) — the two may ship in parallel.

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
