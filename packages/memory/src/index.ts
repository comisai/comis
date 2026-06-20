// SPDX-License-Identifier: Apache-2.0
// @comis/memory - Persistent memory with hybrid search
// Public API -- all exports have verified external consumers.

// Schema and initialization
export { initSchema, isVecAvailable } from "./schema.js";

// Session store
export { createSessionStore } from "./session-store.js";

// LCD lossless context store (ContextStorePort impl — Phase 127)
export { createLcdStore, reconstructLcdMessage } from "./lcd-store.js";

// LCD provenance READ adapter (LcdProvenanceReadStore impl — Phase 173, DIST-03
// read side, the C1→C2 carry-in). The read-mirror of the write-side
// buildProvenanceWrites; its own factory (NOT widened onto ContextStorePort) so
// the recall import surface stays narrow. The daemon builds it on the same db
// handle as createLcdStore and injects it as the core LcdProvenanceReadStore TYPE
// (the agent↛memory cut) into createMemoryRecall's post-fusion provenance pass.
export { buildProvenanceReadStore } from "./lcd-store-provenance-read.js";

// LCD FTS text renderer — exported for the offline doctor repair path (DOC-03,
// Phase 171). The contentless lcd_messages_fts has no external content table so
// the 'rebuild' idiom does not apply; the doctor repair re-derives FTS rows from
// lcd_message_parts using this same render fn (mirror of the adapter populate path).
export { renderMessageFtsText } from "./lcd-fts.js";

// LCD read-only operator-browse adapter (ContextBrowsePort impl — context.* RPCs).
export { createLcdBrowseStore } from "./lcd-browse-store.js";

// LCD per-conversation single-flight ingest serializer (R3, Plan 132-04).
// createIngestSerializer + IngestSerializer are NOT re-exported: the store
// constructs the serializer internally (lcd-store.ts) and exposes its effect via
// ContextStorePort.runOnConversation. No external consumer constructs one
// directly, so the symbols stay package-internal (consumed via the relative
// ./lcd-ingest-serializer.js import only).

