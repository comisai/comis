// SPDX-License-Identifier: Apache-2.0
/**
 * Zod schemas for memory-package SQLite row types.
 *
 * One schema per row interface. Used by `createRowMapper(schema)` in
 * `row-mapper.ts` to replace `db.prepare(...).all() as Foo[]` casts at
 * every SQLite call site.
 *
 * Schemas live HERE (consumer-side `memory/`) and NOT in
 * `@comis/core/ports/*` to preserve core's zero-runtime-Zod-dependency
 * boundary. Core's port files remain type-only — adding
 * `import { z } from "zod"` there would widen the public dependency
 * surface.
 *
 * ## Sectional layout
 *
 * 1. **Memory-package-local public rows** — paired 1:1 with the
 *    interfaces exported from `./types.js`. Each pair gets a
 *    `expectTypeOf<z.infer<typeof XSchema>>().toEqualTypeOf<X>()`
 *    assertion in `row-schemas.test.ts` to prevent silent schema drift.
 *
 * 2. **Context-store rows** — schemas paired with `Ctx*Row` interfaces
 *    re-exported from `@comis/core/ports/context-store-types`.
 *
 * 3. **Session-store DTOs** — schemas paired with the SessionData /
 *    SessionListEntry / SessionDetailedEntry shapes from
 *    `@comis/core/ports/session-store-types`.
 *
 * 4. **Internal DB-row schemas** — schemas matching file-internal
 *    snake_case DB row shapes used by observability-store,
 *    oauth-profile-store-encrypted, delivery-mirror-adapter,
 *    delivery-queue-adapter, embedding-cache-sqlite. The source
 *    interfaces are file-internal (no `export`); these schemas become
 *    the single-source-of-truth that consumers retarget to
 *    (via `z.infer<typeof XxxRowSchema>`).
 *
 * ## Conventions
 *
 * - Every schema is `z.strictObject(...)` — rejects unknown extra columns
 *   (defense-in-depth against schema drift).
 * - JSON-encoded TEXT columns are typed as `z.string()` here (the
 *   row-level shape). Parsing happens downstream in the consumer.
 * - SQLite stores booleans as `INTEGER` (0/1). Schemas use
 *   `z.number().int()` for those columns; the consumer coerces to boolean.
 * - Buffer columns (BLOB) use `z.instanceof(Buffer)` — better-sqlite3
 *   returns Node.js Buffer for BLOB columns.
 * - Nullable columns use `z.X.nullable()` (yields `X | null` — matches
 *   SQLite's NULL distinction from undefined).
 *
 * @module
 */

import { z } from "zod";

// =====================================================================
// 1. Memory-package-local public rows (paired with packages/memory/src/types.ts)
// =====================================================================

/**
 * Schema for the `memories` table.
 * Paired with `MemoryRow` exported from `./types.js`.
 */
export const MemoryRowSchema = z.strictObject({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  user_id: z.string(),
  content: z.string(),
  trust_level: z.string(),
  memory_type: z.string(),
  source_who: z.string(),
  source_channel: z.string().nullable(),
  source_session_key: z.string().nullable(),
  /** JSON-encoded string[] — consumer parses with `parseTags`. */
  tags: z.string(),
  /** Unix timestamp in milliseconds. */
  created_at: z.number(),
  /** Unix timestamp in milliseconds, null if event time unknown (TEMP-01). */
  occurred_at: z.number().nullable(),
  /** Unix timestamp in milliseconds, null if never updated. */
  updated_at: z.number().nullable(),
  /** Unix timestamp in milliseconds, null if no expiry. */
  expires_at: z.number().nullable(),
  /** 0 or 1 — whether vec_memories has an embedding for this entry. */
  has_embedding: z.number(),
});

/**
 * Schema for the `memory_entities` table (Phase 83, ENT-05).
 *
 * `canonical_key` is DB-row-ONLY (OQ-2): it is the normalized dedup/index key
 * (TS lower+NFKD+strip-marks — see entity-resolver.ts) and is intentionally
 * NOT a field on the strict `MemoryEntity` domain type in @comis/core, which
 * carries only the display `canonicalName`. The key is an implementation
 * detail of the resolver + UNIQUE index, not part of the domain contract.
 */
