// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventBus } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";

// setupMemory requires a ClockPort (createCircuitBreaker(..., clock)).
// Inject the project-standard fake so every call exercises the real signature.
const testClock = createFakeClock(0);
const testTimers = createFakeTimers(0);

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
// LCD lossless store factory (ContextStorePort) — mocked so setup wires it
// without a real DB. setupMemory constructs it on the shared db handle beside
// createSessionStore (Phase 127); without the mock entry the @comis/memory
// factory is undefined and EVERY setup call throws `createLcdStore is not a
// function` (the MEMORY.md "setup-memory mock" gate). The two port methods are
// stubbed (the append write + the conversation-scoped getMessages read).
const mockCreateLcdStore = vi.hoisted(() => vi.fn(() => ({ append: vi.fn(), getMessages: vi.fn(() => []) })));
// LcdProvenanceReadStore stub (Phase 173, DIST-03 read side) — setupMemory now also
// builds the provenance read adapter on the shared db (buildProvenanceReadStore) and
// threads it to createMemoryRecall's down-weighting pass. Without the mock entry the
// factory is undefined and EVERY setup call throws (the setup-memory mock gate).
const mockBuildProvenanceReadStore = vi.hoisted(() => vi.fn(() => ({ getProvenanceForSummary: vi.fn(() => []) })));
// ContextBrowsePort stub — the operator-browse read surface (createLcdBrowseStore)
// setupMemory now also builds on the shared db (backs context.conversations).
const mockCreateLcdBrowseStore = vi.hoisted(() => vi.fn(() => ({ listConversations: vi.fn(() => ({ conversations: [], total: 0 })) })));
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
// Reranker provider factory — mocked so no real ~606MB GGUF ever loads in unit tests.
const mockRerankerDispose = vi.hoisted(() => vi.fn(async () => {}));
const mockCreateLocalRerankerProvider = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  value: { isAvailable: () => true, rank: vi.fn(async () => ({ ok: true, value: [] })), dispose: mockRerankerDispose },
})));
// Reranker model-present probe. Default: ABSENT (false) — the
// fresh-install posture. Without this entry the @comis/memory `rerankerModelPresent`
// import is undefined and EVERY setupMemory call throws once the build gate calls it
// (same failure mode as the consolidation-store mock above). Per-test override the
// resolved value with `mockRerankerModelPresent.mockResolvedValueOnce(true)`.
const mockRerankerModelPresent = vi.hoisted(() => vi.fn(async () => false));
// Entity store factory — mocked so setup wires it without a real DB.
const mockCreateSqliteMemoryEntityStore = vi.hoisted(() => vi.fn(() => ({
  resolveAndLink: vi.fn(async () => ({ ok: true, value: { ok: true, value: undefined } })),
  associativeLane: vi.fn(async () => ({ ok: true, value: [] })),
})));
// Consolidation store factory — mocked so setup wires it without a real DB.
// setupMemory now builds this on the shared db handle (mirror the entity store); without
// the mock entry the @comis/memory factory is undefined and every setup call throws.
const mockCreateSqliteMemoryConsolidationStore = vi.hoisted(() => vi.fn(() => ({
  listConsolidationCandidates: vi.fn(async () => ({ ok: true, value: [] })),
  listObservations: vi.fn(async () => ({ ok: true, value: [] })),
  applyConsolidation: vi.fn(async () => ({ ok: true, value: undefined })),
  // The port gained foldIntoExisting; without this stub the
  // mock no longer satisfies the MemoryConsolidationStore surface and every
  // setupMemory test that touches the store throws `foldIntoExisting is not a
  // function` (the MEMORY.md "setup-memory mock" gate).
  foldIntoExisting: vi.fn(async () => ({ ok: true, value: undefined })),
})));
// Usefulness store factory — mocked so setup wires it without a real
// DB. setupMemory builds this on the shared db handle (mirror the entity + consolidation
// stores); without the mock entry the @comis/memory factory is undefined and EVERY setup
// call throws `createSqliteMemoryUsefulnessStore is not a function` (the MEMORY.md
// "setup-memory mock" gate).
const mockCreateSqliteMemoryUsefulnessStore = vi.hoisted(() => vi.fn(() => ({
  recordUsage: vi.fn(async () => ({ ok: true, value: undefined })),
  readUsefulness: vi.fn(async () => ({ ok: true, value: new Map() })),
})));
// Temporal-spread store factory — mocked so setup wires it without a
// real DB. setupMemory builds this on the shared db handle (mirror the entity/consolidation/
// usefulness stores); without the mock entry the @comis/memory factory is undefined and
// EVERY setup call throws `createSqliteMemoryTemporalStore is not a function` (the MEMORY.md
// "setup-memory mock" gate).
const mockCreateSqliteMemoryTemporalStore = vi.hoisted(() => vi.fn(() => ({
  spreadLane: vi.fn(async () => ({ ok: true, value: [] })),
})));
// Causal store factory — mocked so setup wires it without a real DB.
// setupMemory builds this on the shared db handle (mirror the entity/temporal/consolidation/
// usefulness stores); without the mock entry the @comis/memory factory is undefined and EVERY
// setup call throws `createSqliteMemoryCausalStore is not a function` (the MEMORY.md
// "setup-memory mock" gate). Both port methods are stubbed (the read causalLane +
// the write linkCausal — one segregated port, both halves).
const mockCreateSqliteMemoryCausalStore = vi.hoisted(() => vi.fn(() => ({
  linkCausal: vi.fn(async () => ({ ok: true, value: 0 })),
  causalLane: vi.fn(async () => ({ ok: true, value: [] })),
})));
// Triple store factory — mocked so setup wires it without a real DB.
// setupMemory builds this on the shared db handle (mirror the entity/temporal/causal/
// consolidation/usefulness stores); without the mock entry the @comis/memory factory is
// undefined and EVERY setup call throws `createSqliteTripleStore is not a function` (the
// MEMORY.md "setup-memory mock" gate). All four port methods are stubbed
// (the write upsertTriple + the reads asOf / currentTruth / spreadLane — one segregated
// bi-temporal KG port, all halves).
const mockCreateSqliteTripleStore = vi.hoisted(() => vi.fn(() => ({
  upsertTriple: vi.fn(async () => ({ ok: true, value: undefined })),
  asOf: vi.fn(async () => ({ ok: true, value: [] })),
  currentTruth: vi.fn(async () => ({ ok: true, value: [] })),
  spreadLane: vi.fn(async () => ({ ok: true, value: [] })),
})));
// Embedding store factory — mocked so setup wires it without a real DB.
// setupMemory builds this on the shared db handle (mirror the entity/temporal/causal/triple/
// consolidation/usefulness stores); without the mock entry the @comis/memory factory is
// undefined and EVERY setup call throws `createSqliteMemoryEmbeddingStore is not a function`
// (the MEMORY.md "setup-memory mock" gate). The sole port method is stubbed (the
// bulk-scoped readEmbeddings the MMR diversity re-rank hydrates from).
const mockCreateSqliteMemoryEmbeddingStore = vi.hoisted(() => vi.fn(() => ({
  readEmbeddings: vi.fn(async () => ({ ok: true, value: new Map() })),
})));
// Directional relationship store factory — mocked so setup
// wires it without a real DB. setupMemory builds this on the shared db handle (mirror the
// triple/embedding stores); without the mock entry the @comis/memory factory is
// undefined and EVERY setup call throws `createSqliteRelationshipStore is not a function` (the
// MEMORY.md "setup-memory mock" gate). The two segregated port halves are stubbed (the
// directional upsert write + the (tenant, agent, channel)-scoped read the prompt-assembly injection reads).
const mockCreateSqliteRelationshipStore = vi.hoisted(() => vi.fn(() => ({
  upsert: vi.fn(async () => ({ ok: true, value: undefined })),
  read: vi.fn(async () => ({ ok: true, value: [] })),
})));
// Outcome-signal store factory (Verified Learning WS1) — mocked so setupMemory wires it
// (createSqliteOutcomeStore + wireLearningOutcome) without a real DB. Without the mock entry the
// @comis/memory factory is undefined and EVERY setup call throws `createSqliteOutcomeStore is not
// a function` (the MEMORY.md "setup-memory mock" gate). The 3 OutcomeSignalPort methods are
// stubbed; the subscriber is default-OFF (no agent opts in) so observe/resolve never fire here.
const mockCreateSqliteOutcomeStore = vi.hoisted(() => vi.fn(() => ({
  observe: vi.fn(async () => ({ ok: true, value: undefined })),
  resolve: vi.fn(async () => ({ ok: true, value: { outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] } })),
  prune: vi.fn(() => ({ changes: 0 })),
})));
// Memory-lifecycle sweep store factory — mocked so setup wires
// it without a real DB. setupMemory builds this on the shared db handle (mirror the tuned-alpha
// store); without the mock entry the @comis/memory factory is undefined and EVERY setup call
// throws `createSqliteMemoryLifecycleStore is not a function` (the MEMORY.md "setup-memory mock"
// gate). The sole port method is stubbed (the DORMANT runLifecycleSweep — the
// scaffold evicts/demotes 0 rows, so the all-0 report).
const mockCreateSqliteMemoryLifecycleStore = vi.hoisted(() => vi.fn(() => ({
  runLifecycleSweep: vi.fn(async () => ({ ok: true, value: { scanned: 0, promoted: 0, demoted: 0, evicted: 0 } })),
})));
// Mental-model store factory (the kind-generic learned-skill store, SKILL-01) — mocked so setup wires it
// on the shared db without a real DB (mirror the outcome store). Without the mock entry the @comis/memory
// factory is undefined and EVERY setup call throws `createSqliteMentalModelStore is not a function`. The
// port methods are stubbed.
const mockCreateSqliteMentalModelStore = vi.hoisted(() => vi.fn(() => ({
  admit: vi.fn(async () => ({ ok: true, value: undefined })),
  get: vi.fn(async () => ({ ok: true, value: undefined })),
  list: vi.fn(async () => ({ ok: true, value: [] })),
  promote: vi.fn(async () => ({ ok: true, value: undefined })),
  demote: vi.fn(async () => ({ ok: true, value: undefined })),
  evict: vi.fn(async () => ({ ok: true, value: undefined })),
})));