// SQLite memory adapter (MemoryPort implementation)
export { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

// Memory API (programmatic interface for inspection, management, guardrails)
export { createMemoryApi } from "./memory-api.js";
export type {
  MemoryApi,
  InspectFilters,
  ClearScope,
  MemoryStats,
} from "./memory-api.js";

// Embedding queue (async background embedding generation)
export { createEmbeddingQueue } from "./embedding-queue.js";
export type { EmbeddingQueue } from "./embedding-queue.js";

// Embedding providers (auto-selection factory + OpenAI)
export { createEmbeddingProvider } from "./embedding-provider-factory.js";
export type { EmbeddingProviderOptions } from "./embedding-provider-factory.js";
export { createOpenAIEmbeddingProvider } from "./embedding-provider-openai.js";
export type { OpenAIEmbeddingProviderOptions } from "./embedding-provider-openai.js";

// Local cross-encoder reranker provider (sole RerankerPort impl; GGUF via
// node-llama-cpp). Consumed by the daemon composition root.
export { createLocalRerankerProvider } from "./reranker-provider-local.js";
export type { LocalRerankerProviderOptions } from "./reranker-provider-local.js";

// No-download reranker model-presence probe.
// resolveModelFile({ download: false }) + existsSync; never the SOLE download
// site (createLocalRerankerProvider stays that). The daemon composition root
// consults it to drive the locally-gated default-on rerank decision.
export { rerankerModelPresent } from "./reranker-model-present.js";

// Entity-associative recall store (sole MemoryEntityStore impl).
// Owns the resolve/link write path + the scoped one-hop self-join read lane.
// The daemon constructs it on the memory adapter's db handle; the
// MemoryEntityStore port TYPE itself lives in @comis/core (not re-exported here).
export { createSqliteMemoryEntityStore } from "./sqlite-memory-entity-store.js";
export type { MemoryEntityStoreDeps } from "./sqlite-memory-entity-store.js";

// Temporal-spread recall store (sole MemoryTemporalStore impl).
// Owns the windowed read over the EXISTING `memories.occurred_at` column — given the
// seed memories' event times, surfaces OTHER memories near those times (NO new table).
// The daemon (composition root) constructs it on the memory adapter's db handle; the
// MemoryTemporalStore port TYPE lives in @comis/core (the agent↛memory cut — the recall
// read path consumes the type only).
export { createSqliteMemoryTemporalStore } from "./sqlite-memory-temporal-store.js";
export type { MemoryTemporalStoreDeps } from "./sqlite-memory-temporal-store.js";

// Causal-edge recall store (sole MemoryCausalStore impl).
// Owns the edge write (effectText -> scoped FTS top-1 -> INSERT OR IGNORE a
// directed cause->effect edge over the additive `memory_causal_edges` table) +
// the scoped one-hop UNION read lane. The daemon (composition root)
// constructs it on the memory adapter's db handle; the MemoryCausalStore port
// TYPE lives in @comis/core (the agent↛memory cut — the extraction write path and
// the recall read path consume the type only).
export { createSqliteMemoryCausalStore } from "./sqlite-memory-causal-store.js";
export type { MemoryCausalStoreDeps } from "./sqlite-memory-causal-store.js";

// Trust-first bi-temporal knowledge-graph triple store (sole TripleStorePort
// impl). Owns ALL the S/P/O triple
// SQL over the additive `memory_triples` table: the trust-first single-current-
// truth upsert (the skeleton is INSERT-only; invalidation lands separately),
// the valid-time `asOf(t)` read, and the bounded recursive-CTE `spreadLane`.
// The daemon (composition root) constructs it on the
// memory adapter's db handle; the TripleStorePort TYPE lives in @comis/core (the
// agent↛memory cut — the offline writer + the recall lane consume the type only).
export { createSqliteTripleStore } from "./sqlite-triple-store.js";
export type { MemoryTripleStoreDeps } from "./sqlite-triple-store.js";

// Per-user representation store (sole UserRepresentationStore impl).
// Owns ALL the per-user-representation SQL over the additive
// `user_representation` table: the (tenant, agent, user)-scoped upsert (with the
// write-time high-trust-floor reject + validateMemoryWrite redaction firewall) +
// the LLM-free scoped read. The daemon (composition root) constructs
// it on the memory adapter's db handle; the UserRepresentationStore port TYPE
// lives in @comis/core (the agent↛memory cut — the offline profile-builder write
// path + the prompt-assembly read path consume the type only). AHEAD of its
// daemon consumer (the factory-orphan dance).
export { createSqliteUserRepresentationStore } from "./sqlite-user-representation-store.js";
export type { MemoryUserRepresentationStoreDeps } from "./sqlite-user-representation-store.js";

// Directional relationship store (sole RelationshipStore impl).
// Owns ALL the directional relationship SQL over the additive
// `relationship` table: the (tenant, agent, channel)-scoped upsert (with the
// write-time high-trust-floor reject + validateMemoryWrite redaction firewall) +
// the LLM-free scoped read. channel_id is the NEW privacy axis; the
// (subject_user_id, about_user_id) pair is directional ROW DATA (A→B ≠ B→A). The
// daemon (composition root) constructs it on the memory adapter's db
// handle; the RelationshipStore port TYPE lives in @comis/core (the agent↛memory
// cut — the offline relationship-builder write path + the optional prompt-assembly
// read path consume the type only). AHEAD of its daemon consumer (the
// factory-orphan dance).
export { createSqliteRelationshipStore } from "./sqlite-relationship-store.js";
export type { MemoryRelationshipStoreDeps } from "./sqlite-relationship-store.js";

// Scoped embedding-read store (sole MemoryEmbeddingStore impl).
// Owns the (tenant, agent)-scoped LEFT JOIN vec_memories bulk read that hydrates
// the MMR diversity re-rank (returns id->vector for the caller's scope ONLY — the
// load-bearing scope isolation, UNLIKE the corpus-wide distances-only
// knnDistances). The daemon (composition root) constructs it on the
// memory adapter's db handle; the MemoryEmbeddingStore port TYPE lives in
// @comis/core (the agent↛memory cut — the recall MMR read path consumes the type only).
export { createSqliteMemoryEmbeddingStore } from "./sqlite-memory-embedding-store.js";
export type { MemoryEmbeddingStoreDeps } from "./sqlite-memory-embedding-store.js";

// Memory consolidation store (sole MemoryConsolidationStore impl).
// Owns the scoped, state-predicate (consolidated_at IS NULL) candidate selection
// + the atomic applyConsolidation transaction. The daemon constructs
// it on the memory adapter's db handle; the MemoryConsolidationStore port TYPE
// lives in @comis/core (the agent↛memory cut — the job imports the type only).
export { createSqliteMemoryConsolidationStore } from "./sqlite-memory-consolidation-store.js";
export type { MemoryConsolidationStoreDeps } from "./sqlite-memory-consolidation-store.js";

// Recall-utility usefulness store (sole MemoryUsefulnessStore impl).
// Owns the idempotent used/ignored upsert (scoped to the
// (tenant, agent, memory_id) PK) + the scoped absent-id-omitted bulk read. The
// daemon (composition root) constructs it on the memory adapter's db handle; the
// MemoryUsefulnessStore port TYPE lives in @comis/core (the agent↛memory cut —
// the recall scoring path consumes the type only).
export { createSqliteMemoryUsefulnessStore } from "./sqlite-memory-usefulness-store.js";
export type { MemoryUsefulnessStoreDeps } from "./sqlite-memory-usefulness-store.js";

// Outcome-signal store (sole OutcomeSignalPort impl — v2.26 Verified Learning WS1).
// Owns the idempotent `observe()` write (deterministic-hash id + ON CONFLICT DO
// NOTHING on the (tenant, agent, trajectory, source, observed_at) UNIQUE tuple),
// the scoped precedence-first-then-confidence `resolve()` fusion (fail-closed
// `unknown`), and the age-based `prune()`. The daemon (composition root)
// constructs it on the memory adapter's db handle; the OutcomeSignalPort TYPE
// lives in @comis/core (the agent↛memory cut — outcome capture is daemon-side, a
// future agent-side consumer consumes the port type only).
export { createSqliteOutcomeStore } from "./sqlite-outcome-store.js";
export type { OutcomeStoreDeps } from "./sqlite-outcome-store.js";

// Learned-skill store (sole LearnedSkillStorePort impl — v2.26 Verified Learning WS2).
// Owns the idempotent `admit()` upsert (deterministic-hash id of the
// (tenant, agent, name) UNIQUE tuple + ON CONFLICT(id) DO UPDATE), the scoped
// (tenant, agent)-isolated `get`/`list` reads, and the `promote`/`demote`/`evict`
// lifecycle transitions (evict is SOFT — sets evicted_at, never a hard DELETE).
// The DB CHECK (trust_level IN ('learned')) + a code coercion make a synthesized
// procedure structurally incapable of being `system` (SEC-01). The daemon
// (composition root) constructs it on the memory adapter's db handle (Plan 07);
// the LearnedSkillStorePort TYPE lives in @comis/core (the agent↛memory cut — the
// synthesis job consumes the type only).
export { createSqliteLearnedSkillStore } from "./sqlite-learned-skill-store.js";
export type { LearnedSkillStoreDeps } from "./sqlite-learned-skill-store.js";

// Tuned-alpha store (sole TunedAlphaStore impl).
// Owns the idempotent per-(tenant, agent) tuned-alpha-vector upsert + the scoped
// read (undefined when absent → the apply-site default-OFF no-op). The daemon
// (composition root) constructs it on the memory adapter's db handle; the
// TunedAlphaStore port TYPE lives in @comis/core (the agent↛memory cut — the
// offline bandit job + the recall apply overlay consume the type only). The table
// has NO trust-weight column (the structural trust-freeze belt #3).
export { createSqliteTunedAlphaStore } from "./sqlite-tuned-alpha-store.js";
export type { MemoryTunedAlphaStoreDeps } from "./sqlite-tuned-alpha-store.js";

// Memory-lifecycle sweep store (sole MemoryLifecyclePort impl).
// Owns the (tenant, agent)-scoped candidate scan over the `memories`
// table + its additive NON-DESTRUCTIVE marker columns (lifecycle_demoted_at /
// evicted_at / strength). SCAFFOLD-DORMANT: it computes strengths/tiers but
// evicts/demotes/promotes NOTHING (report all-0, no DELETE, no marker UPDATE) — the
// live eviction policy is the deferred operator step. The daemon (composition
// root) constructs it on the memory adapter's db handle + registers the
// default-OFF __MEMORY_LIFECYCLE__ cron; the MemoryLifecyclePort TYPE lives in
// @comis/core (the agent↛memory cut — the agent never imports this adapter).
export { createSqliteMemoryLifecycleStore } from "./sqlite-memory-lifecycle-store.js";
export type { MemoryLifecycleStoreDeps, MemoryLifecyclePolicy } from "./sqlite-memory-lifecycle-store.js";

// Embedding cache (LRU content-hash cache decorator)
export { createCachedEmbeddingPort } from "./embedding-cache-lru.js";
export type { EmbeddingCacheOptions, EmbeddingCacheStats } from "./embedding-cache-lru.js";

// Embedding cache SQLite (persistent L2 cache adapter)
export { createSqliteEmbeddingCache } from "./embedding-cache-sqlite.js";
export type { SqliteEmbeddingCacheOptions } from "./embedding-cache-sqlite.js";

// Embedding fingerprint (provider change detection)
export { createFingerprintManager } from "./embedding-fingerprint.js";
export type { FingerprintManager, ProviderFingerprint } from "./embedding-fingerprint.js";

// Embedding identity hash (shared between fingerprint manager and L2 cache)
export { computeEmbeddingIdentityHash } from "./embedding-hash.js";

// Embedding batch indexer (bulk re-indexing)
export { createBatchIndexer } from "./embedding-batch-indexer.js";
export type { BatchIndexer, BatchIndexerOptions, BatchIndexerResult } from "./embedding-batch-indexer.js";

// SQLite adapter base (shared DB lifecycle utility)
export { openSqliteDatabase, chmodDbFiles } from "./sqlite-adapter-base.js";
export type { SqliteAdapterOptions } from "./sqlite-adapter-base.js";

// SQLite secret store (SecretStorePort encrypted SQLite implementation)
export { createSqliteSecretStore } from "./sqlite-secret-store.js";
export type { SqliteSecretStoreHandle } from "./sqlite-secret-store.js";

// File secret store (SecretStorePort file-backed implementation)
export { createFileSecretStore } from "./file-secret-store.js";

// Secret store selector (mode-dispatched factory)
export { selectSecretStore } from "./select-secret-store.js";
export type { SelectedSecretStore } from "./select-secret-store.js";

// OAuth profile schema + encrypted SQLite OAuthCredentialStorePort adapter
export { initOAuthProfileSchema } from "./oauth-profile-schema.js";
export { createOAuthProfileStoreEncrypted } from "./oauth-profile-store-encrypted.js";

// Secret store bootstrap (master key resolution)
export { setupSecrets } from "./setup-secrets.js";
export type { SecretsBootResult } from "./setup-secrets.js";

// Offline secrets write helpers (CLI daemon-free bootstrap path)
export { offlineSecretSet, offlineSecretsList, offlineSecretGet } from "./offline-secrets-write.js";
export { offlineOAuthProfileSet } from "./offline-oauth-write.js";

// Named graph store (server-side pipeline persistence)
export { createNamedGraphStore } from "./named-graph-store.js";
export type { NamedGraphStore, NamedGraphEntry, NamedGraphSummary } from "./named-graph-store.js";

// Delivery queue adapter
export { createSqliteDeliveryQueue } from "./delivery-queue-adapter.js";

// Video job store (durable async video-job lifecycle — Phase 189, JOB-01).
// The SQLite-backed, agent-scoped, state-machine job store the background
// poller (Plan 02) resumes against across a daemon restart; the video_status
// handler (Plan 03) reads an agent-scoped row. Constructed on the shared
// memory.db handle (like createSqliteDeliveryQueue). ensureVideoJobTable is the
// idempotent DDL initSchema already calls; exported for the offline/test path.
export { createVideoJobStore } from "./video-job-store.js";
export type {
  VideoJobStore,
  VideoJobRecord,
  VideoJobState,
  VideoJobInsert,
  VideoJobDoneInput,
} from "./video-job-store.js";
export { ensureVideoJobTable } from "./schema-video-jobs.js";

// Delivery mirror adapter
export { createSqliteDeliveryMirror } from "./delivery-mirror-adapter.js";

// Observability store
export { createObservabilityStore } from "./observability-store/index.js";
export type {
  ObservabilityStore,
  TokenUsageRow,
  DeliveryRow,
  DiagnosticRow,
  ChannelSnapshotRow,
  AuditEventRow,
  ProviderAggregation,
  AgentAggregation,
  SessionAggregation,
  HourlyBucket,
  DeliveryStats,
  ObsTableName,
  ResetResult,
  PruneResult,
  SystemPromptReportRow,
} from "./observability-store/index.js";

// AUDIT-01: the security-audit sink helpers (the 0600 rotated JSONL writer +
// the bounded query-param shape) the daemon's obs-persistence-wiring consumes.
export {
  appendAuditJsonl,
  SECURITY_AUDIT_LOG_BASENAME,
  DEFAULT_AUDIT_QUERY_LIMIT,
  MAX_AUDIT_QUERY_LIMIT,
} from "./observability-store/index.js";
export type { AuditQueryParams, AppendAuditJsonlParams } from "./observability-store/index.js";

// Fleet window-rollup reducer (A2, v2.15 Phase 159). reduceFleetWindow is the
// PURE cross-session reduce over the A1 SessionSummaryRollup[] (synthetic
// excluded on the real `source` field). Barrel-surfaced AHEAD of its in-repo
// consumer: the Phase-161 obs.fleet.health handler imports it, but no production
// module references it yet — tracked in public-api-policy.ts as a planned orphan
// (mirror FleetHealthReportSchema/FleetHealthReport from 159-04).
export { reduceFleetWindow } from "./observability-store/fleet-window-rollup.js";
export type { FleetWindowRollup } from "./observability-store/fleet-window-rollup.js";

// Generic Row mapper factory.
// Consumed via createRowMapper(schema) at every SQLite call-site to
// replace `db.prepare(...).all() as Foo[]` casts.
export { createRowMapper } from "./row-mapper.js";
export type { RowMapper, MapperError } from "./row-mapper.js";

// Per-row Zod schemas.
// One schema per memory-package SQLite row interface. Consumer-side only
// (NOT in @comis/core/ports — preserves core's zero-runtime-Zod boundary).
// Consumed as the argument to createRowMapper(schema).
export * from "./row-schemas.js";