export const MemoryEntityRowSchema = z.strictObject({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  /** Display form (first-seen casing). */
  canonical_name: z.string(),
  /** Normalized dedup key; DB-row-only (not on the MemoryEntity domain type). */
  canonical_key: z.string(),
  mention_count: z.number(),
  /** Unix timestamp in milliseconds. */
  first_seen: z.number(),
  /** Unix timestamp in milliseconds. */
  last_seen: z.number(),
});

/**
 * Schema for the entity associative-lane self-join projection (Phase 83,
 * ENT-02; RESEARCH Pattern 2). The one-hop self-join over
 * `memory_entity_links` returns, per other memory, the count of distinct
 * entities it shares with the seed set. Parsed via `createRowMapper` in the
 * (Plan-02) lane query — never `as Row[]`.
 */
export const EntityLaneRowSchema = z.strictObject({
  memory_id: z.string(),
  /** COUNT(DISTINCT shared entity_id) — drives most-shared-first ordering. */
  shared: z.number(),
});

/**
 * Schema for the `sessions` table.
 * Paired with `SessionRow` exported from `./types.js`.
 */
export const SessionRowSchema = z.strictObject({
  session_key: z.string(),
  tenant_id: z.string(),
  user_id: z.string(),
  channel_id: z.string(),
  /** JSON-encoded unknown[]. */
  messages: z.string(),
  /** Unix timestamp in milliseconds. */
  created_at: z.number(),
  /** Unix timestamp in milliseconds. */
  updated_at: z.number(),
  /** JSON-encoded Record<string, unknown>. */
  metadata: z.string(),
});

/**
 * Schema for sqlite-vec KNN query results.
 * Paired with `VecSearchRow` exported from `./types.js`.
 */
export const VecSearchRowSchema = z.strictObject({
  memory_id: z.string(),
  distance: z.number(),
});

/**
 * Schema for FTS5 search joined with memories.
 * Paired with `FtsSearchRow` exported from `./types.js`.
 */
export const FtsSearchRowSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  rank: z.number(),
});

/**
 * Schema for the `named_graphs` table.
 * Paired with `NamedGraphRow` exported from `./types.js`.
 */
export const NamedGraphRowSchema = z.strictObject({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  label: z.string(),
  nodes: z.string(),
  edges: z.string(),
  settings: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().nullable(),
});

// =====================================================================
// 2. Context-store rows (paired with @comis/core/ports/context-store-types)
// =====================================================================

/**
 * Schema for the `ctx_conversations` table.
 * Paired with `CtxConversationRow` from `@comis/core`.
 */