vi.mock("@comis/memory", () => ({
  SqliteMemoryAdapter: mockSqliteMemoryAdapter,
  createSessionStore: mockCreateSessionStore,
  createLcdStore: mockCreateLcdStore,
  buildProvenanceReadStore: mockBuildProvenanceReadStore,
  createLcdBrowseStore: mockCreateLcdBrowseStore,
  createMemoryApi: mockCreateMemoryApi,
  createEmbeddingProvider: mockCreateEmbeddingProvider,
  createCachedEmbeddingPort: mockCreateCachedEmbeddingPort,
  createSqliteEmbeddingCache: mockCreateSqliteEmbeddingCache,
  createFingerprintManager: mockCreateFingerprintManager,
  createBatchIndexer: mockCreateBatchIndexer,
  createEmbeddingQueue: mockCreateEmbeddingQueue,
  createLocalRerankerProvider: mockCreateLocalRerankerProvider,
  rerankerModelPresent: mockRerankerModelPresent,
  createSqliteMemoryEntityStore: mockCreateSqliteMemoryEntityStore,
  createSqliteMemoryConsolidationStore: mockCreateSqliteMemoryConsolidationStore,
  createSqliteMemoryUsefulnessStore: mockCreateSqliteMemoryUsefulnessStore,
  createSqliteMemoryTemporalStore: mockCreateSqliteMemoryTemporalStore,
  createSqliteMemoryCausalStore: mockCreateSqliteMemoryCausalStore,
  createSqliteTripleStore: mockCreateSqliteTripleStore,
  createSqliteMemoryEmbeddingStore: mockCreateSqliteMemoryEmbeddingStore,
  createSqliteRelationshipStore: mockCreateSqliteRelationshipStore,
  createSqliteMemoryLifecycleStore: mockCreateSqliteMemoryLifecycleStore,
  createSqliteOutcomeStore: mockCreateSqliteOutcomeStore,
  createSqliteMentalModelStore: mockCreateSqliteMentalModelStore,
}));

