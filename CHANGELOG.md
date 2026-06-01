# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Credential storage config migration — breaking changes (v1.5)

#### Breaking Changes

**Config migration required** — three legacy credential-storage config keys have
been removed (no-BC, AGENTS.md §2.9):

- `oauth.storage` — removed; replace with `security.storage: encrypted|file|env`
- `security.secrets.enabled` — removed; `security.storage: env` is the replacement
- `COMIS_DISABLE_ENCRYPTED_SECRETS` env var — removed; set `security.storage: env`
  in your `config.yaml` instead

A config still containing these keys will fail boot with a `ConfigError`
(`MIGRATION_ERROR`) naming `security.storage` and the exact replacement.
Mixed-mode configs (e.g. `oauth.storage: file` + encrypted secrets) will receive
an error explaining which credential store would be stranded.

**Migration steps:**
1. Back up your config: `cp ~/.comis/config.yaml ~/.comis/config.yaml.pre-v1.5`
2. Remove legacy keys and add `security.storage: encrypted` (default) or `file`/`env`
3. Edit config BEFORE starting the new binary (stale config fails boot)
4. Rolling back requires restoring both the binary and the pre-v1.5 config.

---

### Encrypted secrets store — behavior break (v1.1)

#### Breaking Changes

- **Encrypted secrets store is now opt-out (was opt-in)** — On first boot with no
  `SECRETS_MASTER_KEY` set, Comis auto-generates a master key and writes it to
  `~/.comis/.env` (mode 0600). The encrypted store is usable immediately on the same
  boot with no restart required. **Action required for existing installs:** Back up
  `~/.comis/.env` — losing `SECRETS_MASTER_KEY` makes `secrets.db` permanently
  unreadable. To keep the prior behavior (no encrypted store), set
  `COMIS_DISABLE_ENCRYPTED_SECRETS=1`. This is a deliberate behavior break; see
  [Secrets management](/operations/docker#secrets-management) for the full posture change.

#### Added

- `COMIS_DISABLE_ENCRYPTED_SECRETS=1` env flag — opts out of auto-init; daemon boots in
  envfile-only mode with a startup WARN.
- `env_set` now returns an immediate `secrets_store_unavailable` error (with actionable
  hint) when the encrypted store is not configured — no confirmation dance, no rate-limit
  consumption.

---

### Memory + Core port/schema deletions — Schema Tier

This sub-release closes the Schema Tier: 7 dead SQLite columns
dropped across 3 tables, 2 paired `SecretStorePort` methods removed, and 39
unused row-schema type aliases deleted. The `secrets` column drop is paired
with a **public CLI shape break** in `comis secrets list` and a corresponding
break in the `SecretMetadata` / `EnvListEntry` daemon RPC contracts.

#### Operator-Facing Changes — BREAKING

**`comis secrets list` table now has 3 columns instead of 5.** The `Last Used`
and `Usage Count` columns are gone, alongside the underlying
`SecretStorePort.recordUsage()` method and the `last_used_at` /
`usage_count` columns in `~/.comis/secrets.db`. The data was never displayed
elsewhere — operators relying on usage telemetry should migrate to the
structured `audit:event` event-bus stream, which already captures secret
access events.

Before (v2.3 and earlier):

| Name | Provider | Created | Last Used | Usage Count |
|------|----------|---------|-----------|-------------|

After (v2.3):

| Name | Provider | Created |
|------|----------|---------|

**`SecretMetadata` interface no longer carries `lastUsedAt` or `usageCount`.**
The daemon's `secrets.list` and `env.list` RPC payloads dropped these fields.
`packages/web/src/api/contracts.generated.ts` has been regenerated to reflect
the new shape. Direct consumers of the daemon RPC (web SPA, third-party
admin tooling, etc.) must drop these fields from their type definitions.

**`SecretStorePort.exists()` and `SecretStorePort.recordUsage()` removed.**
Internal hexagonal-port surface trim (paired with the `secrets` schema
deletion). The two methods had zero production callers — `exists()` was
shadowed by `getDecrypted()` returning `undefined`, and `recordUsage()` was
never wired into any production flow.

#### Operator-Facing Changes — orphan column tolerance

Existing `~/.comis/secrets.db` files retain orphan `last_used_at` and
`usage_count` columns. SQLite tolerates extra columns at INSERT/SELECT when
not listed in the statement, so legacy databases continue to work without
migration. Per the no-backward-compatibility policy: no
`ALTER TABLE DROP COLUMN` migration is run, no shim is added. To clean up
manually:

```bash
# Simpler path: delete the DB and re-import secrets (encrypted contents
# are unreadable without the master key anyway)
rm ~/.comis/secrets.db ~/.comis/secrets.db-wal ~/.comis/secrets.db-shm
```

The same orphan-column tolerance applies to:

- `delivery_queue.format_applied` / `chunking_applied` /
  `markdown_fallback_applied` / `delivered_message_id` (4 columns, never
  read by any code path after this deletion).
- `obs_token_usage.execution_id` (1 column; the event-bus payload
  `observability:token_usage.executionId` is **unaffected** — it is a
  different surface).

#### Engineering-Facing Changes

- 4 dead columns dropped from the `delivery_queue` table.
  `DeliveryQueueEntry` interface trimmed; `DeliveryQueueEnqueueInput` Omit
  list shrunk by 2 entries. Producer enqueue calls at
  `delivery-service.ts:352` and `notification-service.ts:203` no longer pass
  `formatApplied` / `chunkingApplied`. The `ackStmt` UPDATE no longer writes
  `delivered_message_id`.
- 1 dead column dropped from `obs_token_usage`.
  `TokenUsageRow` interface + `TokenUsageDbRow` snake_case row type +
  `tokenUsageFromRow` mapper + `tokenUsageEventToRow` event-to-row mapper
  trimmed. The agent-side `executionId` event payload remains.
- 2 columns dropped from `secrets`;
  `SecretStorePort.exists` and `SecretStorePort.recordUsage` deleted;
  `SecretMetadata.lastUsedAt` and `SecretMetadata.usageCount` deleted;
  matching `SecretMetadataSchema` (`api-contracts/secrets.ts`) and
  `EnvListEntrySchema` (`api-contracts/config.ts`) Zod fields removed;
  `contracts.generated.ts` regenerated via `pnpm contracts:generate`;
  daemon `env-handlers.ts` metadata projection cleaned;
  `cli/src/commands/secrets.ts` `renderTable(...)` shrunk to 3 columns.
- 39 unused `*FromSchema` type aliases dropped from
  `packages/memory/src/row-schemas.ts`. The Zod schemas themselves
  (`*RowSchema`) are preserved — they remain the SSOT for the row mapper
  parses. Zero external consumers of the deleted aliases were found via
  cross-package grep.

### Memory + Core port/schema deletions — Isolation Tier

This sub-release removes 3 dead memory modules (~1,700 prod LOC + ~1,250 test LOC)
that had zero production callers. The deleted modules backed three SQLite tables
that are no longer created on fresh `~/.comis/memory.db` databases.

#### Operator-Facing Changes — orphan-table tolerance

Three memory tables are no longer created on fresh `~/.comis/memory.db` databases:

- `archives` (compaction service deleted — `compaction.ts` had zero callers)
- `identity_links` (cross-platform identity mapping deleted — never wired into
  production; the in-memory identity-binding at the channel-adapter ingress layer
  is unaffected)
- `credential_mappings` (CredentialMappingStore deleted — daemon wiring branch
  `if (credentialMappingStore) { ... }` in setup-tools.ts was dead code; the
  `credentialMappingStore` Deps field was never populated in production)

Existing legacy `memory.db` files retain these tables as orphans — harmless
because no code path reads or writes them after this deletion (SQLite tolerates
unreferenced tables). Per the no-backward-compatibility policy: no
`ALTER TABLE DROP TABLE` migration is run, no shim is added. To clean up
manually:

```bash
sqlite3 ~/.comis/memory.db \
  'DROP TABLE IF EXISTS archives; \
   DROP TABLE IF EXISTS identity_links; \
   DROP TABLE IF EXISTS credential_mappings;'
```

#### Engineering-Facing Changes

- `packages/memory/src/compaction.ts` (297 LOC) + paired test
  (450 LOC) deleted. The `archives` CREATE TABLE block in `schema.ts:172-181`
  removed. The `storeWithType` method on `SqliteMemoryAdapter` (only called
  by the deleted compaction service) deleted; 2 callers in `memory-api.test.ts`
  retargeted to `adapter.store(entry)` (the store method already reads
  `entry.memoryType`, so behavior is identical).
- `packages/memory/src/identity-link-store.ts` (134 LOC) +
  paired test (119 LOC); `packages/agent/src/identity/identity-link-resolver.ts`
  (90 LOC, leaf-of-leaf) + paired test (139 LOC) deleted. The `identity_links`
  CREATE TABLE block in `schema.ts:184-194` and `IdentityLinkRowSchema` Zod
  block in `row-schemas.ts:669-682` removed. Barrel re-exports for
  `createIdentityLinkResolver`/`IdentityLinkResolver`/`IdentityLinkResolverDeps`
  dropped from `packages/agent/src/index.ts:160-161`.
- `packages/memory/src/credential-mapping-store.ts` (157 LOC) +
  paired test (421 LOC); `packages/memory/src/credential-mapping-schema.ts`
  (43 LOC) + paired test deleted. `CredentialMappingRowSchema` in
  `row-schemas.ts:602-610` and 3 `credentialMappingStore`-mocking test blocks
  in `setup-tools.test.ts` deleted. `setup-tools.ts` lost its
  `credentialMappingStore?: CredentialMappingPort` Deps field, its
  destructure, and the entire `if (credentialMappingStore) { ... }` branch
  (dead code in production wiring). Barrel re-exports for now-orphaned
  `CredentialMappingPort` (from `core/src/ports/index.ts` +
  `core/src/exports/ports.ts`) and `createCredentialInjector`/`CredentialInjector`
  (from `skills/src/skills/index.ts`) dropped. The port file
  (`packages/core/src/ports/credential-mapping.ts`) is preserved for a
  follow-up port-trim sweep. The domain type
  (`packages/core/src/domain/credential-mapping.ts`) is preserved permanently —
  still used by `packages/skills/src/skills/bridge/credential-injector.ts`.
- **Allowlist sync**: 1 `rawThrowAllowlist` entry (memory/src/credential-mapping-store.ts)
  drained from `test/support/architecture-allowlist.ts`; 3 `@comis/agent`
  baseline orphan strings dropped from `test/support/public-api-policy.ts`
  (`createIdentityLinkResolver`, `IdentityLinkResolver`,
  `IdentityLinkResolverDeps`).

### Memory + Core port/schema deletions — backward-compatibility stragglers

This sub-release closes 5 backward-compatibility stragglers that escaped v2.1's
line-pinned `noBackwardCompatAllowlist` regex. Per the no-backward-compatibility
policy the project does not ship migration shims, alias re-exports, or
default-to-old-behavior fallbacks — these stragglers are mostly migration shims,
comment-only "legacy" naming, and one redundant event-payload field.

#### Operator-Facing Changes — BREAKING

**`migrateConfig` deleted.** The `core/src/config/migrate.ts`
streaming-config migration shim is gone. Pre-v2.2 YAML configs using the
following deprecated keys will now fail Zod validation at daemon start:

- `streaming.defaultPacingMinMs` / `streaming.defaultPacingMaxMs` — migrate to
  `streaming.defaultDeliveryTiming.minMs` / `streaming.defaultDeliveryTiming.maxMs`
- `streaming.perChannel.*.pacingMinMs` / `streaming.perChannel.*.pacingMaxMs` —
  migrate to `streaming.perChannel.*.deliveryTiming.minMs` /
  `streaming.perChannel.*.deliveryTiming.maxMs`
- `streaming.perChannel.*.coalesceMaxChars` — migrate to
  `streaming.perChannel.*.coalescer.maxChars`

The `@remove-after: v2.2` marker on the shim was honored — v2.2 closed
2026-05-21. Operators with the deprecated keys in `~/.comis/config.yaml`
must update them to canonical form before deploying this release; the Zod
error message lists the offending fields.

**5 memory `ALTER TABLE ADD COLUMN` shims deleted.** Pre-agent-isolation
(`memories.agent_id`) and pre-cache-cost
(`obs_token_usage.{cost_cache_read, cost_cache_write, cache_saved, cache_retention}`)
memory.db files are no longer auto-migrated at daemon start. Fresh databases
created by current code already include these columns via the CREATE TABLE
statements (no behavior change for new installs). Operators with legacy DBs
predating these migrations must wipe `~/.comis/memory.db` to upgrade:

```bash
rm ~/.comis/memory.db   # daemon recreates on next start with current schema
```

The earlier agent-isolation migration shipped 2026-05-11; v2.3 starts
2026-05-21 — all real users would have re-created their DBs in the
intervening 10-day window. Per the no-backward-compatibility policy.

#### Engineering-Facing Changes

- `packages/core/src/config/migrate.ts` (~127 LOC) + paired
  test (~290 LOC) deleted. `migrateConfig` re-export dropped from
  `core/src/config/index.ts`; `mergeLayered` in `core/src/config/layered.ts`
  now calls `validateConfig(merged)` directly (no migration step). The
  `noBackwardCompatAllowlist` array in `test/support/architecture-allowlist.ts`
  is now empty (`[] as const`) — the migrate.ts entry was its only member.
  One test case in `layered.test.ts` ("migrates legacy streaming keys before
  validation") removed.
- 5 `ALTER TABLE` try/catch shims removed from
  `packages/memory/src/schema.ts`. The CREATE TABLE blocks for `memories`
  (with `agent_id`) and `obs_token_usage` (with `cost_cache_read`,
  `cost_cache_write`, `cache_saved`, `cache_retention`) already define these
  columns, so fresh databases are unaffected.
- 4 "legacy mode" references in `packages/memory/src/setup-secrets.ts`
  renamed to "envfile mode" / "envfile-only mode" (comment-only edits;
  behavior unchanged). The L64 user-facing error message wording updates from
  "or remove the variable for legacy mode." to "or remove the variable for
  envfile-only mode."
- `profileName` field removed from the `auth:token_rotated`
  event-bus payload (`packages/core/src/event-bus/events-infra.ts`); the
  stale "Coexists with profileName for backward compat" JSDoc on `profileId`
  dropped. The emit site in `packages/agent/src/model/oauth-token-manager.ts`
  no longer sets `profileName` (only the canonical `profileId`,
  `expiresAtMs`, `timestamp` remain). Tests in `events-infra.test.ts` and
  `oauth-token-manager.test.ts` updated.
- "(backward compat)" parenthetical dropped from
  `packages/core/src/config/schema-secrets.ts:6` JSDoc; "for backward compat"
  in `schema-secrets.ts:14` replaced with "(opt-in to encrypted secrets
  store)"; "for backward compatibility" in
  `packages/core/src/config/schema-channel.ts:22` replaced with "(opt-out
  per-channel)". Comment-only edits; behavior unchanged.

