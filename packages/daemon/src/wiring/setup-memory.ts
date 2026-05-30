// SPDX-License-Identifier: Apache-2.0
/**
 * Memory and embedding subsystem setup: embedding provider, caching,
 * SQLite memory adapter, fingerprint-based reindexing, background batch
 * indexing, session store, memory API, and embedding queue.
 * Extracted from daemon.ts steps 6.5 through 6.5.4 plus session store
 * and memory API creation to isolate the most complex independent
 * subsystem from the main wiring sequence.
 * @module
 */

import type { AppContainer, EmbeddingPort } from "@comis/core";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createCircuitBreaker } from "@comis/agent";
import { err, type Result } from "@comis/shared";
import {
  SqliteMemoryAdapter,
  createSessionStore,
  createMemoryApi,
  createEmbeddingProvider,
  createCachedEmbeddingPort,
  createSqliteEmbeddingCache,
  createFingerprintManager,
  createBatchIndexer,
  createEmbeddingQueue,
  createLocalRerankerProvider,
  createSqliteMemoryEntityStore,
  createSqliteMemoryConsolidationStore,
  type MemoryApi,
} from "@comis/memory";
import {
  wireRecallCounters,
  type RecallCountersWiring,
} from "../observability/recall-counters-wiring.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the memory/embedding setup phase. */
export interface MemoryResult {
  /** Dispose callback for embedding cache chain: L1 -> L2 -> provider. */
  disposeEmbedding?: () => Promise<void>;
  /** Cached embedding provider wrapper (optional). */
  cachedPort?: EmbeddingPort;
  /** SQLite memory adapter with FTS5 + vector search. */
  memoryAdapter: SqliteMemoryAdapter;
  /** Raw better-sqlite3 database handle (needed for shutdown close + startup banner). */
  db: ReturnType<SqliteMemoryAdapter["getDb"]>;
  /** Session persistence store. */
  sessionStore: ReturnType<typeof createSessionStore>;
  /** High-level memory query/store API. */
  memoryApi: MemoryApi;
  /** Background embedding queue for new entries (optional). */
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;
  /** Background indexing promise for shutdown coordination (optional). */
  backgroundIndexingPromise?: Promise<unknown>;
  /** Embedding cache stats accessor for memory.embeddingCache RPC */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Embedding circuit breaker state accessor for memory persistence operations. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
  /** Cross-encoder reranker port (RANK-01). Defined only when at least one agent has
   *  `rag.rerank.enabled === true` AND the model loaded — otherwise undefined and recall
   *  degrades to fusion order (RANK-03). The all-default (rerank-off) config NEVER builds
   *  it, so the ~606MB GGUF is not downloaded by default. */
  rerankerPort?: import("@comis/core").RerankerPort;
  /** Entity-associative store (Phase 83, ENT-01/02/03). The SOLE adapter for the segregated
   *  `MemoryEntityStore` port — built UNCONDITIONALLY on the SAME shared `db` handle as the
   *  memory adapter (so entity tables + memories share one FK-enabled connection and the
   *  `ON DELETE CASCADE` fires). Unlike the reranker there is no model/IO cost to building it,
   *  so it is always present; the entity lane stays dormant until an operator opts in via
   *  `agents.<id>.rag.entityLane.enabled` (default OFF) — see setup-agents-runtime / the cron
   *  review wiring, which thread this port into the read + write paths. */
  entityStore: import("@comis/core").MemoryEntityStore;
  /** Consolidation store (Phase 84, CONS-01..07). The SOLE adapter for the segregated
   *  `MemoryConsolidationStore` port — built UNCONDITIONALLY on the SAME shared `db` handle
   *  as the memory adapter + entity store (so the observation columns, the `(tenant, agent)`
   *  isolation scope, and the FK-enabled connection are all consistent with the memory rows
   *  it consolidates). Like the entity store there is no model/IO cost to building it, so it
   *  is always present; the consolidation cron stays dormant until an operator opts in via
   *  `agents.<id>.memoryConsolidation.enabled` (default OFF, a cost gate — CONS-07). The daemon
   *  (composition root) is the only place this @comis/memory adapter and the @comis/agent
   *  `runMemoryConsolidation` job are joined — the agent receives the port TYPE only. */
  consolidationStore: import("@comis/core").MemoryConsolidationStore;
  /** Live in-process recall-counter wiring (Phase 86, OBS-07). The single
   *  `wireRecallCounters(container.eventBus)` subscriber is stood up HERE — the
   *  memory composition site that already holds the event bus — so there is ONE
   *  shared registry for the daemon lifetime (resets on restart, Assumption A2).
   *  The daemon threads this `{ snapshot }` into `MemoryApiDeps.recallCounters`
   *  so the `memory.recall_stats` handler reads the SAME live counters the
   *  `memory:*` bus events feed (NOT a fresh registry per call). */
  recallCounters: RecallCountersWiring;
  /** Dispose callback for the reranker's native context (ranking ctx -> model -> llama).
   *  Registered in the daemon shutdown path; undefined when no reranker was built. */
  disposeReranker?: () => Promise<void>;
  /** Throttled WAL checkpoint — call every health tick, runs checkpoint every 10th call. */
  maintenanceTick: () => void;
}

