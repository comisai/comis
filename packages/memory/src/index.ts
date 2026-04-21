// SPDX-License-Identifier: Apache-2.0
// @comis/memory - Persistent memory with hybrid search
// Public API -- all exports have verified external consumers.

// Schema and initialization
export { initSchema, isVecAvailable } from "./schema.js";

// Session store
export { createSessionStore } from "./session-store.js";
export type { SessionStore, SessionData, SessionListEntry, SessionDetailedEntry } from "./session-store.js";

// SQLite memory adapter (MemoryPort implementation)
export { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

// Memory API (programmatic interface for inspection, management, guardrails)
export { createMemoryApi } from "./memory-api.js";
export type {
  MemoryApi,
  InspectFilters,
  ClearScope,
  MemoryStats,
  GuardrailResult,
} from "./memory-api.js";

// Embedding queue (async background embedding generation)
export { createEmbeddingQueue } from "./embedding-queue.js";
export type { EmbeddingQueue } from "./embedding-queue.js";

// Embedding providers (auto-selection factory + OpenAI)
export { createEmbeddingProvider } from "./embedding-provider-factory.js";
export type { EmbeddingProviderOptions } from "./embedding-provider-factory.js";
export { createOpenAIEmbeddingProvider } from "./embedding-provider-openai.js";
export type { OpenAIEmbeddingProviderOptions } from "./embedding-provider-openai.js";

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

// SQLite secret store (SecretStorePort implementation)
export { createSqliteSecretStore } from "./sqlite-secret-store.js";

// Secret store bootstrap (master key resolution)
export { setupSecrets } from "./setup-secrets.js";
export type { SecretsBootResult } from "./setup-secrets.js";

// Named graph store (server-side pipeline persistence)
export { createNamedGraphStore } from "./named-graph-store.js";
export type { NamedGraphStore, NamedGraphEntry, NamedGraphSummary } from "./named-graph-store.js";

// Delivery queue adapter
export { createSqliteDeliveryQueue } from "./delivery-queue-adapter.js";

// Delivery mirror adapter
export { createSqliteDeliveryMirror } from "./delivery-mirror-adapter.js";

// Observability store
export { createObservabilityStore } from "./observability-store.js";
export type {
  ObservabilityStore,
  TokenUsageRow,
  DeliveryRow,
  DiagnosticRow,
  ChannelSnapshotRow,
  ProviderAggregation,
  AgentAggregation,
  SessionAggregation,
  HourlyBucket,
  DeliveryStats,
  ObsTableName,
  ResetResult,
  PruneResult,
} from "./observability-store.js";

// Context store schema (DAG mode)
export { initContextSchema } from "./context-schema.js";

// Context store (DAG mode CRUD)
export { createContextStore } from "./context-store.js";
export type { ContextStore } from "./context-store.js";

// Context store row types
export type {
  CtxConversationRow,
  CtxMessageRow,
  CtxMessagePartRow,
  CtxSummaryRow,
  CtxSummaryMessageRow,
  CtxSummaryParentRow,
  CtxContextItemRow,
  CtxLargeFileRow,
  CtxExpansionGrantRow,
} from "./types.js";