### Skills + Channels + Orchestrator Dead-Code Deletion

This release removes ~2,500 prod LOC of verified-dead code across `packages/skills`, `packages/channels`, `packages/orchestrator`, `packages/core`, `packages/shared`, and `packages/web`. All deletions have ZERO production callers (verified via grep against the current source tree); the only behavior-preserving change is inlining `multimodal-analyzer.ts` into 2 thin vision-provider factories.

#### Operator-Facing Changes — BREAKING

**`queue.priorityEnabled`, `queue.priorityLanes`, and `queue.laneAssignment` removed from operator config.** The priority-scheduler subsystem (`packages/orchestrator/src/queue/priority-scheduler.ts`) never instantiated in production — `priorityEnabled` defaulted to `false` and zero daemon code paths constructed the scheduler. The `QueueConfigSchema` is `z.strictObject`; operators with any of these keys in `~/.comis/config.yaml` will hit a Zod `unrecognized_keys` parse error on next daemon start. **Required action: remove these keys from your config before deploying this release.** Example error:

```
ZodError: Unrecognized key(s) in object: 'priorityEnabled'
```

Per the no-backward-compatibility policy, no migration shim is provided (no `.passthrough()` fallback) — the failure is loud and immediate at startup, matching Comis's design preference for legible Zod errors over silent compat layers.

