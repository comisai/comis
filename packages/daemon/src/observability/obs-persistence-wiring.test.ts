// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  tokenUsageEventToRow,
  deliveryEventToRow,
  diagnosticEventToRow,
  setupObsPersistence,
} from "./obs-persistence-wiring.js";
import type { EventMap } from "@comis/core";
import type { DiagnosticEvent } from "./diagnostic-collector.js";

// ---------------------------------------------------------------------------
// tokenUsageEventToRow
// ---------------------------------------------------------------------------

describe("tokenUsageEventToRow", () => {
  it("flattens nested tokens and cost to top-level fields", () => {
    const payload: EventMap["observability:token_usage"] = {
      timestamp: 1000,
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "chan-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0.002, total: 0.015 },
      latencyMs: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      sessionKey: "tenant:user:agent",
      savedVsUncached: 0.003,
      cacheEligible: true,
    };

    const row = tokenUsageEventToRow(payload);

    expect(row.timestamp).toBe(1000);
    expect(row.traceId).toBe("trace-1");
    expect(row.agentId).toBe("agent-1");
    expect(row.channelId).toBe("chan-1");
    expect(row.executionId).toBe("exec-1");
    expect(row.sessionKey).toBe("tenant:user:agent");
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-sonnet-4-5-20250929");
    expect(row.promptTokens).toBe(100);
    expect(row.completionTokens).toBe(50);
    expect(row.totalTokens).toBe(150);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.cacheWriteTokens).toBe(5);
    expect(row.costInput).toBe(0.01);
    expect(row.costOutput).toBe(0.005);
    expect(row.costCacheRead).toBe(0.001);
    expect(row.costCacheWrite).toBe(0.002);
    expect(row.cacheSaved).toBe(0.003);
    expect(row.costTotal).toBe(0.015);
    expect(row.latencyMs).toBe(200);
  });

  it("maps sessionKey from event payload", () => {
    const payload: EventMap["observability:token_usage"] = {
      timestamp: 0,
      traceId: "",
      agentId: "",
      channelId: "",
      executionId: "",
      provider: "",
      model: "",
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "sk-test",
      savedVsUncached: 0,
      cacheEligible: false,
    };

    expect(tokenUsageEventToRow(payload).sessionKey).toBe("sk-test");
  });
});

// ---------------------------------------------------------------------------
// deliveryEventToRow
// ---------------------------------------------------------------------------