export const CtxConversationRowSchema = z.strictObject({
  conversation_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  title: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Schema for the `ctx_messages` table.
 * Paired with `CtxMessageRow` from `@comis/core`.
 */
export const CtxMessageRowSchema = z.strictObject({
  message_id: z.number(),
  conversation_id: z.string(),
  seq: z.number(),
  role: z.string(),
  content: z.string(),
  content_hash: z.string(),
  token_count: z.number(),
  tool_name: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Schema for the `ctx_message_parts` table.
 * Paired with `CtxMessagePartRow` from `@comis/core`.
 */
export const CtxMessagePartRowSchema = z.strictObject({
  part_id: z.number(),
  message_id: z.number(),
  ordinal: z.number(),
  part_type: z.string(),
  content: z.string().nullable(),
  metadata: z.string().nullable(),
});

/**
 * Schema for the `ctx_summaries` table.
 * Paired with `CtxSummaryRow` from `@comis/core`.
 */
export const CtxSummaryRowSchema = z.strictObject({
  summary_id: z.string(),
  conversation_id: z.string(),
  kind: z.enum(["leaf", "condensed"]),
  depth: z.number(),
  content: z.string(),
  token_count: z.number(),
  file_ids: z.string(),
  earliest_at: z.string().nullable(),
  latest_at: z.string().nullable(),
  descendant_count: z.number(),
  descendant_token_count: z.number(),
  source_token_count: z.number(),
  counts_dirty: z.number(),
  quality_score: z.number().nullable(),
  compaction_level: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Schema for the `ctx_summary_messages` link table.
 * Paired with `CtxSummaryMessageRow` from `@comis/core`.
 */
export const CtxSummaryMessageRowSchema = z.strictObject({
  summary_id: z.string(),
  message_id: z.number(),
  ordinal: z.number(),
});

/**
 * Schema for the `ctx_summary_parents` link table.
 * Paired with `CtxSummaryParentRow` from `@comis/core`.
 */
export const CtxSummaryParentRowSchema = z.strictObject({
  summary_id: z.string(),
  parent_summary_id: z.string(),
  ordinal: z.number(),
});

/**
 * Schema for the `ctx_context_items` table.
 * Paired with `CtxContextItemRow` from `@comis/core`.
 */
export const CtxContextItemRowSchema = z.strictObject({
  conversation_id: z.string(),
  ordinal: z.number(),
  item_type: z.string(),
  message_id: z.number().nullable(),
  summary_id: z.string().nullable(),
});

/**
 * Schema for the `ctx_large_files` table.
 * Paired with `CtxLargeFileRow` from `@comis/core`.
 */
export const CtxLargeFileRowSchema = z.strictObject({
  file_id: z.string(),
  conversation_id: z.string(),
  file_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  byte_size: z.number().nullable(),
  content_hash: z.string().nullable(),
  storage_path: z.string(),
  exploration_summary: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Schema for the `ctx_expansion_grants` table.
 * Paired with `CtxExpansionGrantRow` from `@comis/core`.
 */
export const CtxExpansionGrantRowSchema = z.strictObject({
  grant_id: z.string(),
  issuer_session: z.string(),
  conversation_ids: z.string(),
  summary_ids: z.string(),
  max_depth: z.number(),
  token_cap: z.number(),
  tokens_consumed: z.number(),
  expires_at: z.string(),
  revoked: z.number(),
  created_at: z.string(),
});

// =====================================================================
// 3. Session-store DTOs (paired with @comis/core/ports/session-store-types)
// =====================================================================

/**
 * Schema for SessionStorePort.load() return shape.
 * Paired with `SessionData` from `@comis/core`.
 *
 * Note: `messages` is `unknown[]` (JSON-decoded from the `sessions.messages`
 * TEXT column). The Zod schema captures structural shape — element validation
 * happens downstream.
 */
export const SessionDataSchema = z.strictObject({
  messages: z.array(z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * Schema for SessionStorePort.list() rows.
 * Paired with `SessionListEntry` from `@comis/core`.
 */
export const SessionListEntrySchema = z.strictObject({
  sessionKey: z.string(),
  updatedAt: z.number(),
});

/**
 * Schema for SessionStorePort.listDetailed() rows.
 * Paired with `SessionDetailedEntry` from `@comis/core`.
 */
export const SessionDetailedEntrySchema = z.strictObject({
  sessionKey: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  channelId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
});

// =====================================================================
// 4. Internal DB-row schemas (single-source-of-truth for consumer
// retargeting; source interfaces are file-internal in their adapters)
// =====================================================================

// --- Observability store (packages/memory/src/observability-store.ts:211-317) ---

/**
 * Schema for the `token_usage` table.
 * SSOT for the file-internal `TokenUsageDbRow` interface in observability-store.ts.
 */
export const TokenUsageDbRowSchema = z.strictObject({
  id: z.number(),
  timestamp: z.number(),
  trace_id: z.string(),
  agent_id: z.string(),
  channel_id: z.string(),
  session_key: z.string(),
  provider: z.string(),
  model: z.string(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  cost_input: z.number(),
  cost_output: z.number(),
  cost_total: z.number(),
  cost_cache_read: z.number(),
  cost_cache_write: z.number(),
  cache_saved: z.number(),
  latency_ms: z.number(),
  cache_retention: z.string().nullable(),
});

/**
 * Schema for the `delivery` table.
 * SSOT for the file-internal `DeliveryDbRow` interface in observability-store.ts.
 */
export const DeliveryDbRowSchema = z.strictObject({
  id: z.number(),
  timestamp: z.number(),
  trace_id: z.string(),
  agent_id: z.string(),
  channel_type: z.string(),
  channel_id: z.string(),
  session_key: z.string(),
  status: z.string(),
  latency_ms: z.number(),
  error_message: z.string(),
  message_preview: z.string(),
  tool_calls: z.number(),
  llm_calls: z.number(),
  tokens_total: z.number(),
  cost_total: z.number(),
});

/**
 * Schema for the `diagnostics` table.
 * SSOT for the file-internal `DiagnosticDbRow` interface in observability-store.ts.
 */
export const DiagnosticDbRowSchema = z.strictObject({
  id: z.number(),
  timestamp: z.number(),
  category: z.string(),
  severity: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  message: z.string(),
  details: z.string(),
  trace_id: z.string(),
});

/**
 * Schema for the `channels` table.
 * SSOT for the file-internal `ChannelSnapshotDbRow` interface in observability-store.ts.
 */
export const ChannelSnapshotDbRowSchema = z.strictObject({
  id: z.number(),
  timestamp: z.number(),
  channel_type: z.string(),
  channel_id: z.string(),
  status: z.string(),
  messages_sent: z.number(),
  messages_received: z.number(),
  uptime_ms: z.number(),
});

/**
 * Schema for `provider`-grouped aggregation rows.
 * SSOT for the file-internal `ProviderAggDbRow` interface in observability-store.ts.
 */
export const ProviderAggDbRowSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  total_cost: z.number(),
  total_tokens: z.number(),
  call_count: z.number(),
  total_cache_saved: z.number(),
});

/**
 * Schema for `agent_id`-grouped aggregation rows.
 * SSOT for the file-internal `AgentAggDbRow` interface in observability-store.ts.
 */
export const AgentAggDbRowSchema = z.strictObject({
  agent_id: z.string(),
  total_cost: z.number(),
  total_tokens: z.number(),
  call_count: z.number(),
  total_cache_saved: z.number(),
});

/**
 * Schema for `session_key`-grouped aggregation rows.
 * SSOT for the file-internal `SessionAggDbRow` interface in observability-store.ts.
 */
export const SessionAggDbRowSchema = z.strictObject({
  session_key: z.string(),
  total_cost: z.number(),
  total_tokens: z.number(),
  call_count: z.number(),
  total_cache_saved: z.number(),
});

/**
 * Schema for hourly time-bucket aggregation rows.
 * SSOT for the file-internal `HourlyBucketDbRow` interface in observability-store.ts.
 */
export const HourlyBucketDbRowSchema = z.strictObject({
  hour: z.number(),
  total_cost: z.number(),
  total_tokens: z.number(),
  call_count: z.number(),
  total_cache_saved: z.number(),
});

/**
 * Schema for delivery-status statistics rows.
 * SSOT for the file-internal `DeliveryStatsDbRow` interface in observability-store.ts.
 */
export const DeliveryStatsDbRowSchema = z.strictObject({
  total: z.number(),
  success: z.number(),
  error: z.number(),
  timeout: z.number(),
  filtered: z.number(),
  avg_latency_ms: z.number(),
});

/**
 * Schema for `system_prompt_reports` rows.
 * SSOT for the file-internal `SystemPromptReportDbRow` interface in
 * observability-store-types.ts. The full report JSON is stored in
 * `report_json` (post-sanitizeForPersistence); this on-disk schema
 * validates only the column shape, not the JSON contents (those flow
 * through JSON.parse(row.report_json) at read time).
 */
export const SystemPromptReportDbRowSchema = z.strictObject({
  agent_id: z.string(),
  tenant_id: z.string().nullable(),
  session_id: z.string(),
  run_id: z.string().nullable(),
  generated_at: z.number().int(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  system_chars: z.number().int(),
  system_sha256: z.string(),
  report_json: z.string(),
});

/**
 * Cache-stats SQL row schemas. Four shapes — the single-row window
 * aggregate plus three GROUP BY variants. The `prompt_tokens` field is
 * present on raw rows (used to derive `non_cached_input_tokens` in
 * `cache-stats-queries.ts` via TS clamping); the camelCase
 * `CacheStatsWindow` surface drops it.
 */
export const CacheStatsWindowRawDbRowSchema = z.strictObject({
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  prompt_tokens: z.number(),
  output_tokens: z.number(),
  turns: z.number(),
});

export const CacheStatsByProviderRawDbRowSchema = z.strictObject({
  provider: z.string(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  prompt_tokens: z.number(),
  output_tokens: z.number(),
  turns: z.number(),
});

export const CacheStatsByModelRawDbRowSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  prompt_tokens: z.number(),
  output_tokens: z.number(),
  turns: z.number(),
});

export const CacheStatsByAgentRawDbRowSchema = z.strictObject({
  agent_id: z.string(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  prompt_tokens: z.number(),
  output_tokens: z.number(),
  turns: z.number(),
});

// --- OAuth profile store (packages/memory/src/oauth-profile-store-encrypted.ts:29) ---

/**
 * Schema for the `oauth_profiles` table.
 * SSOT for the file-internal `OAuthProfileRow` interface in oauth-profile-store-encrypted.ts.
 *
 * Buffer columns (ciphertext/iv/auth_tag/salt) use `z.instanceof(Buffer)` —
 * better-sqlite3 returns Node Buffer for BLOB columns.
 */
export const OAuthProfileRowSchema = z.strictObject({
  profile_id: z.string(),
  provider: z.string(),
  identity: z.string(),
  credentials_ciphertext: z.instanceof(Buffer),
  credentials_iv: z.instanceof(Buffer),
  credentials_auth_tag: z.instanceof(Buffer),
  credentials_salt: z.instanceof(Buffer),
  expires_at: z.number(),
  version: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});

// --- Delivery mirror (packages/memory/src/delivery-mirror-adapter.ts:23) ---

/**
 * Schema for the `delivery_mirror` table.
 * SSOT for the file-internal `DeliveryMirrorDbRow` interface in delivery-mirror-adapter.ts.
 */
export const DeliveryMirrorDbRowSchema = z.strictObject({
  id: z.string(),
  session_key: z.string(),
  text: z.string(),
  /** JSON-encoded string[]. */
  media_urls: z.string(),
  channel_type: z.string(),
  channel_id: z.string(),
  origin: z.string(),
  idempotency_key: z.string(),
  status: z.string(),
  created_at: z.number(),
  acknowledged_at: z.number().nullable(),
});

// --- Delivery queue (packages/memory/src/delivery-queue-adapter.ts:23) ---

/**
 * Schema for the `delivery_queue` table.
 * SSOT for the file-internal `DeliveryQueueDbRow` interface in delivery-queue-adapter.ts.
 */
export const DeliveryQueueDbRowSchema = z.strictObject({
  id: z.string(),
  text: z.string(),
  channel_type: z.string(),
  channel_id: z.string(),
  tenant_id: z.string(),
  /** JSON-encoded options shape. */
  options_json: z.string(),
  origin: z.string(),
  status: z.string(),
  attempt_count: z.number(),
  max_attempts: z.number(),
  created_at: z.number(),
  scheduled_at: z.number(),
  expire_at: z.number(),
  last_attempt_at: z.number().nullable(),
  next_retry_at: z.number().nullable(),
  last_error: z.string().nullable(),
  trace_id: z.string().nullable(),
});

// --- Embedding cache SQLite (packages/memory/src/embedding-cache-sqlite.ts:81) ---

/**
 * Schema for the `embedding_cache` table (batch query — text_hash + embedding).
 * SSOT for the file-internal `BatchCacheRow` interface in embedding-cache-sqlite.ts.
 */
export const BatchCacheRowSchema = z.strictObject({
  text_hash: z.string(),
  embedding: z.instanceof(Buffer),
});

// =====================================================================
// 5. Common projection shapes (frequently encountered)
// =====================================================================

/**
 * Schema for single-column id projections (`SELECT id FROM ...`).
 * Replaces `Array<{ id: string }>` casts at call sites.
 */
export const IdProjectionRowSchema = z.strictObject({
  id: z.string(),
});

/**
 * Schema for `SELECT COUNT(*) as count FROM ...` results.
 * Replaces `{ count: number }` casts at countRows sites.
 */
export const CountProjectionRowSchema = z.strictObject({
  count: z.number(),
});