#### Engineering-Facing Changes

- **`multimodal-analyzer.ts` inlined** into 2 thin VisionProvider factories (`createAnthropicVisionProvider`, `createOpenAIVisionProvider`) inside `vision-provider-registry.ts`. The `ImageAnalysisPort → VisionProvider` adapter hop is gone; each factory directly owns its backend HTTP call. ~216 LOC removed.
- **4 dead media factories deleted**: `createImageProcessor`, `createMediaStore`, `createFileValidator`, `extractAudioMetadata` (~706 LOC).
- **2 dead browser utilities deleted**: `smartWait`, `normalizeScreenshot` (~294 LOC).
- **Discord + Signal MediaResolverPort deleted**: `createDiscordResolver` + `createSignalResolver` (~419 LOC). Both factories were exported but never registered in `CompositeResolver`; daemon's media-fetch path uses the SSRF fallback for Discord CDN + signal-cli URLs (unchanged).
- **Priority-scheduler subsystem deleted** (~1,274 LOC across orchestrator + core + web): `priority-scheduler.ts` + test; `command-queue.ts` collapsed to globalGate-only path (17 surgical edits removed `priorityScheduler` / `priorityLane` plumbing); `inbound-route.ts` `assignPriorityLane` helper + if-block deleted; `inbound-pipeline.ts` + `channel-manager.ts` deps slots deleted; `schema-queue.ts` `PriorityLaneConfigSchema` + `LaneAssignmentConfigSchema` + 3 root fields deleted; `agent-queue-editor.ts` "Priority Lanes" section + 2 helpers deleted.
- **5 dead event-bus events deleted**: `skill:created`, `skill:updated`, `skills:reloaded` (covered by `audit:event` lifecycle capture); `priority:aged_promotion`, `priority:lane_assigned` (zero production subscribers; emit sites lived in deleted code).
- **`parseSanitizedMcpToolName` shared utility deleted** — JSDoc admitted "Future install-detour parser will consume" — that future never materialized. Install-detour code uses its own logic. ~70 LOC removed.
- **`browser-tool.ts` signature narrowed**: `RpcCall`-or-deps-object dual-shape signature narrowed to canonical form; 10 daemon imports of `RpcCall` retargeted from `@comis/skills` to `@comis/skills/platform-tools`; transitional `RpcCall` re-export at `packages/skills/src/skills/index.ts:224` deleted.
- **Architecture allowlists trimmed**: 2 `rawThrowAllowlist` entries (`discord-resolver.ts`, `signal-resolver.ts`); 6 `public-api-policy` orphan baselines (`createPriorityScheduler`, `PrioritySchedulerDeps`, `LaneStats`, `PriorityLaneConfigSchema`, `LaneAssignmentConfigSchema`, `parseSanitizedMcpToolName`); 1 path-tail allowlist entry (`browser-tool.ts`).

