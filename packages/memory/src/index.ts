// SPDX-License-Identifier: Apache-2.0
// @comis/memory - Persistent memory with hybrid search
// Public API -- all exports have verified external consumers.

// Schema and initialization
export { initSchema, isVecAvailable } from "./schema.js";

// Session store
export { createSessionStore } from "./session-store.js";

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
// node-llama-cpp). Consumed by the daemon composition root in Plan 04.
export { createLocalRerankerProvider } from "./reranker-provider-local.js";
export type { LocalRerankerProviderOptions } from "./reranker-provider-local.js";

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

// OAuth profile schema + encrypted SQLite OAuthCredentialStorePort adapter
export { initOAuthProfileSchema } from "./oauth-profile-schema.js";
export { createOAuthProfileStoreEncrypted } from "./oauth-profile-store-encrypted.js";

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
export { createObservabilityStore } from "./observability-store/index.js";
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
  SystemPromptReportRow,
} from "./observability-store/index.js";

// Context store schema (DAG mode)
export { initContextSchema } from "./context-schema.js";

// Context store (DAG mode CRUD)
export { createContextStore } from "./context-store.js";

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
