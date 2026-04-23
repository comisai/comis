// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({ close: vi.fn() }));
const mockCheckpoint = vi.hoisted(() => vi.fn(() => 0));
const mockSqliteMemoryAdapter = vi.hoisted(() => {
  return vi.fn(function (this: any) {
    this.getDb = () => mockDb;
    this.checkpoint = mockCheckpoint;
  });
});
const mockCreateSessionStore = vi.hoisted(() => vi.fn(() => ({ loadByFormattedKey: vi.fn(), save: vi.fn() })));
const mockCreateMemoryApi = vi.hoisted(() => vi.fn(() => ({ search: vi.fn(), store: vi.fn() })));
const mockCreateEmbeddingProvider = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  value: { provider: "test", embed: vi.fn(), modelId: "test-model", dimensions: 384 },
})));
const mockCreateCachedEmbeddingPort = vi.hoisted(() => vi.fn((provider: any) => ({
  ...provider,
  modelId: provider.modelId,
  dimensions: provider.dimensions,
  _cached: true,
  dispose: vi.fn(async () => {}),
})));
const mockCreateSqliteEmbeddingCache = vi.hoisted(() => vi.fn((provider: any) => ({
  ...provider,
  _l2: true,
  dispose: vi.fn(async () => {}),
})));
const mockCreateFingerprintManager = vi.hoisted(() => vi.fn(() => ({
  ensureTable: vi.fn(),
  hasChanged: vi.fn(() => false),
  computeFingerprint: vi.fn(() => "fp-abc"),
  save: vi.fn(),
})));
const mockCreateBatchIndexer = vi.hoisted(() => vi.fn(() => ({
  reindexAll: vi.fn(async () => ({ indexed: 0, failed: 0 })),
  indexUnembedded: vi.fn(async () => ({ indexed: 0, failed: 0 })),
  unembeddedCount: vi.fn(() => 0),
})));
const mockCreateEmbeddingQueue = vi.hoisted(() => vi.fn(() => ({
  enqueue: vi.fn(),
  flush: vi.fn(),
})));

vi.mock("@comis/memory", () => ({
  SqliteMemoryAdapter: mockSqliteMemoryAdapter,
  createSessionStore: mockCreateSessionStore,
  createMemoryApi: mockCreateMemoryApi,
  createEmbeddingProvider: mockCreateEmbeddingProvider,
  createCachedEmbeddingPort: mockCreateCachedEmbeddingPort,
  createSqliteEmbeddingCache: mockCreateSqliteEmbeddingCache,
  createFingerprintManager: mockCreateFingerprintManager,
  createBatchIndexer: mockCreateBatchIndexer,
  createEmbeddingQueue: mockCreateEmbeddingQueue,
}));

const mockSafePath = vi.hoisted(() => vi.fn((...parts: string[]) => parts.join("/")));
vi.mock("@comis/core", () => ({
  safePath: mockSafePath,
}));

const mockCreateCircuitBreaker = vi.hoisted(() => vi.fn(() => ({
  isOpen: vi.fn(() => false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getState: vi.fn(() => "closed"),
  reset: vi.fn(),
})));
vi.mock("@comis/agent", () => ({
  createCircuitBreaker: mockCreateCircuitBreaker,
}));

vi.mock("@comis/shared", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return actual;
});