### Observability Stack Hardening

This release closes three drifts between the observability-stack design notes and shipped code (cache-breaks dir-mode invariant, `diagnostics.cacheTrace.enabled` default flip without doc-update, and the stage-taxonomy divergence), and adds a build-failing architecture-test layer that prevents future drift.

#### Operator-Facing Changes

- **`diagnostics.cacheTrace.enabled` default flipped to `true`** (commit `0b157dd2`, 2026-05-20). The PII gate `includeMessages: false` is retained — payloads carry `messagesDigest` only by default. Operators who want full message payloads must explicitly set `includeMessages: true`.
- **New `diagnostics.cacheTrace.maxFileBytes` operator knob** (default 50 MB, parity with `diagnostics.trajectory.maxFileBytes`). Operators can tune the per-file cap in `~/.comis/config.yaml`. When the cap is hit, the cache-trace runtime emits a `cache_trace.write_failures` sentinel event (see below) instead of silently dropping events.
- **Proactive `cache_trace.write_failures` sentinel** — when the queued writer rejects an append due to `FileSizeLimitExceeded`, the cache-trace runtime emits exactly ONE inline sentinel event at first rejection (`data.firstDropAt`, `data.droppedEvents`, `data.droppedBytes`, `data.reason`) — visible immediately to `tail -f | jq` operators. A second summary sentinel fires at session `flushAndClose` carrying `data.sessionLifetimeMs` + `data.totalDroppedBytes`. Sessions that never hit the cap produce zero sentinels.

