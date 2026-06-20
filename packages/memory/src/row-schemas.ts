// SPDX-License-Identifier: Apache-2.0
/**
 * Zod schemas for memory-package SQLite row types — one schema per row interface,
 * used by `createRowMapper(schema)` in `row-mapper.ts` to replace untyped-row casts
 * at every SQLite call site. Schemas live HERE (consumer-side `memory/`), NOT in
 * `@comis/core/ports/*`, to preserve core's zero-runtime-Zod-dependency boundary
 * (its port files stay type-only — a `import { z }` there widens the public surface).
 *
 * Sectional layout: (1) memory-package-local public rows paired 1:1 with the
 * `./types.js` interfaces (each pair gets an `expectTypeOf` drift guard in
 * `row-schemas.test.ts`); (2) removed in v2.12 — the DAG context-store row
 * schemas were deleted with the ctx_* schema (Phase 126); (3) session-store
 * DTOs; (4) file-internal snake_case row shapes (the SSOT consumers retarget to
 * via `z.infer<typeof XxxRowSchema>`).
 *
 * Conventions: every schema is `z.strictObject(...)` (rejects extra columns);
 * JSON-encoded TEXT → `z.string()` (parsed downstream); SQLite bool INTEGER 0/1 →
 * `z.number().int()`; BLOB → `z.instanceof(Buffer)`; nullable → `z.X.nullable()`
 * (`X | null` — SQLite NULL ≠ undefined).
 *
 * @module
 */

import { z } from "zod";

// ─── 1. Memory-package-local public rows (paired with packages/memory/src/types.ts) ───

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
  /** Unix timestamp in milliseconds, null if event time unknown. */
  occurred_at: z.number().nullable(),
  /** Evidence count; null = raw memory, >=1 = observation. */
  proof_count: z.number().nullable(),
  /** JSON-encoded string[] of source ids — consumer parses; null on raw. */
  source_ids: z.string().nullable(),
  /** Unix ms; set when folded into an observation; null on raw. */
  consolidated_at: z.number().nullable(),
  /** Observation confidence 0..1; null on raw. */
  confidence: z.number().nullable(),
  /** JSON-encoded audit array — consumer parses; null on raw. */
  history: z.string().nullable(),
  /** Reasoning-observation kind TEXT; null = "merge". */
  observation_kind: z.string().nullable(),
  /** Inductive pattern class TEXT; null unless observationKind="inductive". */
  pattern_type: z.string().nullable(),
  /** Unix ms; non-destructive demote marker; null = not demoted (DORMANT). */
  lifecycle_demoted_at: z.number().nullable(),
  /** Unix ms; non-destructive evict marker; null = not evicted (DORMANT). */
  evicted_at: z.number().nullable(),
  /** Computed lifecycle strength 0..1; null = not yet computed. */
  strength: z.number().nullable(),
  /** Always-inject pin marker. 0 = not pinned, 1 = pinned.
   *  NOT NULL DEFAULT 0 — every row carries it after ensurePinnedColumn().
   *
   *  @remarks The `.default(0)` here is a Zod parse-level safety net that applies ONLY when
   *  the field is `undefined` (i.e., in test environments that create a bare `memories` table
   *  without running ensurePinnedColumn()). After migration the column is NOT NULL DEFAULT 0,
   *  so `undefined` never reaches Zod in production. Production code must NEVER rely on this
   *  default — use the SQL column default or run ensurePinnedColumn() instead. */
  pinned: z.number().int().default(0),
  /** Unix timestamp in milliseconds, null if never updated. */
  updated_at: z.number().nullable(),
  /** Unix timestamp in milliseconds, null if no expiry. */
  expires_at: z.number().nullable(),
  /** 0 or 1 — whether vec_memories has an embedding for this entry. */
  has_embedding: z.number(),
});

