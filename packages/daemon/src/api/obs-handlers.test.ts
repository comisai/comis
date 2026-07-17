// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { createObsHandlers } from "./obs-handlers/index.js";
import type { ObsHandlerDeps } from "./obs-handlers/index.js";

// ---------------------------------------------------------------------------
// Helper: create isolated mock deps per test
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<ObsHandlerDeps>): ObsHandlerDeps {
  return {
    diagnosticCollector: {
      getRecent: vi.fn().mockReturnValue([]),
      getCounts: vi.fn().mockReturnValue({ usage: 0, webhook: 0, message: 0, session: 0 }),
      reset: vi.fn(),
      prune: vi.fn().mockReturnValue(0),
      dispose: vi.fn(),
    },
    billingEstimator: {
      byProvider: vi.fn().mockReturnValue([]),
      byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      total: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
      usage24h: vi.fn().mockReturnValue(Array.from({ length: 24 }, (_, i) => ({ hour: i, tokens: 0 }))),
    },
    channelActivityTracker: {
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      getStale: vi.fn().mockReturnValue([]),
      recordActivity: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    deliveryTracer: {
      getRecent: vi.fn().mockReturnValue([]),
      getStats: vi.fn().mockReturnValue({ total: 0, attempted: 0, successes: 0, failures: 0, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 }),
      reset: vi.fn(),
      dispose: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock ObservabilityStore factory
// ---------------------------------------------------------------------------

function makeObsStore(overrides?: Record<string, unknown>) {
  return {
    queryDiagnostics: vi.fn().mockReturnValue([]),
    aggregateByProvider: vi.fn().mockReturnValue([]),
    aggregateByAgent: vi.fn().mockReturnValue([]),
    aggregateBySession: vi.fn().mockReturnValue({ sessionKey: "", totalCost: 0, totalTokens: 0, callCount: 0 }),
    aggregateHourly: vi.fn().mockReturnValue([]),
    aggregateToolCostByAgent: vi.fn().mockReturnValue([]),
    queryDelivery: vi.fn().mockReturnValue([]),
    deliveryStats: vi.fn().mockReturnValue({ total: 0, attempted: 0, success: 0, error: 0, timeout: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 }),
    latestChannelSnapshots: vi.fn().mockReturnValue([]),
    resetAll: vi.fn().mockReturnValue({ tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 }),
    resetTable: vi.fn().mockReturnValue(0),
    insertTokenUsage: vi.fn(),
    insertDelivery: vi.fn(),
    insertDiagnostic: vi.fn(),
    insertChannelSnapshot: vi.fn(),
    prune: vi.fn().mockReturnValue({ tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Billing handler admin guards
// ---------------------------------------------------------------------------

describe("createObsHandlers - billing admin guards", () => {
  const billingMethods = [
    "obs.billing.byProvider",
    "obs.billing.byAgent",
    "obs.billing.bySession",
    "obs.billing.total",
    "obs.billing.usage24h",
  ] as const;

  for (const method of billingMethods) {
    describe(method, () => {
      it("rejects when _trustLevel is missing", async () => {
        const deps = makeDeps();
        const handlers = createObsHandlers(deps);

        // Provide required params for methods that need them
        const params: Record<string, unknown> = {};
        if (method === "obs.billing.byAgent") params.agentId = "test-agent";
        if (method === "obs.billing.bySession") params.sessionKey = "test-session";

        await expect(handlers[method]!(params)).rejects.toThrow(
          "Admin trust level required",
        );
      });

      it("rejects when _trustLevel is 'viewer'", async () => {
        const deps = makeDeps();
        const handlers = createObsHandlers(deps);

        const params: Record<string, unknown> = { _trustLevel: "viewer" };
        if (method === "obs.billing.byAgent") params.agentId = "test-agent";
        if (method === "obs.billing.bySession") params.sessionKey = "test-session";

        await expect(handlers[method]!(params)).rejects.toThrow(
          "Admin trust level required",
        );
      });

      it("succeeds when _trustLevel is 'admin'", async () => {
        const deps = makeDeps();
        const handlers = createObsHandlers(deps);

        const params: Record<string, unknown> = { _trustLevel: "admin" };
        if (method === "obs.billing.byAgent") params.agentId = "test-agent";
        if (method === "obs.billing.bySession") params.sessionKey = "test-session";

        // Should not throw
        const result = await handlers[method]!(params);
        expect(result).toBeDefined();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Non-billing handlers: admin trust enforcement
// ---------------------------------------------------------------------------

describe("createObsHandlers - diagnostics is rpc-scoped with no admin gate so an agent can self-diagnose", () => {
  it("obs.diagnostics succeeds without _trustLevel (rpc-scoped; agent self-diagnose)", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);

    const result = await handlers["obs.diagnostics"]!({});
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("counts");
  });

  it("obs.diagnostics succeeds with non-admin _trustLevel", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);

    const result = await handlers["obs.diagnostics"]!({ _trustLevel: "user" });
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("counts");
  });

  it("obs.diagnostics succeeds with admin _trustLevel", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);

    const result = await handlers["obs.diagnostics"]!({ _trustLevel: "admin" });
    expect(result).toHaveProperty("events");
    expect(result).toHaveProperty("counts");
  });
});

describe("createObsHandlers - channels admin guard", () => {
  const channelMethods = [
    { method: "obs.channels.all", params: {} },
    { method: "obs.channels.stale", params: {} },
    { method: "obs.channels.get", params: { channelType: "telegram", channelId: "test-ch" } },
  ] as const;

  for (const { method, params } of channelMethods) {
    it(`${method} rejects without admin _trustLevel`, async () => {
      const deps = makeDeps();
      const handlers = createObsHandlers(deps);

      await expect(handlers[method]!(params as Record<string, unknown>)).rejects.toThrow(
        "Admin access required for channel activity",
      );
    });

    it(`${method} succeeds with admin _trustLevel`, async () => {
      const deps = makeDeps();
      const handlers = createObsHandlers(deps);

      const result = await handlers[method]!({
        ...params,
        _trustLevel: "admin",
      } as Record<string, unknown>);
      expect(result).toBeDefined();
    });
  }
});

describe("createObsHandlers - delivery admin guard", () => {
  const deliveryMethods = [
    { method: "obs.delivery.recent", params: {} },
    { method: "obs.delivery.stats", params: {} },
  ] as const;

  for (const { method, params } of deliveryMethods) {
    it(`${method} rejects without admin _trustLevel`, async () => {
      const deps = makeDeps();
      const handlers = createObsHandlers(deps);

      await expect(handlers[method]!(params as Record<string, unknown>)).rejects.toThrow(
        "Admin access required for delivery data",
      );
    });

    it(`${method} succeeds with admin _trustLevel`, async () => {
      const deps = makeDeps();
      const handlers = createObsHandlers(deps);

      const result = await handlers[method]!({
        ...params,
        _trustLevel: "admin",
      } as Record<string, unknown>);
      expect(result).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// In-memory-only fallback (obsStore undefined)
// ---------------------------------------------------------------------------

describe("createObsHandlers - in-memory fallback when obsStore undefined", () => {
  it("obs.diagnostics returns in-memory data only", async () => {
    const mockEvents = [
      { id: "e1", category: "usage", eventType: "test", timestamp: 100, agentId: "a1", channelId: undefined, sessionKey: undefined, data: {} },
    ];
    const deps = makeDeps({
      diagnosticCollector: {
        getRecent: vi.fn().mockReturnValue(mockEvents),
        getCounts: vi.fn().mockReturnValue({ usage: 1, webhook: 0, message: 0, session: 0 }),
        reset: vi.fn(),
        prune: vi.fn().mockReturnValue(0),
        dispose: vi.fn(),
      },
    });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.diagnostics"]!({ _trustLevel: "admin" }) as { events: unknown[]; counts: unknown };
    expect(result.events).toEqual(mockEvents);
    expect(result.counts).toEqual({ usage: 1, webhook: 0, message: 0, session: 0 });
  });

  it("obs.delivery.stats returns in-memory stats only", async () => {
    const mockStats = { total: 5, attempted: 5, successes: 4, failures: 1, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 500, avgLatencyMs: 100 };
    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue(mockStats),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
    });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.stats"]!({ _trustLevel: "admin" });
    expect(result).toEqual({
      total: 5,
      attempted: 5,
      success: 4,
      error: 1,
      timeout: 0,
      filtered: 0,
      aborted: 0,
      avgLatencyMs: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Dual-source merge tests
// ---------------------------------------------------------------------------

describe("createObsHandlers - dual-source merge", () => {
  it("obs.diagnostics merges SQLite historical + in-memory, sorted by timestamp desc", async () => {
    const startupTs = 1000;

    // In-memory events (current session, post-startup)
    const inMemoryEvents = [
      { id: "mem-1", category: "usage" as const, eventType: "test", timestamp: 2000, agentId: "a1", channelId: undefined, sessionKey: undefined, data: {} },
      { id: "mem-2", category: "message" as const, eventType: "test", timestamp: 1500, agentId: "a2", channelId: undefined, sessionKey: undefined, data: {} },
    ];

    // SQLite historical rows (pre-startup)
    const sqliteRows = [
      { id: 1, timestamp: 500, category: "usage", severity: "info", agentId: "a1", sessionKey: "", message: "old event", details: "", traceId: "" },
      { id: 2, timestamp: 800, category: "message", severity: "warn", agentId: "", sessionKey: "", message: "older event", details: "", traceId: "trace-historical" },
      // This one is post-startup and should be filtered out
      { id: 3, timestamp: 1200, category: "usage", severity: "info", agentId: "a1", sessionKey: "", message: "overlap", details: "", traceId: "" },
    ];

    const obsStore = makeObsStore({
      queryDiagnostics: vi.fn().mockReturnValue(sqliteRows),
    });

    const deps = makeDeps({
      diagnosticCollector: {
        getRecent: vi.fn().mockReturnValue(inMemoryEvents),
        getCounts: vi.fn().mockReturnValue({ usage: 1, webhook: 0, message: 1, session: 0 }),
        reset: vi.fn(),
        prune: vi.fn().mockReturnValue(0),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.diagnostics"]!({ _trustLevel: "admin" }) as {
      events: Array<{ id: string; timestamp: number; traceId?: string }>;
      counts: unknown;
    };

    // Should have in-memory (2) + historical pre-startup (2, filtered out the overlap)
    expect(result.events.length).toBe(4);
    // Sorted by timestamp desc
    expect(result.events[0]!.timestamp).toBe(2000);
    expect(result.events[1]!.timestamp).toBe(1500);
    expect(result.events[2]!.timestamp).toBe(800);
    expect(result.events[3]!.timestamp).toBe(500);
    // Verify historical ones have sqlite- prefix IDs
    expect(result.events[2]!.id).toBe("sqlite-2");
    expect(result.events[2]!.traceId).toBe("trace-historical");
    expect(result.events[3]!.id).toBe("sqlite-1");
  });

  it("obs.diagnostics never returns raw historical messages or details", async () => {
    const obsStore = makeObsStore({
      queryDiagnostics: vi.fn().mockReturnValue([{
        id: 1,
        timestamp: 500,
        category: "message",
        severity: "error",
        agentId: "agent-a",
        sessionKey: "default:user-a:chat-a",
        message: "PRIVATE_HISTORICAL_BODY",
        details: "token=PRIVATE_HISTORICAL_CREDENTIAL",
        traceId: "trace-a",
      }]),
    });
    const handlers = createObsHandlers(makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1_000,
    }));

    const result = await handlers["obs.diagnostics"]!({}) as { events: unknown[] };
    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain("PRIVATE_HISTORICAL_BODY");
    expect(serialized).not.toContain("PRIVATE_HISTORICAL_CREDENTIAL");
    expect(serialized).toContain("error");
  });

  it("obs.billing.byProvider merges SQLite + in-memory by provider", async () => {
    const startupTs = 1000;

    const inMemoryProviders = [
      { provider: "anthropic", totalCost: 0.5, totalTokens: 1000, callCount: 5, models: [{ model: "claude", cost: 0.5, tokens: 1000, calls: 5 }] },
    ];

    const sqliteAggs = [
      { provider: "anthropic", model: "claude", totalCost: 1.0, totalTokens: 2000, callCount: 10 },
      { provider: "openai", model: "gpt-4", totalCost: 0.3, totalTokens: 500, callCount: 3 },
    ];

    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue(sqliteAggs),
    });

    const deps = makeDeps({
      billingEstimator: {
        byProvider: vi.fn().mockReturnValue(inMemoryProviders),
        byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        total: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        usage24h: vi.fn().mockReturnValue([]),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.byProvider"]!({ _trustLevel: "admin" }) as { providers: Array<{ provider: string; totalCost: number; totalTokens: number; callCount: number }> };

    // anthropic: 0.5 + 1.0 = 1.5, openai: 0.3
    expect(result.providers.length).toBe(2);
    const anthropic = result.providers.find((p) => p.provider === "anthropic")!;
    expect(anthropic.totalCost).toBeCloseTo(1.5);
    expect(anthropic.totalTokens).toBe(3000);
    expect(anthropic.callCount).toBe(15);

    const openai = result.providers.find((p) => p.provider === "openai")!;
    expect(openai.totalCost).toBeCloseTo(0.3);
    expect(openai.callCount).toBe(3);
  });

  it("obs.billing.total merges SQLite + in-memory totals", async () => {
    const startupTs = 1000;
    const inMemoryTotal = { totalCost: 0.5, totalTokens: 1000, callCount: 5 };
    const sqliteAggs = [
      { provider: "anthropic", model: "claude", totalCost: 1.0, totalTokens: 2000, callCount: 10 },
    ];

    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue(sqliteAggs),
    });

    const deps = makeDeps({
      billingEstimator: {
        byProvider: vi.fn().mockReturnValue([]),
        byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        total: vi.fn().mockReturnValue(inMemoryTotal),
        usage24h: vi.fn().mockReturnValue([]),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.total"]!({ _trustLevel: "admin" }) as { totalCost: number; totalTokens: number; callCount: number };

    expect(result.totalCost).toBeCloseTo(1.5);
    expect(result.totalTokens).toBe(3000);
    expect(result.callCount).toBe(15);
  });

  it("obs.delivery.recent merges historical SQLite + in-memory, sorted by deliveredAt desc", async () => {
    const startupTs = 1000;

    const inMemoryRecords = [
      {
        sourceChannelId: "ch1", sourceChannelType: "telegram",
        targetChannelId: "ch1", targetChannelType: "telegram",
        deliveredAt: 2000, latencyMs: 100, status: "success",
        error: null, agentId: "a1", sessionKey: "default:u1:ch1",
        traceId: "live-trace", toolCalls: 1, llmCalls: 2,
        tokensTotal: 30, costTotal: 0.01, failureStage: null,
        errorKind: null, steps: [], evidence: "diagnostic",
      },
    ];

    const sqliteRows = [
      { id: 1, timestamp: 500, traceId: "t1", agentId: "a1", channelType: "telegram", channelId: "ch1", sessionKey: "", status: "success", latencyMs: 200, errorMessage: "", messagePreview: "", toolCalls: 2, llmCalls: 3, tokensTotal: 0, costTotal: 0 },
    ];

    const obsStore = makeObsStore({
      queryDelivery: vi.fn().mockReturnValue(sqliteRows),
    });

    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue(inMemoryRecords),
        getStats: vi.fn().mockReturnValue({ total: 1, attempted: 1, successes: 1, failures: 0, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 100, avgLatencyMs: 100 }),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.recent"]!({ _trustLevel: "admin" }) as {
      deliveries: Array<{
        deliveredAt: number;
        traceId?: string;
        toolCalls?: number | null;
        llmCalls?: number | null;
      }>;
    };

    // 1 in-memory + 1 historical (the overlap at ts=1200 is filtered out)
    expect(result.deliveries.length).toBe(2);
    expect(result.deliveries[0]!.deliveredAt).toBe(2000);
    expect(result.deliveries[1]!.deliveredAt).toBe(500);
    expect(result.deliveries[1]!.traceId).toBe("t1");
    expect(result.deliveries[1]!.toolCalls).toBe(2);
    expect(result.deliveries[1]!.llmCalls).toBe(3);
    expect(result.deliveries[1]).toMatchObject({
      status: "success",
      error: null,
      evidence: "diagnostic",
      failureStage: null,
      errorKind: null,
      steps: null,
    });
    expect(obsStore.queryDelivery).toHaveBeenCalledWith(expect.objectContaining({
      channelId: undefined,
      // One extra durable row is fetched so removing the live overlap still
      // leaves enough rows to satisfy the requested page.
      limit: 51,
      sinceMs: undefined,
    }));
  });

  it("obs.delivery.recent preserves repeated durable deliveries with the same trace", async () => {
    const repeatedTraceRows = [
      {
        id: 1,
        timestamp: 1_500,
        traceId: "trace-retry",
        agentId: "agent-a",
        channelType: "telegram",
        channelId: "chat_a",
        sessionKey: "default:user_a:chat_a",
        status: "error",
        latencyMs: 80,
        errorMessage: "first attempt failed",
        messagePreview: "",
        toolCalls: 0,
        llmCalls: 1,
        tokensTotal: 10,
        costTotal: 0.001,
        failureStage: "delivery",
        errorKind: "platform",
      },
      {
        id: 2,
        timestamp: 1_600,
        traceId: "trace-retry",
        agentId: "agent-a",
        channelType: "telegram",
        channelId: "chat_a",
        sessionKey: "default:user_a:chat_a",
        status: "success",
        latencyMs: 90,
        errorMessage: "",
        messagePreview: "",
        toolCalls: 0,
        llmCalls: 1,
        tokensTotal: 10,
        costTotal: 0.001,
        failureStage: null,
        errorKind: null,
      },
    ];
    const obsStore = makeObsStore({
      queryDelivery: vi.fn().mockReturnValue(repeatedTraceRows),
    });
    const deps = makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1_000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.recent"]!({
      _trustLevel: "admin",
      limit: 10,
    }) as { deliveries: Array<{ deliveredAt: number; status: string }> };

    expect(result.deliveries).toEqual([
      expect.objectContaining({ deliveredAt: 1_600, status: "success" }),
      expect.objectContaining({ deliveredAt: 1_500, status: "error" }),
    ]);
  });

  it("obs.delivery.recent preserves an unflushed live retry beside one durable trace row", async () => {
    const makeLiveRecord = (deliveredAt: number, status: "success" | "error") => ({
      sourceChannelId: "chat_a",
      sourceChannelType: "telegram",
      targetChannelId: "chat_a",
      targetChannelType: "telegram",
      deliveredAt,
      latencyMs: 80,
      status,
      error: status === "error" ? "delivery_failed" : null,
      agentId: "agent-a",
      sessionKey: "default:user_a:chat_a",
      traceId: "trace-retry",
      toolCalls: 0,
      llmCalls: 1,
      tokensTotal: 10,
      costTotal: 0.001,
      failureStage: status === "error" ? "delivery" : null,
      errorKind: status === "error" ? "platform" : null,
      steps: null,
      evidence: "diagnostic",
    });
    const deliveryTracer = {
      getRecent: vi.fn().mockReturnValue([
        makeLiveRecord(1_600, "success"),
        makeLiveRecord(1_500, "error"),
      ]),
      getStats: vi.fn().mockReturnValue({
        total: 2,
        attempted: 2,
        successes: 1,
        failures: 1,
        timeouts: 0,
        filtered: 0,
        aborted: 0,
        attemptedLatencyMs: 160,
        avgLatencyMs: 80,
      }),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    const obsStore = makeObsStore({
      queryDelivery: vi.fn().mockReturnValue([{
        id: 1,
        timestamp: 1_500,
        traceId: "trace-retry",
        agentId: "agent-a",
        channelType: "telegram",
        channelId: "chat_a",
        sessionKey: "default:user_a:chat_a",
        status: "error",
        latencyMs: 80,
        errorMessage: "delivery_failed",
        messagePreview: "",
        toolCalls: 0,
        llmCalls: 1,
        tokensTotal: 10,
        costTotal: 0.001,
        failureStage: "delivery",
        errorKind: "platform",
      }]),
    });
    const deps = makeDeps({
      deliveryTracer: deliveryTracer as unknown as ObsHandlerDeps["deliveryTracer"],
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1_000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.recent"]!({
      _trustLevel: "admin",
      limit: 10,
    }) as { deliveries: Array<{ deliveredAt: number; status: string }> };

    expect(result.deliveries).toEqual([
      expect.objectContaining({ deliveredAt: 1_600, status: "success" }),
      expect.objectContaining({ deliveredAt: 1_500, status: "error" }),
    ]);
  });

  it("obs.delivery.recent forwards channel filters to live and persisted queries", async () => {
    const getRecent = vi.fn().mockReturnValue([]);
    const queryDelivery = vi.fn().mockReturnValue([]);
    const obsStore = makeObsStore({ queryDelivery });
    const deps = makeDeps({
      deliveryTracer: {
        getRecent,
        getStats: vi.fn().mockReturnValue({ total: 0, attempted: 0, successes: 0, failures: 0, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 0, avgLatencyMs: 0 }),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1_000,
    });

    const handlers = createObsHandlers(deps);
    await handlers["obs.delivery.recent"]!({
      _trustLevel: "admin",
      channelType: "telegram",
      channelId: "chat_a",
      limit: 10,
    });

    expect(getRecent).toHaveBeenCalledWith(expect.objectContaining({
      channelType: "telegram",
      channelId: "chat_a",
    }));
    expect(queryDelivery).toHaveBeenCalledWith(expect.objectContaining({
      channelType: "telegram",
      channelId: "chat_a",
    }));
  });

  it("obs.delivery.recent returns persisted current-process rows evicted from live memory", async () => {
    const persistedRow = {
      id: 1,
      timestamp: 1_500,
      traceId: "trace-a",
      agentId: "agent-a",
      channelType: "telegram",
      channelId: "chat_a",
      sessionKey: "default:user_a:chat_a",
      status: "success",
      latencyMs: 75,
      errorMessage: "",
      messagePreview: "",
      toolCalls: 1,
      llmCalls: 2,
      tokensTotal: 30,
      costTotal: 0.01,
    };
    const liveRows = [
      {
        sourceChannelId: "chat_b", sourceChannelType: "telegram",
        targetChannelId: "chat_b", targetChannelType: "telegram",
        deliveredAt: 1_700, latencyMs: 100, status: "success",
        error: null, agentId: "agent-b", sessionKey: "default:user_b:chat_b",
        traceId: "trace-b-1", toolCalls: 0, llmCalls: 1,
        tokensTotal: 10, costTotal: 0.001, failureStage: null,
        errorKind: null, steps: [], evidence: "diagnostic",
      },
      {
        sourceChannelId: "chat_b", sourceChannelType: "telegram",
        targetChannelId: "chat_b", targetChannelType: "telegram",
        deliveredAt: 1_600, latencyMs: 90, status: "success",
        error: null, agentId: "agent-b", sessionKey: "default:user_b:chat_b",
        traceId: "trace-b-2", toolCalls: 0, llmCalls: 1,
        tokensTotal: 10, costTotal: 0.001, failureStage: null,
        errorKind: null, steps: [], evidence: "diagnostic",
      },
    ];
    const getRecent = vi.fn().mockImplementation((opts: { channelType?: string; channelId?: string }) =>
      liveRows.filter((row) =>
        (opts.channelType === undefined || row.sourceChannelType === opts.channelType)
        && (opts.channelId === undefined || row.sourceChannelId === opts.channelId),
      ),
    );
    const queryDelivery = vi.fn().mockImplementation((params: { beforeMs?: number; channelType?: string; channelId?: string }) => {
      if (params.beforeMs !== undefined) return [];
      if (params.channelType !== persistedRow.channelType || params.channelId !== persistedRow.channelId) return [];
      return [persistedRow];
    });
    const obsStore = makeObsStore({ queryDelivery });
    const deps = makeDeps({
      deliveryTracer: {
        getRecent,
        getStats: vi.fn().mockReturnValue({ total: 2, attempted: 2, successes: 2, failures: 0, timeouts: 0, filtered: 0, aborted: 0, attemptedLatencyMs: 190, avgLatencyMs: 95 }),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1_000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.recent"]!({
      _trustLevel: "admin",
      channelType: "telegram",
      channelId: "chat_a",
      limit: 10,
    }) as { deliveries: Array<{ traceId: string | null }> };

    expect(result.deliveries.map((delivery) => delivery.traceId)).toEqual(["trace-a"]);
  });

  it("obs.delivery.stats merges only pre-startup SQLite rows with current-process stats", async () => {
    const startupTs = 1000;
    const inMemoryStats = { total: 5, attempted: 3, successes: 1, failures: 1, timeouts: 1, filtered: 1, aborted: 1, attemptedLatencyMs: 351, avgLatencyMs: 117 };
    const sqliteStats = { total: 10, attempted: 8, success: 6, error: 1, timeout: 1, filtered: 1, aborted: 1, attemptedLatencyMs: 1600, avgLatencyMs: 200 };

    const obsStore = makeObsStore({
      deliveryStats: vi.fn().mockReturnValue(sqliteStats),
    });

    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue(inMemoryStats),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.stats"]!({ _trustLevel: "admin" }) as {
      total: number;
      attempted: number;
      success: number;
      error: number;
      timeout: number;
      filtered: number;
      aborted: number;
      avgLatencyMs: number;
    };

    expect(result.total).toBe(15);
    expect(result.attempted).toBe(11);
    expect(result.success).toBe(7);
    expect(result.error).toBe(2);
    expect(result.timeout).toBe(2);
    expect(result.filtered).toBe(2);
    expect(result.aborted).toBe(2);
    expect(result.avgLatencyMs).toBe(177);
    expect(obsStore.deliveryStats).toHaveBeenCalledWith({ beforeMs: startupTs });
  });

  it("obs.delivery.stats merges exact duration totals instead of rounded means", async () => {
    const obsStore = makeObsStore({
      deliveryStats: vi.fn().mockReturnValue({
        total: 1,
        attempted: 1,
        success: 1,
        error: 0,
        timeout: 0,
        filtered: 0,
        aborted: 0,
        attemptedLatencyMs: 1,
        avgLatencyMs: 1,
      }),
    });
    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({
          total: 2,
          attempted: 2,
          successes: 2,
          failures: 0,
          timeouts: 0,
          filtered: 0,
          aborted: 0,
          attemptedLatencyMs: 3,
          avgLatencyMs: 2,
        }),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.stats"]!({
      _trustLevel: "admin",
    }) as { avgLatencyMs: number };

    expect(result.avgLatencyMs).toBe(1);
  });

  it("obs.delivery.stats flushes live rows before querying the requested durable window", async () => {
    const callOrder: string[] = [];
    const flushPending = vi.fn((table: "delivery") => {
      callOrder.push(`flush:${table}`);
      return ok({ tables: [table], flushed: 2, pending: 0, dropped: 0 });
    });
    const deliveryStats = vi.fn().mockImplementation(() => {
      callOrder.push("query:delivery");
      return {
        total: 2,
        attempted: 1,
        success: 1,
        error: 0,
        timeout: 0,
        filtered: 1,
        aborted: 0,
        attemptedLatencyMs: 75,
        avgLatencyMs: 75,
      };
    });
    const obsStore = makeObsStore({ deliveryStats });
    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({
          total: 99,
          attempted: 99,
          successes: 99,
          failures: 0,
          timeouts: 0,
          filtered: 0,
          aborted: 0,
          attemptedLatencyMs: 9_900,
          avgLatencyMs: 100,
        }),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      obsPersistence: {
        discardPending: vi.fn(),
        flushPending,
      } as unknown as ObsHandlerDeps["obsPersistence"],
      startupTimestamp: 1_000,
    });
    const beforeRequest = Date.now();

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.stats"]!({
      _trustLevel: "admin",
      sinceMs: 60_000,
    }) as { total: number; attempted: number; success: number; filtered: number };

    expect(callOrder).toEqual(["flush:delivery", "query:delivery"]);
    expect(deliveryStats).toHaveBeenCalledWith({
      sinceMs: expect.any(Number),
    });
    const queryCutoff = (deliveryStats.mock.calls[0]?.[0] as { sinceMs: number }).sinceMs;
    expect(queryCutoff).toBeGreaterThanOrEqual(beforeRequest - 60_000);
    expect(queryCutoff).toBeLessThanOrEqual(Date.now() - 60_000);
    expect(result).toMatchObject({ total: 2, attempted: 1, success: 1, filtered: 1 });
  });

  it("obs.delivery.stats falls back to live plus pre-startup rows when flushing fails", async () => {
    const deliveryStats = vi.fn().mockReturnValue({
      total: 1,
      attempted: 1,
      success: 1,
      error: 0,
      timeout: 0,
      filtered: 0,
      aborted: 0,
      attemptedLatencyMs: 40,
      avgLatencyMs: 40,
    });
    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue([]),
        getStats: vi.fn().mockReturnValue({
          total: 2,
          attempted: 1,
          successes: 0,
          failures: 1,
          timeouts: 0,
          filtered: 1,
          aborted: 0,
          attemptedLatencyMs: 60,
          avgLatencyMs: 60,
        }),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: makeObsStore({ deliveryStats }) as unknown as ObsHandlerDeps["obsStore"],
      obsPersistence: {
        discardPending: vi.fn(),
        flushPending: vi.fn().mockReturnValue(err({
          kind: "persistence_unavailable",
          tables: ["delivery"],
          pending: 2,
          dropped: 1,
        })),
      } as unknown as ObsHandlerDeps["obsPersistence"],
      startupTimestamp: 1_000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.delivery.stats"]!({
      _trustLevel: "admin",
    });

    expect(result).toEqual({
      total: 3,
      attempted: 2,
      success: 1,
      error: 1,
      timeout: 0,
      filtered: 1,
      aborted: 0,
      avgLatencyMs: 50,
    });
    expect(deliveryStats).toHaveBeenCalledWith({ beforeMs: 1_000 });
  });

  it("obs.delivery.stats adds terminal-only live outcomes to canonical durable rows", async () => {
    const deps = makeDeps({
      deliveryTracer: {
        getRecent: vi.fn().mockReturnValue([{
          sourceChannelId: "blocked-chat",
          sourceChannelType: "telegram",
          targetChannelId: "blocked-chat",
          targetChannelType: "telegram",
          deliveredAt: 2_000,
          latencyMs: 0,
          status: "filtered",
          error: null,
          agentId: null,
          sessionKey: null,
          traceId: null,
          toolCalls: null,
          llmCalls: null,
          tokensTotal: null,
          costTotal: null,
          failureStage: null,
          errorKind: null,
          steps: null,
          evidence: "message_correlation",
        }]),
        getStats: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: makeObsStore({
        deliveryStats: vi.fn().mockReturnValue({
          total: 1,
          attempted: 1,
          success: 1,
          error: 0,
          timeout: 0,
          filtered: 0,
          aborted: 0,
          attemptedLatencyMs: 80,
          avgLatencyMs: 80,
        }),
      }) as unknown as ObsHandlerDeps["obsStore"],
      obsPersistence: {
        discardPending: vi.fn(),
        flushPending: vi.fn().mockReturnValue(ok({
          tables: ["delivery"],
          flushed: 1,
          pending: 0,
          dropped: 0,
        })),
      } as unknown as ObsHandlerDeps["obsPersistence"],
      startupTimestamp: 1_000,
    });

    const result = await createObsHandlers(deps)["obs.delivery.stats"]!({
      _trustLevel: "admin",
    });

    expect(result).toEqual({
      total: 2,
      attempted: 1,
      success: 1,
      error: 0,
      timeout: 0,
      filtered: 1,
      aborted: 0,
      avgLatencyMs: 80,
    });
  });

  it("obs.channels.all merges SQLite snapshots for inactive channels", async () => {
    const startupTs = 1000;

    const inMemoryChannels = [
      { channelId: "ch-active", channelType: "telegram", lastActiveAt: 2000, messagesSent: 3, messagesReceived: 5 },
    ];

    const sqliteSnapshots = [
      { id: 1, timestamp: 500, channelType: "discord", channelId: "ch-old", status: "active", messagesSent: 10, messagesReceived: 20, uptimeMs: 1000 },
      // This one matches an in-memory channel and should be excluded
      { id: 2, timestamp: 800, channelType: "telegram", channelId: "ch-active", status: "active", messagesSent: 2, messagesReceived: 3, uptimeMs: 500 },
    ];

    const obsStore = makeObsStore({
      latestChannelSnapshots: vi.fn().mockReturnValue(sqliteSnapshots),
    });

    const deps = makeDeps({
      channelActivityTracker: {
        getAll: vi.fn().mockReturnValue(inMemoryChannels),
        get: vi.fn().mockReturnValue(null),
        getStale: vi.fn().mockReturnValue([]),
        recordActivity: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.channels.all"]!({ _trustLevel: "admin" }) as { channels: Array<{ channelId: string; channelType: string }> };

    // ch-active from in-memory + ch-old from historical
    expect(result.channels.length).toBe(2);
    expect(result.channels.map((c) => c.channelId).sort()).toEqual(["ch-active", "ch-old"]);
  });

  it("obs.channels.all preserves same channel ids from different channel types", async () => {
    const inMemoryChannels = [
      { channelId: "shared", channelType: "telegram", lastActiveAt: 2000, messagesSent: 3, messagesReceived: 5 },
    ];
    const sqliteSnapshots = [
      { id: 1, timestamp: 500, channelType: "slack", channelId: "shared", status: "active", messagesSent: 10, messagesReceived: 20, uptimeMs: 1000 },
    ];
    const obsStore = makeObsStore({
      latestChannelSnapshots: vi.fn().mockReturnValue(sqliteSnapshots),
    });
    const deps = makeDeps({
      channelActivityTracker: {
        getAll: vi.fn().mockReturnValue(inMemoryChannels),
        get: vi.fn().mockReturnValue(null),
        getStale: vi.fn().mockReturnValue([]),
        recordActivity: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.channels.all"]!({
      _trustLevel: "admin",
    }) as { channels: Array<{ channelId: string; channelType: string }> };

    expect(result.channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelType: "telegram", channelId: "shared" }),
      expect.objectContaining({ channelType: "slack", channelId: "shared" }),
    ]));
    expect(result.channels).toHaveLength(2);
  });

  it("obs.channels.get resolves activity by channel type and channel id", async () => {
    const get = vi.fn().mockReturnValue({
      channelId: "shared",
      channelType: "telegram",
      lastActiveAt: 2000,
      messagesSent: 3,
      messagesReceived: 5,
    });
    const deps = makeDeps({
      channelActivityTracker: {
        getAll: vi.fn().mockReturnValue([]),
        get,
        getStale: vi.fn().mockReturnValue([]),
        recordActivity: vi.fn(),
        reset: vi.fn(),
        dispose: vi.fn(),
      },
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.channels.get"]!({
      _trustLevel: "admin",
      channelType: "telegram",
      channelId: "shared",
    }) as { channel: { channelType: string; channelId: string } | null };

    expect(get).toHaveBeenCalledWith("telegram", "shared");
    expect(result.channel).toMatchObject({ channelType: "telegram", channelId: "shared" });
  });

  // -------------------------------------------------------------------------
  // The per-tool projection. The tool_tag was
  // persisted + aggregateToolCostByAgent existed, but the obs.billing.byAgent
  // handler never projected it — so the billing per-tool table was permanently
  // empty in prod, hidden by a fabricating view-test mock. These assert the REAL
  // handler emits a non-empty tools[] (the test that would have caught the gap).
  // -------------------------------------------------------------------------
  it("obs.billing.byAgent projects the per-tool even-split as tools[]", async () => {
    const toolRows = [
      { tool: "bash", cost: 0.18, tokens: 50_000, calls: 1.5 },
      { tool: "read", cost: 0.105, tokens: 30_000, calls: 1 },
    ];

    const obsStore = makeObsStore({
      aggregateToolCostByAgent: vi.fn().mockReturnValue(toolRows),
    });

    const deps = makeDeps({
      billingEstimator: {
        byProvider: vi.fn().mockReturnValue([]),
        byAgent: vi.fn().mockReturnValue({ totalCost: 0.285, totalTokens: 80_000, callCount: 3 }),
        bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        total: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        usage24h: vi.fn().mockReturnValue([]),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.byAgent"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
    }) as { tools?: Array<{ tool: string; cost: number; tokens: number; calls: number }> };

    // The projection is present + non-empty (this key did
    // not exist on the handler output before the wiring).
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(2);
    const bash = result.tools!.find((t) => t.tool === "bash")!;
    expect(bash.cost).toBeCloseTo(0.18, 10);
    expect(bash.tokens).toBe(50_000);
    // The store query was asked for THIS agent (sinceMs omitted → full window).
    expect(obsStore.aggregateToolCostByAgent).toHaveBeenCalledWith("agent-a", undefined);
  });

  it("obs.billing.byAgent omits tools[] when the store surfaces none (honest empty, not a fabricated stub)", async () => {
    // Default makeObsStore returns [] from aggregateToolCostByAgent.
    const deps = makeDeps({
      obsStore: makeObsStore() as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.byAgent"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
    }) as { tools?: unknown[] };

    // No tool rows → no tools key (the narrower treats absent === empty; we do
    // NOT emit a fabricated empty-but-present array that dresses up as data).
    expect(result.tools).toBeUndefined();
  });

  it("obs.billing.byAgent content-free: tools[] carries only tool names + numbers", async () => {
    const obsStore = makeObsStore({
      aggregateToolCostByAgent: vi.fn().mockReturnValue([
        { tool: "bash", cost: 0.1, tokens: 100, calls: 1 },
      ]),
    });
    const deps = makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.byAgent"]!({
      _trustLevel: "admin",
      agentId: "agent-a",
    }) as { tools?: Array<Record<string, unknown>> };

    const keys = Object.keys(result.tools![0]!).sort();
    // ONLY the content-free fields — no message/body/args key can ride along.
    expect(keys).toEqual(["calls", "cost", "tokens", "tool"]);
  });
});

// ---------------------------------------------------------------------------
// obs.reset handler tests
// ---------------------------------------------------------------------------

describe("createObsHandlers - obs.reset", () => {
  it("rejects without admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    await expect(handlers["obs.reset"]!({})).rejects.toThrow("Admin access required");
  });

  it("resets all in-memory collectors and SQLite store", async () => {
    const obsStore = makeObsStore({
      resetAll: vi.fn().mockReturnValue({ tokenUsage: 5, delivery: 3, diagnostics: 2, channels: 1 }),
    });
    const costTracker = { reset: vi.fn().mockReturnValue(10) };
    const eventBus = { emit: vi.fn() };

    const deps = makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      sharedCostTracker: costTracker,
      eventBus,
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.reset"]!({ _trustLevel: "admin" }) as { reset: boolean; rowsDeleted: Record<string, number> };

    // Verify in-memory collectors were reset
    expect(deps.diagnosticCollector.reset).toHaveBeenCalled();
    expect(deps.channelActivityTracker.reset).toHaveBeenCalled();
    expect(deps.deliveryTracer.reset).toHaveBeenCalled();
    expect(costTracker.reset).toHaveBeenCalled();

    // Verify SQLite was reset
    expect(obsStore.resetAll).toHaveBeenCalled();

    // Verify event was emitted
    expect(eventBus.emit).toHaveBeenCalledWith("observability:reset", expect.objectContaining({
      admin: "rpc",
      table: "all",
      rowsDeleted: { tokenUsage: 5, delivery: 3, diagnostics: 2, channels: 1 },
    }));

    // Verify return value
    expect(result.reset).toBe(true);
    expect(result.rowsDeleted).toEqual({ tokenUsage: 5, delivery: 3, diagnostics: 2, channels: 1 });
  });

  it("resets in-memory only when obsStore is undefined", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.reset"]!({ _trustLevel: "admin" }) as { reset: boolean; rowsDeleted: Record<string, number> };

    expect(deps.diagnosticCollector.reset).toHaveBeenCalled();
    expect(deps.channelActivityTracker.reset).toHaveBeenCalled();
    expect(deps.deliveryTracer.reset).toHaveBeenCalled();
    expect(result.reset).toBe(true);
    expect(result.rowsDeleted).toEqual({ tokenUsage: 0, delivery: 0, diagnostics: 0, channels: 0 });
  });
});

// ---------------------------------------------------------------------------
// obs.reset.table handler tests
// ---------------------------------------------------------------------------

describe("createObsHandlers - obs.reset.table", () => {
  it("rejects without admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    await expect(handlers["obs.reset.table"]!({ table: "diagnostics" })).rejects.toThrow("Admin access required");
  });

  it("rejects invalid table name", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    await expect(
      handlers["obs.reset.table"]!({ _trustLevel: "admin", table: "invalid_table" }),
    ).rejects.toThrow("Invalid table: invalid_table");
  });

  const validTables = [
    { table: "token_usage", inMemoryKey: "sharedCostTracker" },
    { table: "diagnostics", inMemoryKey: "diagnosticCollector" },
    { table: "channels", inMemoryKey: "channelActivityTracker" },
    { table: "delivery", inMemoryKey: "deliveryTracer" },
  ] as const;

  for (const { table, inMemoryKey } of validTables) {
    it(`resets ${table} in both in-memory and SQLite`, async () => {
      const obsStore = makeObsStore({
        resetTable: vi.fn().mockReturnValue(42),
      });
      const costTracker = { reset: vi.fn().mockReturnValue(10) };
      const eventBus = { emit: vi.fn() };

      const deps = makeDeps({
        obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
        sharedCostTracker: costTracker,
        eventBus,
        startupTimestamp: 1000,
      });

      const handlers = createObsHandlers(deps);
      const result = await handlers["obs.reset.table"]!({
        _trustLevel: "admin",
        table,
      }) as { reset: boolean; table: string; rowsDeleted: number };

      // Verify correct in-memory collector was reset
      if (inMemoryKey === "sharedCostTracker") {
        expect(costTracker.reset).toHaveBeenCalled();
      } else {
        expect((deps[inMemoryKey] as { reset: ReturnType<typeof vi.fn> }).reset).toHaveBeenCalled();
      }

      // Verify SQLite table was reset
      expect(obsStore.resetTable).toHaveBeenCalledWith(table);

      // Verify event emission
      expect(eventBus.emit).toHaveBeenCalledWith("observability:reset", expect.objectContaining({
        admin: "rpc",
        table,
      }));

      // Verify return
      expect(result.reset).toBe(true);
      expect(result.table).toBe(table);
      expect(result.rowsDeleted).toBe(42);
    });
  }

  it("resets in-memory only when obsStore is undefined", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.reset.table"]!({
      _trustLevel: "admin",
      table: "diagnostics",
    }) as { reset: boolean; table: string; rowsDeleted: number };

    expect(deps.diagnosticCollector.reset).toHaveBeenCalled();
    expect(result.reset).toBe(true);
    expect(result.rowsDeleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// obs.context.pipeline and obs.context.dag handler tests
// ---------------------------------------------------------------------------

describe("createObsHandlers - obs.context.pipeline", () => {
  it("returns empty array when contextPipelineCollector is undefined", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.context.pipeline"]!({});
    expect(result).toEqual([]);
  });

  it("delegates to contextPipelineCollector.getRecentPipelines", async () => {
    const mockPipelines = [
      { agentId: "a1", sessionKey: "s1", tokensLoaded: 1000, timestamp: 100 },
    ];
    const collector = {
      getRecentPipelines: vi.fn().mockReturnValue(mockPipelines),
      getRecentDagCompactions: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    const deps = makeDeps({ contextPipelineCollector: collector });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.context.pipeline"]!({ agentId: "a1", limit: 10 });

    expect(collector.getRecentPipelines).toHaveBeenCalledWith({ agentId: "a1", limit: 10 });
    expect(result).toEqual(mockPipelines);
  });
});

describe("createObsHandlers - obs.context.dag", () => {
  it("returns empty array when contextPipelineCollector is undefined", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.context.dag"]!({});
    expect(result).toEqual([]);
  });

  it("delegates to contextPipelineCollector.getRecentDagCompactions", async () => {
    const mockDag = [
      { agentId: "a1", sessionKey: "s1", leafSummariesCreated: 3, timestamp: 200 },
    ];
    const collector = {
      getRecentPipelines: vi.fn().mockReturnValue([]),
      getRecentDagCompactions: vi.fn().mockReturnValue(mockDag),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    const deps = makeDeps({ contextPipelineCollector: collector });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.context.dag"]!({ agentId: "a1" });

    expect(collector.getRecentDagCompactions).toHaveBeenCalledWith({ agentId: "a1", limit: undefined });
    expect(result).toEqual(mockDag);
  });
});

// ---------------------------------------------------------------------------
// agent.cacheStats handler tests
// ---------------------------------------------------------------------------

describe("createObsHandlers - agent.cacheStats", () => {
  it("rejects without admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    await expect(handlers["agent.cacheStats"]!({})).rejects.toThrow("Admin trust level required");
  });

  it("returns empty providers when obsStore is undefined", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    const result = await handlers["agent.cacheStats"]!({ _trustLevel: "admin" }) as { providers: unknown[]; totalCacheSaved: number };

    expect(result.providers).toEqual([]);
    expect(result.totalCacheSaved).toBe(0);
  });

  it("returns per-provider cache metrics from obsStore", async () => {
    const sqliteAggs = [
      { provider: "anthropic", model: "claude-sonnet-4-20250514", totalCost: 0.50, totalTokens: 5000, callCount: 10, totalCacheSaved: 0.15 },
      { provider: "anthropic", model: "claude-haiku-3.5", totalCost: 0.10, totalTokens: 2000, callCount: 5, totalCacheSaved: 0.02 },
      { provider: "openai", model: "gpt-4o", totalCost: 0.30, totalTokens: 3000, callCount: 8, totalCacheSaved: 0 },
    ];

    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue(sqliteAggs),
    });

    const deps = makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["agent.cacheStats"]!({ _trustLevel: "admin" }) as {
      providers: Array<{ provider: string; model: string; callCount: number; totalCost: number; totalCacheSaved: number; cacheHitRate: number }>;
      totalCacheSaved: number;
    };

    expect(result.providers.length).toBe(3);
    expect(result.totalCacheSaved).toBeCloseTo(0.17);

    // Verify cache hit rate computation for anthropic/claude-sonnet
    const sonnet = result.providers.find((p) => p.model === "claude-sonnet-4-20250514")!;
    expect(sonnet.cacheHitRate).toBeCloseTo(0.15 / (0.50 + 0.15));
    expect(sonnet.totalCacheSaved).toBeCloseTo(0.15);

    // Verify zero cache saved yields zero hit rate
    const gpt4o = result.providers.find((p) => p.model === "gpt-4o")!;
    expect(gpt4o.cacheHitRate).toBe(0);
    expect(gpt4o.totalCacheSaved).toBe(0);
  });

  it("passes sinceMs as sinceTimestamp to obsStore.aggregateByProvider", async () => {
    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue([]),
    });

    const deps = makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const now = Date.now();
    await handlers["agent.cacheStats"]!({ _trustLevel: "admin", sinceMs: 3600000 });

    const callArg = (obsStore.aggregateByProvider as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    // sinceTimestamp should be approximately now - 3600000
    expect(callArg).toBeGreaterThan(now - 3600000 - 100);
    expect(callArg).toBeLessThanOrEqual(now - 3600000 + 100);
  });

  it("handles zero totalCost + zero totalCacheSaved without division by zero", async () => {
    const sqliteAggs = [
      { provider: "test", model: "test-model", totalCost: 0, totalTokens: 0, callCount: 1, totalCacheSaved: 0 },
    ];

    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue(sqliteAggs),
    });

    const deps = makeDeps({
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: 1000,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["agent.cacheStats"]!({ _trustLevel: "admin" }) as {
      providers: Array<{ cacheHitRate: number }>;
    };

    expect(result.providers[0]!.cacheHitRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// obs.billing.total now includes totalCacheSaved
// ---------------------------------------------------------------------------

describe("createObsHandlers - obs.billing.total includes totalCacheSaved", () => {
  it("returns totalCacheSaved in merged response", async () => {
    const startupTs = 1000;
    const inMemoryTotal = { totalCost: 0.5, totalTokens: 1000, callCount: 5, totalCacheSaved: 0.05 };
    const sqliteAggs = [
      { provider: "anthropic", model: "claude", totalCost: 1.0, totalTokens: 2000, callCount: 10, totalCacheSaved: 0.20 },
      { provider: "openai", model: "gpt-4", totalCost: 0.3, totalTokens: 500, callCount: 3, totalCacheSaved: 0.03 },
    ];

    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue(sqliteAggs),
    });

    const deps = makeDeps({
      billingEstimator: {
        byProvider: vi.fn().mockReturnValue([]),
        byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        total: vi.fn().mockReturnValue(inMemoryTotal),
        usage24h: vi.fn().mockReturnValue([]),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.total"]!({ _trustLevel: "admin" }) as {
      totalCost: number; totalTokens: number; callCount: number; totalCacheSaved: number;
    };

    expect(result.totalCost).toBeCloseTo(1.8);
    expect(result.totalTokens).toBe(3500);
    expect(result.callCount).toBe(18);
    expect(result.totalCacheSaved).toBeCloseTo(0.28); // 0.05 + 0.20 + 0.03
  });

  it("handles undefined in-memory totalCacheSaved gracefully", async () => {
    const startupTs = 1000;
    // In-memory total without totalCacheSaved (pre-existing behavior)
    const inMemoryTotal = { totalCost: 0.5, totalTokens: 1000, callCount: 5 };
    const sqliteAggs = [
      { provider: "anthropic", model: "claude", totalCost: 1.0, totalTokens: 2000, callCount: 10, totalCacheSaved: 0.10 },
    ];

    const obsStore = makeObsStore({
      aggregateByProvider: vi.fn().mockReturnValue(sqliteAggs),
    });

    const deps = makeDeps({
      billingEstimator: {
        byProvider: vi.fn().mockReturnValue([]),
        byAgent: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        bySession: vi.fn().mockReturnValue({ totalCost: 0, totalTokens: 0, callCount: 0 }),
        total: vi.fn().mockReturnValue(inMemoryTotal),
        usage24h: vi.fn().mockReturnValue([]),
      },
      obsStore: obsStore as unknown as ObsHandlerDeps["obsStore"],
      startupTimestamp: startupTs,
    });

    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.billing.total"]!({ _trustLevel: "admin" }) as {
      totalCacheSaved: number;
    };

    // 0 (undefined ?? 0) + 0.10 = 0.10
    expect(result.totalCacheSaved).toBeCloseTo(0.10);
  });
});

// ---------------------------------------------------------------------------
// obs.getCacheStats handler tests
// ---------------------------------------------------------------------------

describe("createObsHandlers - obs.getCacheStats", () => {
  it("rejects without admin trust level", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    await expect(handlers["obs.getCacheStats"]!({})).rejects.toThrow("Admin trust level required");
  });

  it("returns zeroes when tokenTracker is undefined", async () => {
    const deps = makeDeps();
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.getCacheStats"]!({ _trustLevel: "admin" }) as { cacheHitRate: number; cacheEffectiveness: number };

    expect(result.cacheHitRate).toBe(0);
    expect(result.cacheEffectiveness).toBe(0);
  });

  it("returns cacheHitRate and cacheEffectiveness from tokenTracker", async () => {
    const mockTracker = {
      getCacheHitRate: vi.fn().mockReturnValue(0.4),
      getCacheEffectiveness: vi.fn().mockReturnValue(0.75),
    };
    const deps = makeDeps({
      tokenTracker: mockTracker as unknown as ObsHandlerDeps["tokenTracker"],
    });
    const handlers = createObsHandlers(deps);
    const result = await handlers["obs.getCacheStats"]!({ _trustLevel: "admin" }) as { cacheHitRate: number; cacheEffectiveness: number };

    expect(result.cacheHitRate).toBeCloseTo(0.4, 5);
    expect(result.cacheEffectiveness).toBeCloseTo(0.75, 5);
    expect(mockTracker.getCacheHitRate).toHaveBeenCalled();
    expect(mockTracker.getCacheEffectiveness).toHaveBeenCalled();
  });
});

describe("createObsHandlers - obs.reset clears contextPipelineCollector", () => {
  it("calls contextPipelineCollector.reset() during obs.reset", async () => {
    const collector = {
      getRecentPipelines: vi.fn().mockReturnValue([]),
      getRecentDagCompactions: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
    const deps = makeDeps({ contextPipelineCollector: collector });
    const handlers = createObsHandlers(deps);
    await handlers["obs.reset"]!({ _trustLevel: "admin" });

    expect(collector.reset).toHaveBeenCalled();
  });
});