#### Engineering-Facing Changes

- **~10 observability-adjacent writers migrated to `@comis/observability/shared/fs-safe.ts`** — `cache-break-diff-writer.ts`, `background-task-persistence.ts`, `microcompaction-guard.ts`, `comis-session-manager.ts`, `sanitize-session-secrets.ts`, `restart-continuation.ts`, `setup-shutdown.ts`, `device-pairing.ts`, `device-identity.ts`, `skill-handlers.ts`, plus 6 graph-* writers. All now use `ensureContainedDir` + `writeRegularFile` from the shared substrate, restoring the `0o700`/`0o600` mode invariant for every artifact under `~/.comis/`.
- **New `ensureContainedDir` substrate helper** in `@comis/observability/shared/fs-safe.ts`, joining `appendRegularFile` and `writeRegularFile` as the three canonical entry points for any writer under `~/.comis/`. Unifies the previously-duplicated `mkdir + lstat-gated chmod + symlink-rejection` pattern; opt-in `confinedBaseDir` real-path check via the existing `assertConfinedPath` internal helper.
- **Design doc parity sweep** — six edits to the design notes aligning the design language with shipped code (default-on cacheTrace, new maxFileBytes knob, stage taxonomy rewrite to enumerate the 11 shipped stages).
- **EventBus extension:** the existing `prompt:submitted` event is now consumed by both trajectory (via `attachTrajectoryToEventBus`) and cache-trace (via the extended `attachCacheTraceToEventBus`) bridges. The cache-trace bridge's mapping table extends from 1 → 8 event subscriptions, wiring the 7 previously-reserved-but-unwired stages from the stage taxonomy.