/**
 * Schema for the `memory_entities` table. `canonical_key` is
 * DB-row-ONLY: the normalized dedup/index key (TS lower+NFKD+strip-marks, see
 * entity-resolver.ts), intentionally NOT a field on the strict `MemoryEntity` domain
 * type in @comis/core (which carries only the display `canonicalName`) — an
 * implementation detail of the resolver + UNIQUE index, not the domain contract.
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
 * Schema for the `readUsefulness` projection (per-intent). The scoped `SELECT memory_id, intent, used_count,
 * ignored_count, last_useful_at, failure_count FROM memory_usefulness WHERE tenant_id=? AND
 * agent_id=? AND intent IN (?, '') AND memory_id IN (...)` read; tenant_id/agent_id NOT
 * projected (the WHERE pins them). `intent` IS projected (per-intent vs global-`''`),
 * NON-nullable (NOT NULL DEFAULT ''); `last_useful_at` nullable (NULL until first "used"). Via `createRowMapper`.
 */
export const MemoryUsefulnessRowSchema = z.strictObject({
  memory_id: z.string(),
  /** Per-intent bucket; '' = the global bucket (NOT NULL DEFAULT ''). */
  intent: z.string(),
  used_count: z.number(),
  ignored_count: z.number(),
  /** Epoch ms of the last "used" attribution; NULL until first use. */
  last_useful_at: z.number().nullable(),
  /** Outcome-attributed task-failure count (NOT NULL DEFAULT 0; FORGET-02) — DISTINCT from ignored_count. WR-03: the readUsefulness projection NOW selects it (the bandit feed's negative-reward signal, surfaced onto the signal only when >0); `.optional()` keeps the schema tolerant of the legacy/lifecycle reads that omit it. */
  failure_count: z.number().optional(),
});

/**
 * Schema for the lifecycle-sweep candidate-scan projection — the scoped
 * `SELECT m.id, …, m.pinned, m.trust_level, SUM(u.failure_count), MAX(u.last_useful_at)
 * FROM memories m LEFT JOIN memory_usefulness u … WHERE m.tenant_id=? AND m.agent_id=?`
 * the sweep uses to compute each candidate's decayed strength (failure_count-coupled) +
 * tier + eviction candidacy (tenant_id/agent_id NOT projected — the WHERE pins them).
 * Markers + occurred_at + proof_count + failure_count + last_useful_at are `.nullable()`;
 * `memory_type` NOT NULL drives β; `pinned`/`trust_level` feed the FORGET-03 exemptions. Via `createRowMapper`.
 */
export const MemoryLifecycleRowSchema = z.strictObject({
  id: z.string(),
  /** NOT NULL DEFAULT 'semantic' — drives the per-type decay shape β. */
  memory_type: z.string(),
  /** Event time (epoch ms); NULL when unknown — falls back to created_at. */
  occurred_at: z.number().nullable(),
  /** Record time (epoch ms). */
  created_at: z.number(),
  /** Evidence count; NULL = raw, >=1 = observation — an importance signal. */
  proof_count: z.number().nullable(),
  /** Non-destructive demote marker (epoch ms); NULL = not demoted (DORMANT). */
  lifecycle_demoted_at: z.number().nullable(),
  /** Non-destructive evict marker (epoch ms); NULL = not evicted (DORMANT). */
  evicted_at: z.number().nullable(),
  /** Computed strength side-column (REAL 0..1); NULL = not yet computed. */
  strength: z.number().nullable(),
  /** Pinned flag (NOT NULL DEFAULT 0); pinned=1 is a hard eviction exemption (FORGET-03). */
  pinned: z.number(),
  /** Trust tier ('system'|'learned'|'external'); 'system' is exempt (FORGET-03). */
  trust_level: z.string(),
  /** SUM(failure_count) across intents (LEFT JOIN; NULL→0) — the failurePenalty coupling (FORGET-02). */
  failure_count: z.number().nullable(),
  /** MAX(last_useful_at) across intents (LEFT JOIN; NULL = never recalled) — the DISUSE signal the dormant-age branch keys off (WR-02), NOT occurred_at. */
  last_useful_at: z.number().nullable(),
});

/**
 * Schema for the entity associative-lane self-join projection. The one-hop self-join over
 * `memory_entity_links` returns, per other memory, the count of distinct
 * entities it shares with the seed set. Parsed via `createRowMapper` in the
 * lane query — never `as Row[]`.
 */
export const EntityLaneRowSchema = z.strictObject({
  memory_id: z.string(),
  /** COUNT(DISTINCT shared entity_id) — drives most-shared-first ordering. */
  shared: z.number(),
});