// ---------------------------------------------------------------------------
// Helpers
function createMinimalContainer(overrides: Record<string, any> = {}) {
  return {
    config: {
      memory: {
        dbPath: "/test/memory.db",
        embeddingDimensions: 768,
        ...overrides.memory,
      },
      embedding: {
        enabled: false,
        provider: "local",
        local: { modelUri: "gte-small", modelsDir: ".models" },
        openai: { model: "text-embedding-ada-002", dimensions: 1536 },
        cache: { maxEntries: 1000, persistent: false, persistentMaxEntries: 50000, pruneIntervalMs: 300000 },
        autoReindex: false,
        batch: { batchSize: 100, indexOnStartup: false },
        ...overrides.embedding,
      },
      dataDir: "/test/data",
    },
    secretManager: {
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupMemory() {
    const mod = await import("./setup-memory.js");
    return mod.setupMemory;
  }

  // -------------------------------------------------------------------------
  // 1. Creates basic memory services without embedding
  // -------------------------------------------------------------------------

  it("creates memoryAdapter, sessionStore, memoryApi without embedding when disabled", async () => {
    const container = createMinimalContainer({
      embedding: { enabled: false },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockSqliteMemoryAdapter).toHaveBeenCalled();
    expect(mockCreateSessionStore).toHaveBeenCalled();
    expect(mockCreateMemoryApi).toHaveBeenCalled();
    expect(result.memoryAdapter).toBeDefined();
    expect(result.sessionStore).toBeDefined();
    expect(result.memoryApi).toBeDefined();
    expect(result.disposeEmbedding).toBeUndefined();
    expect(result.cachedPort).toBeUndefined();
    expect(result.embeddingQueue).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. Creates embedding provider when enabled and result is ok
  // -------------------------------------------------------------------------

  it("creates embedding provider when enabled and result is ok", async () => {
    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local" },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockCreateEmbeddingProvider).toHaveBeenCalled();
    expect(result.cachedPort).toBeDefined();
    expect(result.cachedPort!.modelId).toBe("test-model");
    expect(result.disposeEmbedding).toBeTypeOf("function");
  });

  // -------------------------------------------------------------------------
  // 3. Falls back to FTS5-only when provider returns err
  // -------------------------------------------------------------------------

  it("falls back to FTS5-only when createEmbeddingProvider returns err", async () => {
    mockCreateEmbeddingProvider.mockResolvedValueOnce({
      ok: false,
      error: { message: "Provider not available" },
    });

    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local" },
    });
    const memoryLogger = createMockLogger();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: memoryLogger as any,
    });

    expect(result.disposeEmbedding).toBeUndefined();
    expect(memoryLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "Provider not available",
        errorKind: "config",
      }),
      expect.stringContaining("FTS5 only"),
    );
  });

  // -------------------------------------------------------------------------
  // 4. Wraps embedding with cache when maxEntries > 0
  // -------------------------------------------------------------------------

  it("wraps embedding with cache when cache.maxEntries > 0", async () => {
    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local", cache: { maxEntries: 500, persistent: false, persistentMaxEntries: 50000, pruneIntervalMs: 300000 } },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockCreateCachedEmbeddingPort).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "test-model" }),
      { maxEntries: 500, ttlMs: undefined },
    );
    expect(result.cachedPort).toBeDefined();
    expect((result.cachedPort as any)._cached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Uses provider dimensions to adjust memoryConfig
  // -------------------------------------------------------------------------

  it("uses provider dimensions to adjust memoryConfig.embeddingDimensions", async () => {
    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local", cache: { maxEntries: 100 } },
    });
    const setupMemory = await getSetupMemory();

    await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    // SqliteMemoryAdapter should receive adjusted config with provider's dimensions (384)
    const adapterArgs = mockSqliteMemoryAdapter.mock.calls[0];
    expect(adapterArgs[0].embeddingDimensions).toBe(384);
  });

  // -------------------------------------------------------------------------
  // 6. Triggers full reindex when autoReindex and fingerprint changed
  // -------------------------------------------------------------------------

  it("triggers full reindex when autoReindex is true and fingerprint has changed", async () => {
    const mockFpMgr = {
      ensureTable: vi.fn(),
      hasChanged: vi.fn(() => true),
      computeFingerprint: vi.fn(() => "fp-new"),
      save: vi.fn(),
    };
    mockCreateFingerprintManager.mockReturnValue(mockFpMgr);

    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local", autoReindex: true, cache: { maxEntries: 100 } },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockFpMgr.hasChanged).toHaveBeenCalled();
    expect(mockCreateBatchIndexer).toHaveBeenCalled();
    const batchIndexer = mockCreateBatchIndexer.mock.results[0].value;
    expect(batchIndexer.reindexAll).toHaveBeenCalled();
    expect(result.backgroundIndexingPromise).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 7. Triggers indexUnembedded when indexOnStartup and count > 0
  // -------------------------------------------------------------------------

  it("triggers indexUnembedded when batch.indexOnStartup is true and unembeddedCount > 0", async () => {
    const mockFpMgr = {
      ensureTable: vi.fn(),
      hasChanged: vi.fn(() => false),
      computeFingerprint: vi.fn(() => "fp-same"),
      save: vi.fn(),
    };
    mockCreateFingerprintManager.mockReturnValue(mockFpMgr);

    const mockBatchIndexer = {
      reindexAll: vi.fn(async () => ({ indexed: 0, failed: 0 })),
      indexUnembedded: vi.fn(async () => ({ indexed: 5, failed: 0 })),
      unembeddedCount: vi.fn(() => 5),
    };
    mockCreateBatchIndexer.mockReturnValue(mockBatchIndexer);

    const container = createMinimalContainer({
      embedding: {
        enabled: true,
        provider: "local",
        autoReindex: false,
        batch: { batchSize: 100, indexOnStartup: true },
        cache: { maxEntries: 100 },
      },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockBatchIndexer.unembeddedCount).toHaveBeenCalled();
    expect(mockBatchIndexer.indexUnembedded).toHaveBeenCalled();
    expect(result.backgroundIndexingPromise).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 8. Skips batch indexing when unembeddedCount is 0
  // -------------------------------------------------------------------------

  it("skips batch indexing when unembeddedCount is 0", async () => {
    const mockFpMgr = {
      ensureTable: vi.fn(),
      hasChanged: vi.fn(() => false),
      computeFingerprint: vi.fn(() => "fp-same"),
      save: vi.fn(),
    };
    mockCreateFingerprintManager.mockReturnValue(mockFpMgr);

    const mockBatchIndexer = {
      reindexAll: vi.fn(async () => ({ indexed: 0, failed: 0 })),
      indexUnembedded: vi.fn(async () => ({ indexed: 0, failed: 0 })),
      unembeddedCount: vi.fn(() => 0),
    };
    mockCreateBatchIndexer.mockReturnValue(mockBatchIndexer);

    const container = createMinimalContainer({
      embedding: {
        enabled: true,
        provider: "local",
        autoReindex: false,
        batch: { batchSize: 100, indexOnStartup: true },
        cache: { maxEntries: 100 },
      },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockBatchIndexer.indexUnembedded).not.toHaveBeenCalled();
    expect(result.backgroundIndexingPromise).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Creates embeddingQueue when cachedPort available
  // -------------------------------------------------------------------------

  it("creates embeddingQueue when cachedPort available", async () => {
    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local", cache: { maxEntries: 100 } },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockCreateEmbeddingQueue).toHaveBeenCalled();
    expect(result.embeddingQueue).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 10. Saves fingerprint after setup
  // -------------------------------------------------------------------------

  it("saves fingerprint after setup", async () => {
    const mockFpMgr = {
      ensureTable: vi.fn(),
      hasChanged: vi.fn(() => false),
      computeFingerprint: vi.fn(() => "fp-saved"),
      save: vi.fn(),
    };
    mockCreateFingerprintManager.mockReturnValue(mockFpMgr);

    const container = createMinimalContainer({
      embedding: { enabled: true, provider: "local", cache: { maxEntries: 100 } },
    });
    const setupMemory = await getSetupMemory();

    await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(mockFpMgr.save).toHaveBeenCalledWith("fp-saved");
  });

  // -------------------------------------------------------------------------
  // 11. Handles remote config (OPENAI_API_KEY lookup)
  // -------------------------------------------------------------------------

  it("looks up OPENAI_API_KEY via secretManager for remote config", async () => {
    const container = createMinimalContainer({
      embedding: {
        enabled: true,
        provider: "openai",
        openai: { model: "text-embedding-3-small", dimensions: 1536 },
        cache: { maxEntries: 0 },
      },
    });
    container.secretManager.get.mockReturnValue("sk-test-key-123");

    const setupMemory = await getSetupMemory();

    await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(container.secretManager.get).toHaveBeenCalledWith("OPENAI_API_KEY");
    expect(mockCreateEmbeddingProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        remote: expect.objectContaining({
          apiKey: "sk-test-key-123",
          model: "text-embedding-3-small",
          dimensions: 1536,
        }),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 12. Returns db handle
  // -------------------------------------------------------------------------

  it("returns db handle from memoryAdapter.getDb()", async () => {
    const container = createMinimalContainer();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(result.db).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 13. Two-tier wiring: L1(L2(provider)) when persistent=true
  // -------------------------------------------------------------------------

  it("wires two-tier L1(L2(provider)) when persistent=true", async () => {
    const container = createMinimalContainer({
      embedding: {
        enabled: true,
        provider: "local",
        cache: { maxEntries: 1000, persistent: true, persistentMaxEntries: 25000, ttlMs: 86400000, pruneIntervalMs: 600000 },
      },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    // L2 should be created with provider and db
    expect(mockCreateSqliteEmbeddingCache).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "test-model", provider: "test" }),
      expect.objectContaining({
        db: mockDb,
        maxEntries: 25000,
        ttlMs: 86400000,
        pruneIntervalMs: 600000,
      }),
    );

    // L1 should wrap L2 result (not raw provider)
    const l2Result = mockCreateSqliteEmbeddingCache.mock.results[0].value;
    expect(mockCreateCachedEmbeddingPort).toHaveBeenCalledWith(
      l2Result,
      { maxEntries: 1000, ttlMs: 86400000 },
    );

    expect(result.cachedPort).toBeDefined();
    expect((result.cachedPort as any)._cached).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 14. Skips L2 when persistent=false
  // -------------------------------------------------------------------------

  it("skips L2 when persistent=false", async () => {
    const container = createMinimalContainer({
      embedding: {
        enabled: true,
        provider: "local",
        cache: { maxEntries: 1000, persistent: false, persistentMaxEntries: 50000, pruneIntervalMs: 300000 },
      },
    });
    const setupMemory = await getSetupMemory();

    await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    // L2 should NOT be created
    expect(mockCreateSqliteEmbeddingCache).not.toHaveBeenCalled();

    // L1 should wrap raw provider directly
    expect(mockCreateCachedEmbeddingPort).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "test-model", provider: "test" }),
      { maxEntries: 1000, ttlMs: undefined },
    );
  });

  // -------------------------------------------------------------------------
  // 15. disposeEmbedding callback calls cachedPort.dispose
  // -------------------------------------------------------------------------

  it("disposeEmbedding callback calls cachedPort.dispose", async () => {
    const container = createMinimalContainer({
      embedding: {
        enabled: true,
        provider: "local",
        cache: { maxEntries: 1000, persistent: false, persistentMaxEntries: 50000, pruneIntervalMs: 300000 },
      },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(result.disposeEmbedding).toBeTypeOf("function");

    // Call disposeEmbedding and verify it delegates to cachedPort.dispose
    await result.disposeEmbedding!();

    const cachedPortMock = mockCreateCachedEmbeddingPort.mock.results[0].value;
    expect(cachedPortMock.dispose).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 16. disposeEmbedding is undefined when no embedding provider
  // -------------------------------------------------------------------------

  it("disposeEmbedding is undefined when no embedding provider", async () => {
    const container = createMinimalContainer({
      embedding: { enabled: false },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    expect(result.disposeEmbedding).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 17. maintenanceTick calls checkpoint every 10th invocation
  // -------------------------------------------------------------------------

  it("maintenanceTick calls checkpoint on 10th call but not before", async () => {
    const container = createMinimalContainer();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    for (let i = 0; i < 9; i++) result.maintenanceTick();
    expect(mockCheckpoint).not.toHaveBeenCalled();

    result.maintenanceTick();
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 18. maintenanceTick calls checkpoint again on 20th invocation
  // -------------------------------------------------------------------------

  it("maintenanceTick calls checkpoint again on 20th invocation", async () => {
    const container = createMinimalContainer();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    for (let i = 0; i < 20; i++) result.maintenanceTick();
    expect(mockCheckpoint).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 19. maintenanceTick survives checkpoint throwing
  // -------------------------------------------------------------------------

  it("maintenanceTick does not throw when checkpoint throws", async () => {
    mockCheckpoint.mockImplementationOnce(() => { throw new Error("disk full"); });
    const container = createMinimalContainer();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
    });

    for (let i = 0; i < 10; i++) result.maintenanceTick();
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
  });
});