#### Architecture Tests

Three new tests form the design ↔ code enforcement layer:

- **`test/architecture/observability-mode-invariants.test.ts`** — AST walker over `packages/**/src/**/*.ts` flagging any direct `fs.mkdirSync` / `fs.writeFileSync` / `fs.promises.mkdir` / `fs.promises.writeFile` call lacking an explicit literal `mode:` arg of `0o700` (mkdir) or `0o600` (writeFile). Allowlist is empty after this release's sweep; the `fs-safe.ts` substrate is path-allowlisted (it's the layer the rule defers to). Inline `// fs-safe-allowed: <reason>` opt-out follows the `// @allow-throw:` precedent.
- **`test/architecture/cache-trace-stages-known.test.ts`** — closed-union enforcement on every `recordStage(<literal>, ...)` call site in `packages/observability/src/cache-trace/` and `packages/agent/src/` — the first arg must be a member of `CACHE_TRACE_STAGES`. Also asserts every member of `CACHE_TRACE_STAGES` has at least one producer call site (excluding `cache_trace.write_failures` which is sentinel-only).
- **`test/architecture/design-schema-parity.test.ts`** — parses the Zod block in the design notes and asserts field-by-field default parity against the runtime `DiagnosticsConfigSchema` in `packages/core/src/config/schema-diagnostics.ts` for every `diagnostics.*` default (`trajectory.enabled`, `trajectory.maxFileBytes`, `cacheTrace.enabled`, `cacheTrace.maxFileBytes`, `cacheTrace.includeMessages`, `cacheTrace.includePrompt`, `cacheTrace.includeSystem`, `configAudit.enabled`, `configAudit.rotateAtBytes`, `configAudit.keepRotated`).

#### SemVer note

The cache-trace v1 schema (`schemaVersion: 1` in `traceSchema: "comis-cache-trace"`) is the now-stable baseline. The stage taxonomy was rewritten on 2026-05-21 to match shipped code (closing the pre-existing reserved-but-unwired gap); the append-only insertion-order rule applies from 2026-05-21 forward. New stages may be appended; existing stages may not be reordered or removed without bumping `schemaVersion`.

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

- Zero `/backward.?compat|backcompat|legacy.?(alias|mode|fallback)/i` text outside `noBackwardCompatAllowlist` (line-pinned, max 3 entries) and outside an in-file path-tail allowlist (pre-existing benign-text files documented at baseline).
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