/**
 * Schema for the causal one-hop edge-lookup projection. The scoped UNION over `memory_causal_edges` returns, per
 * counterpart memory, the linked memory id (the cause/effect counterpart of a seed,
 * EITHER direction) + the edge `confidence`; tenant_id/agent_id NOT projected (the
 * WHERE pins them). Parsed via `createRowMapper` — never `as Row[]`.
 */
export const CausalLaneRowSchema = z.strictObject({
  linked: z.string(), // cause/effect counterpart memory id of a seed (hydrate)
  confidence: z.number(), // edge confidence (REAL) — confidence-desc ordering
});

/**
 * Schema for the `memory_triples` table. The segregated
 * bi-temporal KG row: an S/P/O assertion with the FOUR bi-temporal timestamps
 * (`t_valid_start`/`t_valid_end` valid-time, `t_ingested`/`expired_at` txn-time) +
 * the occurred range + the `trust` ladder + optional `source_memory_id` + `confidence`.
 * tenant_id/agent_id ARE projected (the adapter maps a full row back to `TripleInput`
 * for `asOf`). End-stamps + occurred range + provenance + confidence are `.nullable()`
 * (a current-truth row has `t_valid_end`/`expired_at` NULL); `trust` is `z.enum(...)`
 * matching the DDL CHECK. Parsed via `createRowMapper` — never `as Row[]`.
 */
// Per-field semantics (trust ladder, 4 bi-temporal stamps, occurred range, provenance, confidence; nullable = NULL on disk) are in the JSDoc above.
export const MemoryTripleRowSchema = z.strictObject({
  id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  trust: z.enum(["system", "learned", "external"]),
  t_valid_start: z.number(),
  t_valid_end: z.number().nullable(),
  t_ingested: z.number(),
  expired_at: z.number().nullable(),
  t_occurred: z.number().nullable(),
  t_occurred_end: z.number().nullable(),
  source_memory_id: z.string().nullable(),
  confidence: z.number().nullable(),
});

// The `user_representation` read-projection schema is co-located in
// `user-representation-row-schema.ts` (this file is at the 800-line cap; the
// tuned-alpha-row-schema.ts / outcome-event-row-schema.ts precedent) and re-exported
// here so existing importers keep their import site. v2.26 WS5 REVISE-02: it carries
// the four bi-temporal columns (t_valid_start/t_valid_end/expired_at/confidence) for
// the asOf read + the supersession incumbent SELECT.
export { UserRepresentationRowSchema } from "./user-representation-row-schema.js";

// Schema for a `relationship` row projection. The scoped read
// projects 8 columns (NOT tenant_id/agent_id/channel_id — the WHERE pins them); the
// directional (subject_user_id, about_user_id) pair is ROW DATA; trust z.enum matches
// the DDL CHECK ('external' absent). Parsed via createRowMapper.
export const RelationshipRowSchema = z.strictObject({
  id: z.string(),
  subject_user_id: z.string(),
  about_user_id: z.string(),
  content: z.string(),
  trust: z.enum(["system", "learned"]),
  source_memory_id: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number().nullable().optional(),
});

// The `tuned_alpha` read-projection schema is co-located in
// `tuned-alpha-row-schema.ts` (this file is at the 800-line cap; the
// outcome-event-row-schema.ts precedent) and re-exported here so existing
// importers keep their import site (the scoped read projects the 4 alphas +
// updated_at only — belt #3).
export { TunedAlphaRowSchema } from "./tuned-alpha-row-schema.js";

/**
 * Schema for the graph-spread recursive-CTE node projection. The
 * bounded `WITH RECURSIVE walk(node, depth)` over current-truth subject→object edges
 * returns, per reached node, the node string + its hop `depth` (`SELECT DISTINCT
 * node, depth FROM walk WHERE depth > 0`); tenant_id/agent_id NOT projected (the
 * recursive WHERE pins them). Parsed via `createRowMapper`.
 */
export const SpreadNodeRowSchema = z.strictObject({
  node: z.string(), // a reached node (a triple `object`) — drives hydrate + dedup
  depth: z.number(), // hop depth >=1 (WHERE depth>0) — drives 1/(1+depth) scoring
});

