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
  type MemoryApi,
} from "@comis/memory";

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
}): Promise<MemoryResult> {
  const { container, memoryLogger } = deps;
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
      });
      embeddingCbRef = embeddingCb;
      embeddingPort = createEmbeddingCircuitBreaker(embeddingPort, embeddingCb, memoryLogger);
      memoryLogger.debug("Embedding circuit breaker active (threshold=3, reset=60s)");
    } else {
      memoryLogger.warn({ err: providerResult.error.message, hint: "Set OPENAI_API_KEY or configure an embedding provider in integrations.media", errorKind: "config" as const }, "No embedding provider available, using FTS5 only");
    }
  }

  // 6.5.2. Create memory adapter with raw provider dimensions
  // Adapter uses embedding port only at query time (search()), not during construction.
  // Created BEFORE cache wiring because createSqliteEmbeddingCache needs the db handle.
  const effectiveDimensions = embeddingPort ? embeddingPort.dimensions : memoryConfig.embeddingDimensions;
  const adjustedMemoryConfig = { ...memoryConfig, embeddingDimensions: effectiveDimensions };
  const memoryAdapter = new SqliteMemoryAdapter(adjustedMemoryConfig, embeddingPort, memoryLogger);
  const db = memoryAdapter.getDb();

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
  };
}
