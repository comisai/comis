import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContextPipelineCollector } from "./context-pipeline-collector.js";
import type { PipelineSnapshot, DagCompactionSnapshot } from "./context-pipeline-collector.js";

// ---------------------------------------------------------------------------
// Helper: mock EventBus
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

function createMockEventBus() {
  const listeners = new Map<string, Handler[]>();
  return {
    on: vi.fn((event: string, handler: Handler) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    }),
    off: vi.fn((event: string, handler: Handler) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    }),
    emit: (event: string, payload: unknown) => {
      const arr = listeners.get(event) ?? [];
      for (const h of arr) h(payload);
    },
    _listeners: listeners,
  };
}

function makePipelinePayload(overrides?: Partial<PipelineSnapshot>) {
  return {
    agentId: "agent-1",
    sessionKey: "sess-1",
    tokensLoaded: 1000,
    tokensEvicted: 100,
    tokensMasked: 50,
    tokensCompacted: 0,
    thinkingBlocksRemoved: 2,
    budgetUtilization: 0.75,
    evictionCategories: { file_read: 3 },
    rereadCount: 0,
    rereadTools: [],
    sessionDepth: 10,
    sessionToolResults: 5,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    durationMs: 42,
    layerCount: 4,
    layers: [
      { name: "thinking-cleaner", durationMs: 5, messagesIn: 10, messagesOut: 8 },
      { name: "history-window", durationMs: 2, messagesIn: 8, messagesOut: 6 },
    ],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDagPayload(overrides?: Partial<DagCompactionSnapshot>) {
  return {
    conversationId: "conv-1",
    agentId: "agent-1",
    sessionKey: "sess-1",
    leafSummariesCreated: 3,
    condensedSummariesCreated: 1,
    maxDepthReached: 2,
    totalSummariesCreated: 4,
    durationMs: 120,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createContextPipelineCollector", () => {
  let bus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    bus = createMockEventBus();
  });

  it("captures context:pipeline events", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a1", timestamp: 1000 }));
    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a2", timestamp: 2000 }));

    const results = collector.getRecentPipelines();
    expect(results.length).toBe(2);
    // Newest first
    expect(results[0]!.agentId).toBe("a2");
    expect(results[1]!.agentId).toBe("a1");
  });

  it("captures context:dag_compacted events", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    bus.emit("context:dag_compacted", makeDagPayload({ agentId: "a1" }));

    const results = collector.getRecentDagCompactions();
    expect(results.length).toBe(1);
    expect(results[0]!.leafSummariesCreated).toBe(3);
  });

  it("enforces ring buffer max for pipelines", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any, maxPipelineEvents: 3 });

    for (let i = 0; i < 5; i++) {
      bus.emit("context:pipeline", makePipelinePayload({ timestamp: i * 100 }));
    }

    const results = collector.getRecentPipelines({ limit: 10 });
    expect(results.length).toBe(3);
    // Should have events 2, 3, 4 (oldest 0, 1 evicted)
    expect(results[0]!.timestamp).toBe(400);
    expect(results[2]!.timestamp).toBe(200);
  });

  it("enforces ring buffer max for DAG compactions", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any, maxDagEvents: 2 });

    for (let i = 0; i < 4; i++) {
      bus.emit("context:dag_compacted", makeDagPayload({ timestamp: i * 100 }));
    }

    const results = collector.getRecentDagCompactions({ limit: 10 });
    expect(results.length).toBe(2);
  });

  it("filters pipelines by agentId", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a1" }));
    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a2" }));
    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a1" }));

    const a1Results = collector.getRecentPipelines({ agentId: "a1" });
    expect(a1Results.length).toBe(2);

    const a2Results = collector.getRecentPipelines({ agentId: "a2" });
    expect(a2Results.length).toBe(1);
  });

  it("respects limit parameter", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    for (let i = 0; i < 10; i++) {
      bus.emit("context:pipeline", makePipelinePayload({ timestamp: i * 100 }));
    }

    const results = collector.getRecentPipelines({ limit: 3 });
    expect(results.length).toBe(3);
    // Newest first
    expect(results[0]!.timestamp).toBe(900);
  });

  it("reset clears both arrays", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    bus.emit("context:pipeline", makePipelinePayload());
    bus.emit("context:dag_compacted", makeDagPayload());

    expect(collector.getRecentPipelines().length).toBe(1);
    expect(collector.getRecentDagCompactions().length).toBe(1);

    collector.reset();

    expect(collector.getRecentPipelines().length).toBe(0);
    expect(collector.getRecentDagCompactions().length).toBe(0);
  });

  it("dispose unsubscribes all handlers", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    expect(bus.on).toHaveBeenCalledTimes(3);
    collector.dispose();
    expect(bus.off).toHaveBeenCalledTimes(3);

    // After dispose, events should not be captured
    bus.emit("context:pipeline", makePipelinePayload());
    expect(collector.getRecentPipelines().length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // context:pipeline:cache merge tests
  // -------------------------------------------------------------------------

  it("merges context:pipeline:cache into most recent pipeline snapshot", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a1", sessionKey: "s1", cacheHitTokens: 0, cacheWriteTokens: 0 }));
    bus.emit("context:pipeline:cache", { agentId: "a1", sessionKey: "s1", cacheHitTokens: 5000, cacheWriteTokens: 1000, cacheMissTokens: 200, timestamp: Date.now() });

    const results = collector.getRecentPipelines({ agentId: "a1" });
    expect(results.length).toBe(1);
    expect(results[0]!.cacheHitTokens).toBe(5000);
    expect(results[0]!.cacheWriteTokens).toBe(1000);
    expect(results[0]!.cacheMissTokens).toBe(200);
  });

  it("cache event does not affect snapshots from different agent", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a1", sessionKey: "s1", cacheHitTokens: 0 }));
    bus.emit("context:pipeline", makePipelinePayload({ agentId: "a2", sessionKey: "s2", cacheHitTokens: 0 }));
    bus.emit("context:pipeline:cache", { agentId: "a1", sessionKey: "s1", cacheHitTokens: 5000, cacheWriteTokens: 1000, cacheMissTokens: 200, timestamp: Date.now() });

    const a1Results = collector.getRecentPipelines({ agentId: "a1" });
    expect(a1Results[0]!.cacheHitTokens).toBe(5000);

    const a2Results = collector.getRecentPipelines({ agentId: "a2" });
    expect(a2Results[0]!.cacheHitTokens).toBe(0);
  });

  it("cache event with no matching pipeline snapshot is silently ignored", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    // Emit cache event without prior pipeline event -- should not crash
    bus.emit("context:pipeline:cache", { agentId: "a1", sessionKey: "s1", cacheHitTokens: 5000, cacheWriteTokens: 1000, cacheMissTokens: 200, timestamp: Date.now() });

    const results = collector.getRecentPipelines();
    expect(results.length).toBe(0);
  });

  it("preserves layers data in pipeline snapshots", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collector = createContextPipelineCollector({ eventBus: bus as any });

    const layers = [
      { name: "thinking-cleaner", durationMs: 5, messagesIn: 10, messagesOut: 8 },
      { name: "dead-content-evictor", durationMs: 12, messagesIn: 8, messagesOut: 6 },
    ];
    bus.emit("context:pipeline", makePipelinePayload({ layers }));

    const results = collector.getRecentPipelines();
    expect(results[0]!.layers).toEqual(layers);
  });
});