/**
 * Schema for the `listEntities` diagnostic projection. The
 * scoped `SELECT id, canonical_name, mention_count, first_seen, last_seen FROM
 * memory_entities WHERE tenant_id=? AND agent_id=? ORDER BY mention_count DESC` read
 * — a STRICT SUBSET: omits `canonical_key` (DB-internal dedup key) + the
 * tenant_id/agent_id scope columns (the WHERE pins them). The adapter maps it to the
 * camelCase `EntityRow` domain shape (@comis/core) — via `createRowMapper`.
 */
export const EntityListRowSchema = z.strictObject({
  id: z.string(),
  canonical_name: z.string(), // display form (first-seen casing) → EntityRow.name
  mention_count: z.number(),
  first_seen: z.number(), // Unix ms
  last_seen: z.number(), // Unix ms
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
  messages: z.string(), // JSON-encoded unknown[]
  created_at: z.number(), // Unix ms
  updated_at: z.number(), // Unix ms
  metadata: z.string(), // JSON-encoded Record<string, unknown>
});

/**
 * Schema for the `lcd_messages` table (LCD lossless store, Phase 127, F1).
 * Paired with `LcdMessageRow` exported from `./types.js`. The R4 isolation
 * columns are strict-required so a SELECT that drops one fails loudly (threat
 * T-127-06 — a silent scoping gap would be a cross-tenant hole).
 */
export const LcdMessageRowSchema = z.strictObject({
  id: z.string(),
  conversation_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  seq: z.number(), // monotonic per conversation
  role: z.string(), // pi-ai role: user | assistant | toolResult
  token_count: z.number(),
  created_at: z.number(), // Unix ms
});

/**
 * Schema for the `lcd_message_parts` table (LCD lossless store, Phase 127, F1).
 * Paired with `LcdMessagePartRow` exported from `./types.js`. Tool columns are
 * nullable (SQLite NULL ≠ undefined — absent for non-tool blocks); `is_error`
 * is the SQLite bool 0/1 integer; `tool_input`/`tool_output`/`metadata` are
 * JSON-encoded TEXT parsed (graceful-degrade `safeParse`) on the read path.
 */
export const LcdMessagePartRowSchema = z.strictObject({
  id: z.string(),
  message_id: z.string(),
  ordinal: z.number(),
  kind: z.string(), // text | tool_use | tool_result | reasoning | file
  tool_call_id: z.string().nullable(),
  tool_name: z.string().nullable(),
  tool_input: z.string().nullable(), // JSON
  tool_output: z.string().nullable(), // JSON
  is_error: z.number().int().nullable(), // 0/1; null for non-tool_result
  metadata: z.string(), // JSON-encoded LcdPartMetadata (raw + messageEnvelope + reasoning marker)
});

/**
 * Schema for the `lcd_summaries` table (LCD compaction store, Phase 129, C3).
 * Paired with `LcdSummaryRow` exported from `./types.js`. The R4 isolation
 * columns are strict-required so a SELECT that drops one fails loudly (threat
 * T-129-04). `kind` is the closed-union TEXT (`leaf` for 129); `taint`/
 * `fallback` are the SQLite bool 0/1 integers; `file_ids` is JSON-encoded TEXT.
 */
export const LcdSummaryRowSchema = z.strictObject({
  summary_id: z.string(),
  conversation_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  kind: z.string(), // leaf (closed union; condensed kinds = Phase 130)
  depth: z.number(),
  earliest_at: z.number(),
  latest_at: z.number(),
  descendant_count: z.number(),
  token_count: z.number(),
  content: z.string(),
  file_ids: z.string(), // JSON string[]
  taint: z.number().int(), // 0/1
  fallback: z.number().int(), // 0/1
  created_at: z.number(),
});

/**
 * Schema for the `lcd_summary_messages` table (LCD compaction store, Phase 129,
 * C3). Paired with `LcdSummaryMessageRow` exported from `./types.js`. The
 * leaf→message link; strict (no extra column) keeps the projection minimal.
 */
export const LcdSummaryMessageRowSchema = z.strictObject({
  summary_id: z.string(),
  message_id: z.string(),
});

/**
 * Schema for the `lcd_summary_parents` table (LCD condensed tier, Phase 130,
 * C2). Paired with `LcdSummaryParentRow` exported from `./types.js`. The
 * condensed→child summary edge; strict (no extra column) keeps the edge minimal.
 */