const mockSafePath = vi.hoisted(() => vi.fn((...parts: string[]) => parts.join("/")));
// Preserve the REAL TypedEventBus (the recall-counter "subscriber is live" test drives a
// real bus through setupMemory's wireRecallCounters call) while still stubbing
// safePath. The rest of @comis/core stays as-is so the wiring is exercised end to
// end against the actual event bus, not a vi.fn() stand-in.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, safePath: mockSafePath };
});

const mockCreateCircuitBreaker = vi.hoisted(() => vi.fn(() => ({
  isOpen: vi.fn(() => false),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getState: vi.fn(() => "closed"),
  reset: vi.fn(),
})));
// Partial mock: override only createCircuitBreaker (the embedding breaker stub);
// keep the REAL createSummarizerSpendBreaker + estimateMessageTokens (both pure,
// deterministic, no I/O) so the R1 (132-05) daemon-owned breaker construction is
// exercised end-to-end against the actual unit, not a stand-in.
vi.mock("@comis/agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createCircuitBreaker: mockCreateCircuitBreaker };
});

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
        rerankerModel: "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf",
        rerankerModelsDir: "models",
        rerankerGpu: "auto",
        rerankerThreads: 4,
        ...overrides.memory,
      },
      // Per-agent configs scanned for rag.rerank.enabled (the build gate fallback path).
      // Default: a single all-default agent with rerank OFF -> the factory must NOT be called.
      agents: overrides.agents ?? { default: { rag: { rerank: { enabled: false } } } },
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
    // The build gate reads this RAW (pre-Zod-default) map when present
    // so it shares ONE definition of "explicitly on" with the per-agent precedence. When
    // omitted (undefined), setupMemory falls back to scanning the parsed config.agents.
    rawAgentRerankEnabled: overrides.rawAgentRerankEnabled,
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
      clock: testClock,
      timers: testTimers,
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
  // 1b. Builds + returns the LCD provenance read store (Phase 173, DIST-03 read
  //     side, Link 1 of the carry-in wiring chain). The built-but-not-wired guard
  //     for the FIRST link: setupMemory must construct buildProvenanceReadStore(db)
  //     on the shared db handle and expose it as `provenanceStore` so the daemon can
  //     thread it onward to createMemoryRecall's down-weighting pass. Paired with
  //     the prompt-assembly + setup-agents wiring guards (the last links).
  // -------------------------------------------------------------------------

  it("builds buildProvenanceReadStore on the shared db and returns it as provenanceStore (DIST-03 Link 1)", async () => {
    const container = createMinimalContainer({ embedding: { enabled: false } });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // The factory was called on the SAME db handle as createLcdStore.
    expect(mockBuildProvenanceReadStore).toHaveBeenCalledOnce();
    expect(mockBuildProvenanceReadStore).toHaveBeenCalledWith(mockDb);
    // The result is surfaced — the daemon threads this exact value onward.
    expect(result.provenanceStore).toBeDefined();
    expect(result.provenanceStore).toBe(mockBuildProvenanceReadStore.mock.results[0]!.value);
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
      clock: testClock,
      timers: testTimers,
    });

    expect(mockCreateEmbeddingProvider).toHaveBeenCalled();
    expect(result.cachedPort).toBeDefined();
    expect(result.cachedPort!.modelId).toBe("test-model");
    expect(result.disposeEmbedding).toBeTypeOf("function");
    // The injected ClockPort must reach createCircuitBreaker as its 2nd
    // arg — proves the required `clock` dep is actually exercised, not ignored.
    expect(mockCreateCircuitBreaker).toHaveBeenCalledWith(
      expect.any(Object),
      testClock,
    );
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
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
      clock: testClock,
      timers: testTimers,
    });

    for (let i = 0; i < 10; i++) result.maintenanceTick();
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 20. Reranker build gating — no default download
  // -------------------------------------------------------------------------

  it("does NOT build the reranker for an all-default (rerank-off) config + model ABSENT (no 606MB download)", async () => {
    // Fresh all-default install, model NOT present locally.
    // The probe resolves false (default mock), the build gate is
    // `someAgentExplicitOn(false) || modelPresent(false)` = false → the SOLE download
    // trigger (createLocalRerankerProvider) is NEVER reached → zero bytes fetched.
    mockRerankerModelPresent.mockResolvedValueOnce(false);
    const container = createMinimalContainer(); // default agent has rerank OFF
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // The factory must never be invoked when no agent enabled rerank AND model absent.
    expect(mockCreateLocalRerankerProvider).not.toHaveBeenCalled();
    expect(result.rerankerPort).toBeUndefined();
    // The threaded presence signal the composition root passes to setupAgents.
    expect(result.rerankerModelPresent).toBe(false);
  });

  it("auto-builds the reranker when the model is present (all-default config)", async () => {
    // All agents all-default (rerank unset → false), but the
    // GGUF is already cached locally → the probe resolves true → the widened gate
    // `someAgentExplicitOn(false) || modelPresent(true)` = true builds the port. No
    // schema flip; the auto-on is a daemon-wiring decision keyed on local presence.
    mockRerankerModelPresent.mockResolvedValueOnce(true);
    const container = createMinimalContainer(); // default agent has rerank OFF (unset → false)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockCreateLocalRerankerProvider).toHaveBeenCalledOnce();
    expect(result.rerankerPort).toBeDefined();
    expect(result.rerankerPort!.isAvailable()).toBe(true);
    expect(result.rerankerModelPresent).toBe(true);
  });

  it("probes presence with the SAME modelsDir it would build with (one safePath, no drift)", async () => {
    // The probe and the factory MUST consult the same resolved modelsDir so
    // the two gates can never disagree. Assert the probe was called with the same
    // modelUri + safePath-derived modelsDir the factory receives.
    mockRerankerModelPresent.mockResolvedValueOnce(true);
    const container = createMinimalContainer();
    const setupMemory = await getSetupMemory();

    await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockRerankerModelPresent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelUri: "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf",
        modelsDir: expect.stringContaining("models"),
      }),
    );
  });

  it("degrades to no-build + WARN (never throws) when the models dir cannot be resolved", async () => {
    // A relative/degenerate dataDir can make safePath REJECT the models dir (it would
    // escape the base). Auto-on is best-effort: the probe block must degrade to
    // modelPresent=false and NOT throw into daemon startup. With no explicit-on agent,
    // shouldBuild stays false → factory not called → recall degrades to fusion.
    mockSafePath.mockImplementationOnce(() => {
      throw new Error("Path traversal blocked");
    });
    const container = createMinimalContainer(); // all-default, model URI set
    const memoryLogger = createMockLogger();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: memoryLogger as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockCreateLocalRerankerProvider).not.toHaveBeenCalled();
    expect(result.rerankerPort).toBeUndefined();
    expect(result.rerankerModelPresent).toBe(false);
    expect(memoryLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "config" }),
      expect.stringContaining("Reranker model-present probe skipped"),
    );
  });

  it("does NOT throw into startup when an explicit-on agent hits a safePath rejection on the build path", async () => {
    // When someAgentExplicitOn is true, shouldBuild is true even though the probe's
    // safePath threw (rerankerModelsDir left undefined). The build block then re-invokes
    // safePath with the SAME args that just threw. On the OLD code that re-invoke is
    // UNCAUGHT and propagates into daemon startup. safePath throws on EVERY call here, so
    // both the probe AND the build re-invoke reject — the fix must catch the build-path
    // rejection and degrade to a WARN + no port (recall falls back to fusion), never throw.
    mockSafePath.mockImplementation(() => {
      throw new Error("Path traversal blocked");
    });
    const container = createMinimalContainer({
      agents: { researcher: { rag: { rerank: { enabled: true } } } },
      rawAgentRerankEnabled: new Map<string, boolean | undefined>([["researcher", true]]),
    });
    const memoryLogger = createMockLogger();
    const setupMemory = await getSetupMemory();

    // The load-bearing assertion: setupMemory resolves (no throw into bootstrap).
    const result = await setupMemory({
      container,
      memoryLogger: memoryLogger as any,
      clock: testClock,
      timers: testTimers,
    });

    // Degrades cleanly: no port built, recall falls back to fusion.
    expect(result.rerankerPort).toBeUndefined();
    expect(result.rerankerModelPresent).toBe(false);
    // Restore the default safePath behavior for subsequent tests.
    mockSafePath.mockImplementation((...parts: string[]) => parts.join("/"));
  });

  it("skips the probe entirely when no reranker model is configured (modelPresent=false)", async () => {
    // Unconfigured reranker (undefined modelUri) → there is nothing to probe; treat as
    // absent without calling the probe or computing safePath (the structurally-off path).
    const container = createMinimalContainer({
      memory: { rerankerModel: undefined },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockRerankerModelPresent).not.toHaveBeenCalled();
    expect(mockCreateLocalRerankerProvider).not.toHaveBeenCalled();
    expect(result.rerankerModelPresent).toBe(false);
  });

  it("builds the reranker when at least one agent enables rerank and the factory succeeds", async () => {
    const container = createMinimalContainer({
      agents: {
        default: { rag: { rerank: { enabled: false } } },
        researcher: { rag: { rerank: { enabled: true } } },
      },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockCreateLocalRerankerProvider).toHaveBeenCalledOnce();
    // safePath used for the models dir (no path.join).
    expect(mockCreateLocalRerankerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        modelUri: "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf",
        modelsDir: expect.stringContaining("models"),
        gpu: "auto",
        // The 4-8 thread CPU bound must reach the factory.
        threads: 4,
      }),
    );
    expect(result.rerankerPort).toBeDefined();
    expect(result.rerankerPort!.isAvailable()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The build gate keys on the SAME raw pre-default signal the per-agent
  // precedence consumes (container.rawAgentRerankEnabled), so the two gates share
  // one definition of "explicitly on" and cannot desync on a future schema change.
  // -------------------------------------------------------------------------

  it("builds the reranker from the RAW map when an agent is explicitly on, model absent (opt-in download)", async () => {
    // The raw map says `researcher` is explicit-on (true). modelPresent=false. The gate
    // is `someAgentExplicitOn(true) || modelPresent(false)` = true → factory called. This
    // exercises the raw-map branch, NOT the parsed-config fallback.
    mockRerankerModelPresent.mockResolvedValueOnce(false);
    const container = createMinimalContainer({
      // Parsed config carries concrete false for everyone (the Zod default) — proving the
      // gate did NOT read the parsed config (which would yield someAgentExplicitOn=false).
      agents: { default: { rag: { rerank: { enabled: false } } }, researcher: { rag: { rerank: { enabled: false } } } },
      rawAgentRerankEnabled: new Map<string, boolean | undefined>([
        ["default", undefined],
        ["researcher", true],
      ]),
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockCreateLocalRerankerProvider).toHaveBeenCalledOnce();
    expect(result.rerankerPort).toBeDefined();
  });

  it("does NOT build the reranker when the RAW map shows only unset agents and model absent (via raw)", async () => {
    // The raw map shows all agents UNSET (undefined) — none explicit-on. modelPresent=false.
    // The gate is false → zero download. Crucially the parsed config below carries
    // `enabled: true` for one agent, which the OLD parsed-config gate would have treated as
    // explicit-on and built — so this asserts the gate truly reads the raw map (which says
    // unset), preserving the zero-download posture keyed on the genuine operator signal.
    mockRerankerModelPresent.mockResolvedValueOnce(false);
    const container = createMinimalContainer({
      agents: { default: { rag: { rerank: { enabled: true } } } },
      rawAgentRerankEnabled: new Map<string, boolean | undefined>([["default", undefined]]),
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(mockCreateLocalRerankerProvider).not.toHaveBeenCalled();
    expect(result.rerankerPort).toBeUndefined();
    expect(result.rerankerModelPresent).toBe(false);
  });

  it("leaves rerankerPort undefined + WARNs when the factory returns err", async () => {
    mockCreateLocalRerankerProvider.mockResolvedValueOnce({
      ok: false,
      error: { message: "model load failed" },
    });
    const container = createMinimalContainer({
      agents: { default: { rag: { rerank: { enabled: true } } } },
    });
    const memoryLogger = createMockLogger();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: memoryLogger as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(result.rerankerPort).toBeUndefined();
    expect(memoryLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      expect.stringContaining("Reranker"),
    );
  });

  it("disposes the rerankerPort via a disposeReranker callback (no leaked native context)", async () => {
    const container = createMinimalContainer({
      agents: { default: { rag: { rerank: { enabled: true } } } },
    });
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    expect(result.disposeReranker).toBeTypeOf("function");
    await result.disposeReranker!();
    expect(mockRerankerDispose).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Consolidation store wiring — built on the shared db
  // -------------------------------------------------------------------------

  it("builds the consolidation store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (consolidation OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no opt-in gate at build time — only the cron is gated).
    expect(mockCreateSqliteMemoryConsolidationStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle (the same mockDb the
    // entity store + caches receive) — NOT a second Database. This is what keeps the
    // observation columns + FK behaviour consistent with the memories it consolidates.
    expect(mockCreateSqliteMemoryConsolidationStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.consolidationStore).toBeDefined();
  });

  it("builds the usefulness store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (feedback OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no opt-in gate at build time — only the
    // write-back subscriber, wired separately, is gated).
    expect(mockCreateSqliteMemoryUsefulnessStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle (the same mockDb the
    // entity + consolidation stores receive) — NOT a second Database. This is what keeps
    // the (tenant, agent) scope + the memory_id ON DELETE CASCADE consistent with the
    // memory rows it scores.
    expect(mockCreateSqliteMemoryUsefulnessStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.usefulnessStore).toBeDefined();
  });

  // (The tuned-alpha store construction test was removed in Phase 224 — the UCB recall bandit
  // store was deleted; setup-memory no longer builds or returns a tunedAlphaStore.)

  it("builds the memory-lifecycle sweep store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (lifecycle cron OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no model/IO cost; it stays DORMANT — even when the KEYLESS
    // __MEMORY_LIFECYCLE__ cron memoryLifecycle.enabled is on, the sweep evicts/demotes 0 rows).
    expect(mockCreateSqliteMemoryLifecycleStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle — NOT a second Database — so the
    // sweep scans the SAME (tenant, agent)-scoped memories rows + the additive marker columns.
    expect(mockCreateSqliteMemoryLifecycleStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.memoryLifecycleStore).toBeDefined();
  });

  it("builds the temporal-spread store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (temporal lane OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no opt-in gate at build time — only the lane push in
    // memory-recall.ts is gated on rag.lanes.temporal.enabled, default OFF). Without the
    // mock-map entry this call throws "createSqliteMemoryTemporalStore is not a function".
    expect(mockCreateSqliteMemoryTemporalStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle (the same mockDb the
    // entity/consolidation/usefulness stores receive) — NOT a second Database. This keeps
    // the (tenant, agent) isolation scope consistent with the memory rows it windows over.
    expect(mockCreateSqliteMemoryTemporalStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.temporalStore).toBeDefined();
  });

  it("builds the causal store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (causal lane OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no opt-in gate at build time — only the lane push in
    // memory-recall.ts is gated on rag.lanes.causal.enabled, default OFF, and the agent-side
    // linkCausal write guards on m.causes). Without the mock-map entry this call throws
    // "createSqliteMemoryCausalStore is not a function".
    expect(mockCreateSqliteMemoryCausalStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle (the same mockDb the
    // entity/temporal/consolidation/usefulness stores receive) — NOT a second Database. This
    // keeps the (tenant, agent) isolation scope + the memory_id ON DELETE CASCADE consistent
    // with the memory rows the edges link, AND means the read lane + the cron-review write
    // share one FK-enabled connection.
    expect(mockCreateSqliteMemoryCausalStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.causalStore).toBeDefined();
  });

  it("builds the triple store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (graphSpread lane OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no opt-in gate at build time — only the 6th graphSpread lane
    // push in memory-recall.ts is gated on rag.lanes.graphSpread.enabled, default OFF, and
    // the offline triple-extraction job is its own default-OFF cost gate). Without the
    // mock-map entry this call throws "createSqliteTripleStore is not a function".
    expect(mockCreateSqliteTripleStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle (the same mockDb the
    // entity/temporal/causal/consolidation/usefulness stores receive) — NOT a second
    // Database. This keeps the (tenant, agent) isolation scope + the source_memory_id ON
    // DELETE CASCADE consistent with the memory rows the triples reference, AND means the
    // graph-spread read lane shares one FK-enabled connection with those rows.
    expect(mockCreateSqliteTripleStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.tripleStore).toBeDefined();
  });

  it("builds the embedding store on the SAME shared db handle and returns it", async () => {
    const container = createMinimalContainer(); // all-default config (rag.mmr OFF)
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container,
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // Built UNCONDITIONALLY (no opt-in gate at build time — only the MMR slot in
    // memory-recall.ts is gated on rag.mmr.enabled, default OFF, so the embedding read never
    // runs until an operator opts in). Without the mock-map entry this call throws
    // "createSqliteMemoryEmbeddingStore is not a function".
    expect(mockCreateSqliteMemoryEmbeddingStore).toHaveBeenCalledOnce();
    // The SOLE adapter must share the memory adapter's db handle (the same mockDb the
    // entity/temporal/causal/triple/consolidation/usefulness stores receive) — NOT a second
    // Database. This keeps the (tenant, agent) isolation scope consistent with the memory rows
    // whose embeddings the scoped LEFT JOIN vec_memories read hydrates for the MMR re-rank.
    expect(mockCreateSqliteMemoryEmbeddingStore).toHaveBeenCalledWith(
      expect.objectContaining({ db: mockDb }),
    );
    expect(result.embeddingStore).toBeDefined();
    // The bulk-scoped read the MMR diversity re-rank hydrates from (mirror the temporal/triple
    // presence assertions — a defined port method proves the store, not just a truthy field).
    expect(result.embeddingStore.readEmbeddings).toBeTypeOf("function");
  });
});

// ---------------------------------------------------------------------------
// Recall-counter composition — wireRecallCounters subscribed
// at the memory composition site; the shared snapshot reaches the result so the
// memory.recall_stats handler reads LIVE counters.
// ---------------------------------------------------------------------------

describe("setupMemory recall-counter wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupMemory() {
    const mod = await import("./setup-memory.js");
    return mod.setupMemory;
  }

  /** A container whose eventBus is a REAL TypedEventBus so the wired subscriber
   *  is exercised end to end (emit -> snapshot), not a vi.fn() stub. */
  function containerWithRealBus(bus: TypedEventBus) {
    return {
      config: {
        memory: {
          dbPath: "/test/memory.db",
          embeddingDimensions: 768,
          rerankerModel: "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf",
          rerankerModelsDir: "models",
          rerankerGpu: "auto",
          rerankerThreads: 4,
        },
        agents: { default: { rag: { rerank: { enabled: false } } } },
        embedding: {
          enabled: false,
          provider: "local",
          local: { modelUri: "gte-small", modelsDir: ".models" },
          openai: { model: "text-embedding-ada-002", dimensions: 1536 },
          cache: { maxEntries: 1000, persistent: false, persistentMaxEntries: 50000, pruneIntervalMs: 300000 },
          autoReindex: false,
          batch: { batchSize: 100, indexOnStartup: false },
        },
        dataDir: "/test/data",
      },
      secretManager: { get: vi.fn(() => undefined), has: vi.fn(() => false) },
      eventBus: bus,
    } as any;
  }

  it("exposes a recallCounters snapshot accessor on the MemoryResult so the deps reach the live registry", async () => {
    const bus = new TypedEventBus();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container: containerWithRealBus(bus),
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });

    // The composition-root glue: the result carries the snapshot accessor the
    // daemon threads into MemoryApiDeps.recallCounters.
    expect(result.recallCounters).toBeDefined();
    expect(result.recallCounters!.snapshot).toBeTypeOf("function");
    // A fresh registry reads zero before any recall.
    expect(result.recallCounters!.snapshot().recalls).toBe(0);
  });

  it("subscribes the recall counters to the live event bus so an emitted memory:recalled is reflected in the snapshot", async () => {
    const bus = new TypedEventBus();
    const setupMemory = await getSetupMemory();

    const result = await setupMemory({
      container: containerWithRealBus(bus),
      memoryLogger: createMockLogger() as any,
      clock: testClock,
      timers: testTimers,
    });
    expect(result.recallCounters).toBeDefined();

    // Emitting on the SAME bus setupMemory wired must move the shared snapshot —
    // proving the subscriber is live (not a fresh registry per snapshot call).
    bus.emit("memory:recalled", {
      agentId: "a1",
      sessionKey: "s1",
      traceId: "t1",
      lanes: 3,
      ftsCandidates: 5,
      vectorCandidates: 4,
      entityCandidates: 2,
      finalCount: 3,
      rerankerAvailable: true,
      durationMs: 10,
      timestamp: 1_000,
    });

    const snap = result.recallCounters!.snapshot();
    expect(snap.recalls).toBe(1);
    expect(snap.recallsWithHits).toBe(1);
    expect(snap.laneUsage).toEqual({ fts: 5, vector: 4, entity: 2 });
  });
});
