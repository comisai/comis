// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  tokenUsageEventToRow,
  deliveryEventToRow,
  diagnosticEventToRow,
  sessionSummaryEventToRow,
  dagDegradedEventToRow,
  healthBudgetExceededEventToRow,
  mcpReconnectFailedEventToRow,
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
// sessionSummaryEventToRow (F2 — per-session health rollup)
// ---------------------------------------------------------------------------

describe("sessionSummaryEventToRow", () => {
  it("maps a degraded session:summary payload to a DiagnosticRow(category:session_summary, severity:warning)", () => {
    const row = sessionSummaryEventToRow({
      sessionKey: "s1",
      agentId: "a1",
      traceId: "t1",
      degraded: true,
      turnCount: 24,
      costUsd: 1.45,
      toolStats: { web_fetch: { ok: 2, failed: 8 } },
      breakerTripCount: 1,
      timestamp: 1000,
      topErrorKinds: { dependency: 8 },
      source: "runtime",
    });

    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("session_summary");
    // degraded run -> warning severity (operator-visible).
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("a1");
    expect(row.sessionKey).toBe("s1");
    expect(row.traceId).toBe("t1");
    expect(row.message.length).toBeGreaterThan(0);

    // details JSON carries counts/flags only — no error bodies, no message text.
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details.degraded).toBe(true);
    expect(details.costUsd).toBe(1.45);
    expect(details.toolStats).toEqual({ web_fetch: { ok: 2, failed: 8 } });
    expect(details.breakerTripCount).toBe(1);
    expect(details.turnCount).toBe(24);
    // A1 carries topErrorKinds into the row; A2 carries source — both queryable
    // by the fleet aggregate without opening per-session _session-metadata.json.
    expect(details.topErrorKinds).toEqual({ dependency: 8 });
    expect(details.source).toBe("runtime");
  });

  it("maps a non-degraded session:summary payload to severity:info", () => {
    const row = sessionSummaryEventToRow({
      sessionKey: "s2",
      agentId: "a2",
      traceId: "t2",
      degraded: false,
      turnCount: 3,
      costUsd: 0.02,
      toolStats: {},
      breakerTripCount: 0,
      timestamp: 2000,
      topErrorKinds: {},
      source: "runtime",
    });

    expect(row.category).toBe("session_summary");
    expect(row.severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// dagDegradedEventToRow (I1 — LCD-divergence → health_signal)
// ---------------------------------------------------------------------------

describe("dagDegradedEventToRow", () => {
  it("maps a context:dag_degraded payload to a health_signal row (severity:warning, traceId undefined)", () => {
    const row = dagDegradedEventToRow({
      conversationId: "conv-1",
      agentId: "a1",
      sessionKey: "sk-1",
      reason: "live_store_divergence",
      durationMs: 5,
      timestamp: 1000,
    });

    expect(row.timestamp).toBe(1000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.agentId).toBe("a1");
    expect(row.sessionKey).toBe("sk-1");
    expect(row.message).toBe("context:dag_degraded");
    // The payload has NO traceId field — sessionKey correlates instead.
    expect(row.traceId).toBeUndefined();

    // details carries ONLY the closed-label signal + closed-union reason + a
    // count — no message/summary text. Exactly {signal, reason, durationMs}.
    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({ signal: "lcd_divergence", reason: "live_store_divergence", durationMs: 5 });
  });

  it("carries each divergence reason through verbatim (closed union — safe)", () => {
    for (const reason of ["leaf_window_divergence", "condense_window_divergence"] as const) {
      const row = dagDegradedEventToRow({
        conversationId: "c",
        agentId: "a",
        sessionKey: "s",
        reason,
        durationMs: 0,
        timestamp: 1,
      });
      const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
      expect(details.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// healthBudgetExceededEventToRow (I1 — MCP/alert budget → health_signal)
// ---------------------------------------------------------------------------

describe("healthBudgetExceededEventToRow", () => {
  it("maps a health:budget_exceeded payload to a health_signal row (counts/labels only)", () => {
    const row = healthBudgetExceededEventToRow({
      kind: "dependency",
      count: 5,
      windowMs: 60_000,
      timestamp: 2000,
    });

    expect(row.timestamp).toBe(2000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("health:budget_exceeded");
    // The event has no agentId/sessionKey — the row omits them (daemon-global).
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    expect(details).toEqual({ signal: "alert_budget", kind: "dependency", count: 5, windowMs: 60_000 });
  });
});

// ---------------------------------------------------------------------------
// mcpReconnectFailedEventToRow (I1 — MCP reconnect churn → health_signal)
// ---------------------------------------------------------------------------

describe("mcpReconnectFailedEventToRow", () => {
  it("maps a mcp:server:reconnect_failed payload to a health_signal row and DROPS lastError (bounded payload)", () => {
    const longBody = "boom ".repeat(120); // ~600 chars — must NOT reach the row.
    const row = mcpReconnectFailedEventToRow({
      serverName: "srv",
      attempts: 3,
      lastError: longBody,
      timestamp: 3000,
    });

    expect(row.timestamp).toBe(3000);
    expect(row.category).toBe("health_signal");
    expect(row.severity).toBe("warning");
    expect(row.message).toBe("mcp:server:reconnect_failed");
    expect(row.agentId).toBeUndefined();
    expect(row.sessionKey).toBeUndefined();
    expect(row.traceId).toBeUndefined();

    const details = JSON.parse(row.details ?? "{}") as Record<string, unknown>;
    // label + count ONLY — the error body lives in the trajectory + daemon.log.
    expect(details).toEqual({ signal: "mcp_reconnect_failed", serverName: "srv", attempts: 3 });
    // Defensive: the body never leaks into the row at all.
    expect(row.details ?? "").not.toContain("boom");
    expect("lastError" in details).toBe(false);
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
    // F2: the third subscription — per-session health rollup.
    expect(eventBus.on).toHaveBeenCalledWith("session:summary", expect.any(Function));
    // I1 (Phase 160): the 3 health_signal subscriptions — LCD divergence + MCP health.
    expect(eventBus.on).toHaveBeenCalledWith("context:dag_degraded", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("health:budget_exceeded", expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith("mcp:server:reconnect_failed", expect.any(Function));

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("I1: emitting each health-signal event pushes a category:health_signal row through the diagnostic buffer", () => {
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

    // a. LCD divergence (the widened context:dag_degraded).
    eventBus.emit("context:dag_degraded", {
      conversationId: "conv-1",
      agentId: "a1",
      sessionKey: "sk-1",
      reason: "live_store_divergence",
      durationMs: 7,
      timestamp: 1000,
    });
    // b. Alert-budget threshold crossing.
    eventBus.emit("health:budget_exceeded", { kind: "dependency", count: 5, windowMs: 60_000, timestamp: 1001 });
    // c. MCP reconnect exhaustion (lastError must be dropped on the way to the row).
    eventBus.emit("mcp:server:reconnect_failed", { serverName: "srv", attempts: 3, lastError: "x".repeat(500), timestamp: 1002 });

    // Flush the diagnostic buffer.
    vi.advanceTimersByTime(500);

    // Exactly one health_signal row per event (3 total), each with the right message.
    const calls = (obsStore.insertDiagnostic as ReturnType<typeof vi.fn>).mock.calls;
    const healthRows = calls
      .map((c) => c[0] as { category?: string; message?: string; details?: string })
      .filter((r) => r.category === "health_signal");
    expect(healthRows).toHaveLength(3);
    const messages = healthRows.map((r) => r.message).sort();
    expect(messages).toEqual(["context:dag_degraded", "health:budget_exceeded", "mcp:server:reconnect_failed"]);

    // The MCP row never carries the error body (bounded payload).
    const mcpRow = healthRows.find((r) => r.message === "mcp:server:reconnect_failed")!;
    expect(mcpRow.details ?? "").not.toContain("xxxx");

    // Cleanup
    clearInterval(result.snapshotTimer);
    result.drainAll();
  });

  it("pushes a session:summary event through the diagnostic buffer to insertDiagnostic", () => {
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

    // §1.1 replay shape: a degraded run (8/10 web_fetch failures).
    eventBus.emit("session:summary", {
      sessionKey: "sk-1",
      agentId: "a1",
      traceId: "t1",
      degraded: true,
      turnCount: 24,
      costUsd: 1.45,
      toolStats: { web_fetch: { ok: 2, failed: 8 } },
      breakerTripCount: 1,
      timestamp: 1000,
      topErrorKinds: { dependency: 8 },
      source: "runtime",
    });

    // Advance timer to trigger buffer flush.
    vi.advanceTimersByTime(500);

    expect(obsStore.insertDiagnostic).toHaveBeenCalledTimes(1);
    expect(obsStore.insertDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "session_summary",
        severity: "warning",
        agentId: "a1",
        sessionKey: "sk-1",
        traceId: "t1",
      }),
    );
    // The full event -> buffer -> insertDiagnostic path carries topErrorKinds +
    // source into the persisted row's `details` JSON (A1/A2).
    const insertedRow = (obsStore.insertDiagnostic as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      details?: string;
    };
    const insertedDetails = JSON.parse(insertedRow.details ?? "{}") as Record<string, unknown>;
    expect(insertedDetails.topErrorKinds).toEqual({ dependency: 8 });
    expect(insertedDetails.source).toBe("runtime");

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