// ---------------------------------------------------------------------------
// Circuit breaker decorator for embedding port
// ---------------------------------------------------------------------------

/**
 * Wraps an EmbeddingPort with a circuit breaker that blocks calls when the
 * provider has failed repeatedly. Cache layers sit above this decorator so
 * cache hits bypass the breaker entirely.
 * @param inner  - The raw embedding provider to protect
 * @param cb     - A CircuitBreaker instance (threshold + reset already configured)
 * @param logger - Logger for diagnostics (unused in hot path to avoid log spam)
 */
export function createEmbeddingCircuitBreaker(
  inner: EmbeddingPort,
  cb: import("@comis/agent").CircuitBreaker,
  logger: ComisLogger,
): EmbeddingPort {
  // Suppress unused-var lint -- logger reserved for future diagnostics
  void logger;
  return {
    provider: inner.provider,
    dimensions: inner.dimensions,
    modelId: inner.modelId,

    async dispose(): Promise<void> {
      await inner.dispose?.();
    },

    async embed(text: string): Promise<Result<number[], Error>> {
      if (cb.isOpen()) {
        return err(new Error("Embedding circuit breaker is open"));
      }
      const result = await inner.embed(text);
      if (result.ok) cb.recordSuccess();
      else cb.recordFailure();
      return result;
    },

    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      if (cb.isOpen()) {
        return err(new Error("Embedding circuit breaker is open"));
      }
      const result = await inner.embedBatch(texts);
      if (result.ok) cb.recordSuccess();
      else cb.recordFailure();
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full memory and embedding subsystem: embedding provider with
 * auto-selection (local-first, remote fallback), caching, SQLite memory
 * adapter with adjusted dimensions, fingerprint-based reindexing, background
 * batch indexing for startup, session store, memory API, and embedding queue.
 * @param deps.container    - Bootstrap output (config, event bus, secret manager)
 * @param deps.memoryLogger - Module-bound logger for memory subsystem
 */
export async function setupMemory(deps: {
  container: AppContainer;
  memoryLogger: ComisLogger;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
}): Promise<MemoryResult> {
  const { container, memoryLogger, clock } = deps;
  const memoryConfig = container.config.memory;
  const embeddingConfig = container.config.embedding;

  // 6.5.1. Create embedding provider (auto-select local-first, fallback to remote)
  let embeddingPort: EmbeddingPort | undefined;
  let embeddingCbRef: import("@comis/agent").CircuitBreaker | undefined;
  if (embeddingConfig?.enabled) {
    const remoteConfig = embeddingConfig.provider !== "local"
      ? (() => {
          const apiKey = container.secretManager.get("OPENAI_API_KEY");
          return apiKey
            ? { apiKey, model: embeddingConfig.openai.model, dimensions: embeddingConfig.openai.dimensions }
            : undefined;
        })()
      : undefined;

    const providerResult = await createEmbeddingProvider({
      provider: embeddingConfig.provider,
      local: embeddingConfig.provider !== "openai"
        ? { modelUri: embeddingConfig.local.modelUri, modelsDir: safePath(container.config.dataDir || ".", embeddingConfig.local.modelsDir), contextSize: embeddingConfig.local.contextSize }
        : undefined,
      remote: remoteConfig,
    });

    if (providerResult.ok) {
      embeddingPort = providerResult.value;
      memoryLogger.debug(
        { provider: embeddingPort.provider, modelId: embeddingPort.modelId, dimensions: embeddingPort.dimensions },
        "Embedding provider initialized",
      );

      // Circuit breaker wraps raw provider for batch failure resilience.
      // Placed BEFORE cache layers so cache hits bypass the breaker entirely.
      // Note: halfOpenTimeoutMs exists in CircuitBreakerConfig schema but is unused
      // by createCircuitBreaker at runtime -- omitted here for clarity.
      const embeddingCb = createCircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 60_000,
        halfOpenTimeoutMs: 30_000,
      }, clock);
      embeddingCbRef = embeddingCb;
      embeddingPort = createEmbeddingCircuitBreaker(embeddingPort, embeddingCb, memoryLogger);
      memoryLogger.debug("Embedding circuit breaker active (threshold=3, reset=60s)");
    } else {
      memoryLogger.warn({ err: providerResult.error.message, hint: "Set OPENAI_API_KEY or configure an embedding provider in integrations.media", errorKind: "config" as const }, "No embedding provider available, using FTS5 only");
    }
  }

  // 6.5.1b. Build the cross-encoder reranker — ONLY when at least one agent enables
  // rerank. Building it downloads a ~606MB GGUF on first run, so the all-default
  // (rerank-off) config must NEVER trigger it (Phase-79: rerank is opt-in/default-OFF).
  // Scanning the in-memory agent configs is the cheapest correct gate (no I/O). When no
  // reranker is built, recall degrades to fusion order (RANK-03).
  let rerankerPort: import("@comis/core").RerankerPort | undefined;
  let disposeReranker: (() => Promise<void>) | undefined;
  const someAgentRerankEnabled = Object.values(container.config.agents ?? {}).some(
    (agent) => agent?.rag?.rerank?.enabled === true,
  );
  if (someAgentRerankEnabled) {
    const rr = await createLocalRerankerProvider({
      modelUri: memoryConfig.rerankerModel,
      modelsDir: safePath(container.config.dataDir || ".", memoryConfig.rerankerModelsDir),
      gpu: memoryConfig.rerankerGpu,
      threads: memoryConfig.rerankerThreads,
    });
    if (rr.ok) {
      // Capture the resolved port so the dispose closure has a non-nullable
      // reference (no `rerankerPort!.dispose!()` non-null clusters; AGENTS.md).
      const port = rr.value;
      rerankerPort = port;
      disposeReranker = port.dispose
        ? async () => { await port.dispose?.(); }
        : undefined;
      memoryLogger.debug({ model: memoryConfig.rerankerModel }, "Reranker provider initialized");
    } else {
      memoryLogger.warn(
        { err: rr.error.message, hint: "Reranker model unavailable; recall will use fusion order", errorKind: "dependency" as const },
        "Reranker provider unavailable",
      );
    }
  }

  // 6.5.2. Create memory adapter with raw provider dimensions
  // Adapter uses embedding port only at query time (search()), not during construction.
  // Created BEFORE cache wiring because createSqliteEmbeddingCache needs the db handle.
  const effectiveDimensions = embeddingPort ? embeddingPort.dimensions : memoryConfig.embeddingDimensions;
  const adjustedMemoryConfig = { ...memoryConfig, embeddingDimensions: effectiveDimensions };
  const memoryAdapter = new SqliteMemoryAdapter(adjustedMemoryConfig, embeddingPort, memoryLogger);
  const db = memoryAdapter.getDb();

  // 6.5.2b. Entity-associative store (Phase 83). Built on the SAME `db` handle the
  // memory adapter owns — NOT a second Database — so the entity tables
  // (memory_entities / memory_entity_links) and the memories table share one
  // FK-enabled connection. That is what makes the link `ON DELETE CASCADE` fire and
  // keeps the (tenant, agent) isolation scope consistent with the memory rows it joins.
  // Always constructed (no model/IO cost); the entity recall lane stays dormant until an
  // operator enables `agents.<id>.rag.entityLane.enabled` (default OFF).
  const entityStore = createSqliteMemoryEntityStore({ db, logger: memoryLogger });

  // 6.5.2c. Consolidation store (Phase 84). Built on the SAME `db` handle the memory
  // adapter owns — NOT a second Database — so the observation columns (proof_count /
  // source_ids / consolidated_at / confidence / history) and the memories table share
  // one FK-enabled connection, and the (tenant, agent) isolation scope is consistent
  // with the memory rows the consolidation job reads + marks. Always constructed (no
  // model/IO cost, like the entity store); the consolidation cron stays dormant until an
  // operator enables `agents.<id>.memoryConsolidation.enabled` (default OFF — the cost
  // gate, CONS-07). This is the composition-root join: the daemon builds the @comis/memory
  // adapter here and injects it into the @comis/agent job as the port TYPE (no agent→memory
  // edge — the architecture-graph cut is preserved).
  const consolidationStore = createSqliteMemoryConsolidationStore({ db, logger: memoryLogger });

  // 6.5.2d. Recall-counter composition (Phase 86, OBS-07). Stand up the SINGLE
  // in-process recall-counter registry and subscribe it to the `memory:*` bus
  // events HERE — the memory composition site already holds `container.eventBus`,
  // so this is the natural composition root for the counters (it lives alongside
  // the stores the diagnostic handlers read). The daemon threads the returned
  // `{ snapshot }` into `MemoryApiDeps.recallCounters`, so the `memory.recall_stats`
  // handler reads the SAME live registry the agent's `memory:recalled` /
  // `memory:reranked` (and the consolidation job's `memory:consolidated`) events
  // feed — never a fresh registry per call. The gauge is daemon-lifetime (resets
  // on restart, Assumption A2). Counts only ever cross the bus (AGENTS.md §2.7).
  const recallCounters = wireRecallCounters(container.eventBus);

  // 6.5.3. Wire caching: L1(L2(provider)) when persistent, L1(provider) otherwise
  let cachedPort: EmbeddingPort | undefined;
  let embeddingCacheStats: (() => import("@comis/memory").EmbeddingCacheStats) | undefined;
  if (embeddingPort && embeddingConfig && embeddingConfig.cache.maxEntries > 0) {
    let innerForL1: EmbeddingPort = embeddingPort;

    // L2: persistent SQLite cache (config-gated)
    if (embeddingConfig.cache.persistent) {
      innerForL1 = createSqliteEmbeddingCache(embeddingPort, {
        db,
        maxEntries: embeddingConfig.cache.persistentMaxEntries,
        ttlMs: embeddingConfig.cache.ttlMs,
        pruneIntervalMs: embeddingConfig.cache.pruneIntervalMs,
      });
    }

    // L1: in-memory LRU wraps L2 (or raw provider if persistent=false)
    const cachedPortWithStats = createCachedEmbeddingPort(innerForL1, {
      maxEntries: embeddingConfig.cache.maxEntries,
      ttlMs: embeddingConfig.cache.ttlMs,
    });
    cachedPort = cachedPortWithStats;
    embeddingCacheStats = () => cachedPortWithStats.getCacheStats();
  } else {
    cachedPort = embeddingPort;
  }

  // 6.5.4. Fingerprint check + batch indexing
  let backgroundIndexingPromise: Promise<unknown> | undefined;
  let embeddingQueue: ReturnType<typeof createEmbeddingQueue> | undefined;

  if (cachedPort && embeddingConfig) {
    const fingerprintMgr = createFingerprintManager(db);
    fingerprintMgr.ensureTable();

    if (embeddingConfig.autoReindex && fingerprintMgr.hasChanged(cachedPort)) {
      memoryLogger.info("Embedding model changed, triggering full reindex");
      // Note: reindex happens in background (non-blocking startup)
      const batchIndexer = createBatchIndexer(db, cachedPort, {
        batchSize: embeddingConfig.batch.batchSize,
        logger: memoryLogger,
      });
      backgroundIndexingPromise = batchIndexer.reindexAll().then(({ indexed, failed, lastError }) => {
        if (failed > 0 && lastError) {
          memoryLogger.warn(
            { indexed, failed, lastError, hint: "Check embedding provider connectivity and model configuration", errorKind: "dependency" as const },
            "Embedding reindex complete with failures",
          );
        } else {
          memoryLogger.info({ indexed, failed }, "Embedding reindex complete");
        }
      }).catch((e) => {
        memoryLogger.warn({ err: String(e), hint: "Check database integrity and embedding provider connectivity", errorKind: "dependency" as const }, "Background embedding reindex failed");
      });
    } else if (embeddingConfig.batch.indexOnStartup) {
      const batchIndexer = createBatchIndexer(db, cachedPort, {
        batchSize: embeddingConfig.batch.batchSize,
        logger: memoryLogger,
      });
      const count = batchIndexer.unembeddedCount();
      if (count > 0) {
        memoryLogger.info({ unembedded: count }, "Indexing unembedded memories in background");
        backgroundIndexingPromise = batchIndexer.indexUnembedded().then(({ indexed, failed, lastError }) => {
          if (failed > 0 && lastError) {
            memoryLogger.warn(
              { indexed, failed, lastError, hint: "Check embedding provider connectivity and model configuration", errorKind: "dependency" as const },
              "Background embedding indexing complete with failures",
            );
          } else {
            memoryLogger.info({ indexed, failed }, "Background embedding indexing complete");
          }
        }).catch((e) => {
          memoryLogger.warn({ err: String(e), hint: "Check database integrity and embedding provider connectivity", errorKind: "dependency" as const }, "Background embedding indexing failed");
        });
      }
    }

    // Save current fingerprint for next startup comparison
    fingerprintMgr.save(fingerprintMgr.computeFingerprint(cachedPort));

    // Create and wire embedding queue for new entries
    embeddingQueue = createEmbeddingQueue(db, cachedPort);
  }

  const sessionStore = createSessionStore(db);
  const memoryApi: MemoryApi = createMemoryApi(db, memoryAdapter, sessionStore, memoryConfig);
  memoryLogger.debug(
    { dbPath: memoryConfig.dbPath, embedding: !!cachedPort },
    "Memory services initialized",
  );

  // Build dispose callback: L1 -> L2 -> provider
  const disposeEmbedding = cachedPort?.dispose
    ? async () => { await cachedPort!.dispose!(); }
    : undefined;

  // Throttled WAL checkpoint: runs PASSIVE checkpoint every 10th call (~5 min at 30s health interval)
  let maintenanceTickCount = 0;
  const maintenanceTick = (): void => {
    maintenanceTickCount++;
    if (maintenanceTickCount % 10 !== 0) return;
    try {
      const pages = memoryAdapter.checkpoint();
      if (pages > 0) {
        memoryLogger.debug({ pages }, "WAL checkpoint moved pages");
      }
    } catch { /* checkpoint failure must not crash health tick */ }
  };

  return {
    disposeEmbedding,
    cachedPort,
    memoryAdapter,
    db,
    sessionStore,
    memoryApi,
    embeddingQueue,
    backgroundIndexingPromise,
    embeddingCacheStats,
    embeddingCircuitBreakerState: embeddingCbRef ? () => embeddingCbRef!.getState() : undefined,
    rerankerPort,
    disposeReranker,
    entityStore,
    consolidationStore,
    recallCounters,
    maintenanceTick,
  };
}