describe("deliveryEventToRow", () => {
  it("maps success=true to status 'success' with no errorMessage", () => {
    const payload: EventMap["diagnostic:message_processed"] = {
      messageId: "msg-1",
      channelId: "chan-1",
      channelType: "telegram",
      agentId: "agent-1",
      sessionKey: "sk-1",
      receivedAt: 900,
      executionDurationMs: 80,
      deliveryDurationMs: 20,
      totalDurationMs: 100,
      tokensUsed: 300,
      cost: 0.02,
      success: true,
      finishReason: "end_turn",
      timestamp: 1000,
    };

    const row = deliveryEventToRow(payload);

    expect(row.status).toBe("success");
    expect(row.errorMessage).toBeUndefined();
    expect(row.latencyMs).toBe(100);
    expect(row.tokensTotal).toBe(300);
    expect(row.costTotal).toBe(0.02);
    expect(row.traceId).toBe("");
    expect(row.channelType).toBe("telegram");
    expect(row.sessionKey).toBe("sk-1");
  });

  it("maps success=false to status 'error' with finishReason as errorMessage", () => {
    const payload: EventMap["diagnostic:message_processed"] = {
      messageId: "msg-2",
      channelId: "chan-2",
      channelType: "discord",
      agentId: "agent-2",
      sessionKey: "sk-2",
      receivedAt: 800,
      executionDurationMs: 150,
      deliveryDurationMs: 50,
      totalDurationMs: 200,
      tokensUsed: 0,
      cost: 0,
      success: false,
      finishReason: "rate_limited",
      timestamp: 1000,
    };

    const row = deliveryEventToRow(payload);

    expect(row.status).toBe("error");
    expect(row.errorMessage).toBe("rate_limited");
    expect(row.latencyMs).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// diagnosticEventToRow
// ---------------------------------------------------------------------------

describe("diagnosticEventToRow", () => {
  it("maps DiagnosticEvent fields to DiagnosticRow with JSON.stringify for details", () => {
    const event: DiagnosticEvent = {
      id: "diag-1",
      category: "message",
      eventType: "diagnostic:message_processed",
      timestamp: 1000,
      agentId: "agent-1",
      channelId: "chan-1",
      sessionKey: "sk-1",
      data: { foo: "bar", count: 42 },
    };

    const row = diagnosticEventToRow(event);

    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("message");
    expect(row.severity).toBe("info");
    expect(row.agentId).toBe("agent-1");
    expect(row.sessionKey).toBe("sk-1");
    expect(row.message).toBe("diagnostic:message_processed");
    expect(row.details).toBe(JSON.stringify({ foo: "bar", count: 42 }));
    expect(row.traceId).toBeUndefined();
  });

  it("handles undefined agentId and sessionKey", () => {
    const event: DiagnosticEvent = {
      id: "diag-2",
      category: "usage",
      eventType: "observability:token_usage",
      timestamp: 2000,
      agentId: undefined,
      channelId: undefined,
      sessionKey: undefined,
      data: {},
    };

    const row = diagnosticEventToRow(event);

    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.details).toBe("{}");
  });
});

// ---------------------------------------------------------------------------
// setupObsPersistence
// ---------------------------------------------------------------------------

describe("setupObsPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Minimal mock event bus that tracks .on() calls. */
  function createMockEventBus() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      }),
      off: vi.fn(),
      emit: vi.fn((event: string, payload: unknown) => {
        const handlers = listeners.get(event) ?? [];
        for (const handler of handlers) {
          handler(payload);
        }
      }),
      once: vi.fn(),
    };
  }

  function createMockObsStore() {
    return {
      insertTokenUsage: vi.fn(),
      insertDelivery: vi.fn(),
      insertDiagnostic: vi.fn(),
      insertChannelSnapshot: vi.fn(),
      queryTokenUsage: vi.fn(),
      queryDelivery: vi.fn(),
      queryDiagnostics: vi.fn(),
      latestChannelSnapshots: vi.fn(),
      aggregateByProvider: vi.fn(),
      aggregateByAgent: vi.fn(),
      aggregateBySession: vi.fn(),
      aggregateHourly: vi.fn(),
      deliveryStats: vi.fn(),
      prune: vi.fn(),
      resetAll: vi.fn(),
      resetTable: vi.fn(),
    };
  }

  function createMockDb() {
    return {
      transaction: vi.fn((fn: () => void) => fn),
    };
  }

  function createMockChannelActivityTracker() {
    return {
      getAll: vi.fn(() => []),
      get: vi.fn(),
      getStale: vi.fn(),
      recordActivity: vi.fn(),
      reset: vi.fn(),
      dispose: vi.fn(),
    };
  }

  it("subscribes to observability:token_usage and diagnostic:message_processed events", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Should have subscribed to both events
    expect(eventBus.on).toHaveBeenCalledWith("observability:token_usage", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("diagnostic:message_processed", expect.any(Function));

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("pushes token usage events through buffer to obsStore", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Emit a token usage event
    eventBus.emit("observability:token_usage", {
      timestamp: 1000,
      traceId: "t1",
      agentId: "a1",
      channelId: "c1",
      executionId: "e1",
      provider: "anthropic",
      model: "claude",
      tokens: { prompt: 10, completion: 5, total: 15 },
      cost: { input: 0.01, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.015 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "",
      savedVsUncached: 0,
      cacheEligible: false,
    });

    // Advance timer to trigger buffer flush
    vi.advanceTimersByTime(500);

    expect(obsStore.insertTokenUsage).toHaveBeenCalledTimes(1);
    expect(obsStore.insertTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: 1000,
        agentId: "a1",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
    );

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("pushes delivery and diagnostic events on diagnostic:message_processed", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Emit a message processed event
    eventBus.emit("diagnostic:message_processed", {
      messageId: "m1",
      channelId: "c1",
      channelType: "telegram",
      agentId: "a1",
      sessionKey: "sk-1",
      receivedAt: 900,
      executionDurationMs: 80,
      deliveryDurationMs: 20,
      totalDurationMs: 100,
      tokensUsed: 300,
      cost: 0.02,
      success: true,
      finishReason: "end_turn",
      timestamp: 1000,
    });

    // Advance timer to trigger buffer flush
    vi.advanceTimersByTime(500);

    // Both delivery and diagnostic should be inserted
    expect(obsStore.insertDelivery).toHaveBeenCalledTimes(1);
    expect(obsStore.insertDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", latencyMs: 100 }),
    );

    expect(obsStore.insertDiagnostic).toHaveBeenCalledTimes(1);
    expect(obsStore.insertDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "message",
        message: "diagnostic:message_processed",
      }),
    );

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("drainAll() flushes all 4 buffers", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    // Provide channel data so snapshot buffer has something to drain
    channelActivityTracker.getAll.mockReturnValue([{
      channelId: "c1",
      channelType: "telegram",
      lastActiveAt: Date.now(),
      messagesSent: 5,
      messagesReceived: 10,
    }]);

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now(),
      snapshotIntervalMs: 300_000,
    });

    // Emit events to populate buffers
    eventBus.emit("observability:token_usage", {
      timestamp: 1000, traceId: "t1", agentId: "a1", channelId: "c1",
      executionId: "e1", provider: "p", model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      sessionKey: "", savedVsUncached: 0, cacheEligible: false,
    });

    eventBus.emit("diagnostic:message_processed", {
      messageId: "m1", channelId: "c1", channelType: "telegram",
      agentId: "a1", sessionKey: "sk-1", receivedAt: 900,
      executionDurationMs: 80, deliveryDurationMs: 20, totalDurationMs: 100,
      tokensUsed: 0, cost: 0, success: true, finishReason: "end_turn",
      timestamp: 1000,
    });

    // Trigger snapshot timer to populate channel snapshot buffer
    vi.advanceTimersByTime(300_000);

    // Reset mocks to count only drainAll flushes
    obsStore.insertTokenUsage.mockClear();
    obsStore.insertDelivery.mockClear();
    obsStore.insertDiagnostic.mockClear();
    obsStore.insertChannelSnapshot.mockClear();

    // Emit more events after the timer flush
    eventBus.emit("observability:token_usage", {
      timestamp: 2000, traceId: "t2", agentId: "a1", channelId: "c1",
      executionId: "e2", provider: "p", model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      sessionKey: "", savedVsUncached: 0, cacheEligible: false,
    });

    // drainAll should flush the remaining token usage item
    clearInterval(result.snapshotTimer);
    result.drainAll();

    expect(obsStore.insertTokenUsage).toHaveBeenCalledTimes(1);
  });

  it("channel snapshot timer writes snapshots at configured interval", () => {
    const eventBus = createMockEventBus();
    const obsStore = createMockObsStore();
    const db = createMockDb();
    const channelActivityTracker = createMockChannelActivityTracker();

    channelActivityTracker.getAll.mockReturnValue([
      {
        channelId: "c1",
        channelType: "telegram",
        lastActiveAt: Date.now(), // active
        messagesSent: 5,
        messagesReceived: 10,
      },
      {
        channelId: "c2",
        channelType: "discord",
        lastActiveAt: Date.now() - 600_000, // stale (> 300s)
        messagesSent: 1,
        messagesReceived: 2,
      },
    ]);

    const result = setupObsPersistence({
      eventBus: eventBus as never,
      obsStore: obsStore as never,
      db: db as never,
      channelActivityTracker: channelActivityTracker as never,
      startupTimestamp: Date.now() - 60_000,
      snapshotIntervalMs: 60_000, // 60s for test
    });

    // Advance to trigger snapshot
    vi.advanceTimersByTime(60_000);

    // Advance write buffer timer to flush
    vi.advanceTimersByTime(500);

    expect(obsStore.insertChannelSnapshot).toHaveBeenCalledTimes(2);

    // Verify active vs stale status
    const calls = obsStore.insertChannelSnapshot.mock.calls;
    const statuses = calls.map((c: unknown[]) => (c[0] as { status: string }).status);
    expect(statuses).toContain("active");
    expect(statuses).toContain("stale");

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });
});