export const LcdSummaryParentRowSchema = z.strictObject({
  parent_summary_id: z.string(),
  child_summary_id: z.string(),
});

/**
 * Schema for the `lcd_context_items` table (LCD compaction store, Phase 129,
 * C3). Paired with `LcdContextItemRow` exported from `./types.js`. The R4
 * isolation columns are strict-required (threat T-129-04); `ref_kind` is the
 * closed `message`|`summary` discriminator TEXT.
 */
export const LcdContextItemRowSchema = z.strictObject({
  id: z.string(),
  conversation_id: z.string(),
  tenant_id: z.string(),
  agent_id: z.string(),
  session_key: z.string(),
  ordinal: z.number(),
  ref_kind: z.string(), // message | summary
  ref_id: z.string(),
});

// Schema for sqlite-vec KNN query results. Paired with `VecSearchRow` (./types.js).
export const VecSearchRowSchema = z.strictObject({
  memory_id: z.string(),
  distance: z.number(),
});

// Schema for FTS5 search joined with memories. Paired with `FtsSearchRow` (./types.js).
export const FtsSearchRowSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  rank: z.number(),
});

/**
 * Schema for an LCD FTS5 MATCH hit row (E1 ctx_search). The SELECT aliases the
 * per-table columns to a uniform shape (`message_id`/`summary_id AS ref_id`,
 * `content AS snippet`, `rank`). Mirrors `FtsSearchRowSchema`; consumed by
 * `searchLcdImpl` (lcd-fts.ts), which maps it to the core `LcdSearchHit` DTO.
 */
export const LcdSearchHitRowSchema = z.strictObject({
  ref_id: z.string(),
  snippet: z.string(),
  rank: z.number(),
});

/**
 * Schema for an LCD LIKE-fallback hit row (E1 ctx_search, FTS5 uncompiled). Same
 * `ref_id`/`snippet` shape as the MATCH path but WITHOUT `rank` — the LIKE scan
 * has no ranking, so the projection selects no `rank` column and the hit's `rank`
 * is set to `undefined` by the contract. Routes through the SAME per-row
 * `parseOptionalRow`+skip the MATCH path uses (WR-02) so both search paths degrade
 * identically — a drifted/corrupt row is skipped, never surfaced with an
 * `undefined` `snippet`/`refId` into `wrapExternalContent` at the tool boundary.
 */
export const LcdLikeHitRowSchema = z.strictObject({
  ref_id: z.string(),
  snippet: z.string(),
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

// ─── 2. (removed) Context-store rows ───
// The DAG context-store row schemas (paired with the @comis/core
// context-store-types DTOs) were removed in v2.12 (Phase 126, LCD
// reimplementation) together with the ctx_* schema/store. The LCD store DTOs
// are reintroduced fresh in a later phase.

// ─── 3. Session-store DTOs (paired with @comis/core/ports/session-store-types) ───

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

// ─── 4. Internal DB-row schemas (SSOT for consumer retargeting; source interfaces are file-internal in their adapters) ───

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
  // PERSIST-02 cost-correctness columns (nullable; cache_retention DROPPED).
  warmup_turn: z.number().nullable(),
  cache_eligible: z.number().nullable(),
  cost_correction: z.number().nullable(),
  pending_cache_investment_usd: z.number().nullable(),
  pricing_state: z.string().nullable(),
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
 * Schema for `system_prompt_reports` rows. SSOT for the file-internal
 * `SystemPromptReportDbRow` interface in observability-store-types.ts. The full
 * report JSON lives in `report_json` (post-sanitizeForPersistence); this on-disk
 * schema validates only the column shape, not the JSON contents (those flow through
 * JSON.parse(row.report_json) at read time).
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

// ─── 5. Common projection shapes (frequently encountered) ───

/** Schema for single-column id projections (`SELECT id FROM ...`); replaces `Array<{ id: string }>` casts. */
export const IdProjectionRowSchema = z.strictObject({
  id: z.string(),
});

/** Schema for `SELECT COUNT(*) as count FROM ...` results; replaces `{ count: number }` casts. */
export const CountProjectionRowSchema = z.strictObject({
  count: z.number(),
});
