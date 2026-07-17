// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus, type EventMap } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDeliveryTracer,
  type DeliveryTracer,
} from "./delivery-tracer.js";

describe("createDeliveryTracer", () => {
  let bus: TypedEventBus;
  let tracer: DeliveryTracer;

  beforeEach(() => {
    bus = new TypedEventBus();
    tracer = createDeliveryTracer({ eventBus: bus });
  });

  afterEach(() => {
    tracer.dispose();
    vi.useRealTimers();
  });

  function emitDiagnosticProcessed(overrides: Partial<{
    messageId: string;
    channelId: string;
    channelType: string;
    agentId: string;
    sessionKey: string;
    traceId: string;
    toolCalls: number | null;
    llmCalls: number | null;
    totalDurationMs: number;
    status: "success" | "error" | "timeout" | "filtered" | "aborted";
    failureStage: "execution" | "delivery";
    errorKind: "dependency" | "timeout" | "platform" | "resource";
    finishReason: string;
    timestamp: number;
  }> = {}): void {
    const payload = {
      messageId: overrides.messageId ?? "msg-1",
      channelId: overrides.channelId ?? "ch-1",
      channelType: overrides.channelType ?? "telegram",
      agentId: overrides.agentId ?? "agent-1",
      sessionKey: overrides.sessionKey ?? "default:user-1:ch-1",
      traceId: overrides.traceId ?? "trace-1",
      toolCalls: overrides.toolCalls === undefined ? 2 : overrides.toolCalls,
      llmCalls: overrides.llmCalls === undefined ? 3 : overrides.llmCalls,
      receivedAt: Date.now() - (overrides.totalDurationMs ?? 150),
      executionDurationMs: (overrides.totalDurationMs ?? 150) - 20,
      deliveryDurationMs: 20,
      totalDurationMs: overrides.totalDurationMs ?? 150,
      tokensUsed: 100,
      cost: 0.003,
      status: overrides.status ?? "success",
      failureStage: overrides.failureStage,
      errorKind: overrides.errorKind,
      finishReason: overrides.finishReason ?? "stop",
      timestamp: overrides.timestamp ?? Date.now(),
    } as EventMap["diagnostic:message_processed"] & {
      toolCalls: number | null;
      llmCalls: number | null;
    };
    bus.emit("diagnostic:message_processed", payload);
  }

  function emitReceived(
    channelId: string,
    channelType = "telegram",
    messageId = "00000000-0000-0000-0000-000000000001",
    traceId = "trace-received",
  ): void {
    bus.emit("message:received", {
      message: {
        id: messageId,
        channelId,
        channelType,
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: { traceId },
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId },
    });
  }

  function emitSent(channelId: string, sourceMessageId: string, channelType = "telegram"): void {
    const payload: EventMap["message:sent"] = {
      channelType,
      channelId,
      messageId: "msg-reply",
      content: "response",
      sourceChannelType: channelType,
      sourceChannelId: channelId,
      sourceMessageId,
    };
    bus.emit("message:sent", payload);
  }

  it("builds DeliveryContext from diagnostic:message_processed events", () => {
    emitDiagnosticProcessed({
      channelId: "ch-1",
      channelType: "telegram",
      agentId: "agent-1",
      sessionKey: "default:user-1:ch-1",
      traceId: "trace-delivery",
      toolCalls: 4,
      llmCalls: 5,
      totalDurationMs: 200,
      status: "success",
    });

    const recent = tracer.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.sourceChannelId).toBe("ch-1");
    expect(recent[0]!.sourceChannelType).toBe("telegram");
    expect(recent[0]!.targetChannelId).toBe("ch-1");
    expect(recent[0]!.targetChannelType).toBe("telegram");
    expect(recent[0]!.latencyMs).toBe(200);
    expect(recent[0]!.status).toBe("success");
    expect(recent[0]!.agentId).toBe("agent-1");
    expect(recent[0]!.sessionKey).toBe("default:user-1:ch-1");
    expect(recent[0]!.traceId).toBe("trace-delivery");
    expect(recent[0]!.toolCalls).toBe(4);
    expect(recent[0]!.llmCalls).toBe(5);
    expect(recent[0]!.tokensTotal).toBe(100);
    expect(recent[0]!.costTotal).toBe(0.003);
    expect(recent[0]!.evidence).toBe("diagnostic");
    expect(recent[0]!.error).toBeNull();
  });

  it("derives a pre-execution step when total latency includes queueing", () => {
    bus.emit("diagnostic:message_processed", {
      messageId: "msg-latency",
      channelId: "ch-latency",
      channelType: "telegram",
      agentId: "agent-1",
      sessionKey: "default:user-1:ch-latency",
      traceId: "trace-latency",
      toolCalls: 0,
      llmCalls: 1,
      receivedAt: 1_000,
      executionDurationMs: 100,
      deliveryDurationMs: 40,
      totalDurationMs: 340,
      tokensUsed: 10,
      cost: 0.001,
      status: "success",
      finishReason: "stop",
      timestamp: 1_340,
    });

    expect(tracer.getRecent()[0]?.steps).toEqual([
      { name: "receive", timestamp: 1_000, durationMs: 0, status: "ok" },
      { name: "pre-execution", timestamp: 1_000, durationMs: 200, status: "ok" },
      { name: "execute", timestamp: 1_200, durationMs: 100, status: "ok" },
      { name: "deliver", timestamp: 1_300, durationMs: 40, status: "ok" },
    ]);
  });

  it("correlates message:received and message:sent into DeliveryContext", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    emitReceived("ch-corr");

    // Advance 50ms to simulate processing time
    vi.advanceTimersByTime(50);

    emitSent("ch-corr", "00000000-0000-0000-0000-000000000001");

    const recent = tracer.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.sourceChannelId).toBe("ch-corr");
    expect(recent[0]!.sourceChannelType).toBe("telegram");
    expect(recent[0]!.targetChannelId).toBe("ch-corr");
    expect(recent[0]!.targetChannelType).toBe("telegram");
    expect(recent[0]!.latencyMs).toBe(50);
    expect(recent[0]!.status).toBe("success");
    expect(recent[0]!.sessionKey).toBe("default:user-1:ch-corr");
    expect(recent[0]!.toolCalls).toBeNull();
    expect(recent[0]!.llmCalls).toBeNull();
    expect(recent[0]!.tokensTotal).toBeNull();
    expect(recent[0]!.costTotal).toBeNull();
    expect(recent[0]!.steps).toBeNull();
    expect(recent[0]!.evidence).toBe("message_correlation");
  });

  it("clamps correlation latency when the wall clock moves backward", () => {
    vi.useFakeTimers({ now: 1_000 });
    emitReceived("ch-clock", "telegram", "message-clock", "trace-clock");
    vi.setSystemTime(900);

    emitSent("ch-clock", "message-clock");

    expect(tracer.getRecent()).toEqual([
      expect.objectContaining({ traceId: "trace-clock", latencyMs: 0 }),
    ]);
    expect(tracer.getStats()).toMatchObject({ attemptedLatencyMs: 0, avgLatencyMs: 0 });
  });

  it("isolates pending correlations by channel type when channel ids collide", () => {
    emitReceived("shared", "telegram", "telegram-inbound", "telegram-trace");
    emitReceived("shared", "slack", "slack-inbound", "slack-trace");

    emitSent("shared", "slack-inbound", "slack");

    expect(tracer.getRecent({ limit: 10 })).toEqual([
      expect.objectContaining({
        sourceChannelId: "shared",
        sourceChannelType: "slack",
        targetChannelId: "shared",
        targetChannelType: "slack",
        traceId: "slack-trace",
        evidence: "message_correlation",
      }),
    ]);

    emitSent("shared", "telegram-inbound", "telegram");

    expect(new Set(tracer.getRecent({ limit: 10 }).map((record) => record.traceId))).toEqual(
      new Set(["telegram-trace", "slack-trace"]),
    );
  });

  it("correlates a cross-channel reply from its exact source endpoint", () => {
    vi.useFakeTimers({ now: 1_000 });
    emitReceived("source-chat", "telegram", "source-message", "source-trace");
    vi.advanceTimersByTime(25);

    const payload: EventMap["message:sent"] & {
      sourceChannelType: string;
      sourceChannelId: string;
    } = {
      channelType: "slack",
      channelId: "target-chat",
      messageId: "target-message",
      content: "response",
      sourceChannelType: "telegram",
      sourceChannelId: "source-chat",
      sourceMessageId: "source-message",
    };
    bus.emit("message:sent", payload);

    expect(tracer.getRecent()).toEqual([
      expect.objectContaining({
        sourceChannelType: "telegram",
        sourceChannelId: "source-chat",
        targetChannelType: "slack",
        targetChannelId: "target-chat",
        traceId: "source-trace",
        latencyMs: 25,
      }),
    ]);
  });

  it("records an early terminal outcome when execution diagnostics never start", () => {
    vi.useFakeTimers({ now: 2_000 });
    emitReceived("blocked-chat", "telegram", "blocked-message", "blocked-trace");
    vi.advanceTimersByTime(40);

    bus.emit("message:terminal", {
      channelType: "telegram",
      channelId: "blocked-chat",
      sourceMessageId: "blocked-message",
      outcome: "filtered",
      reason: "gate_skipped",
      timestamp: 2_040,
    });

    expect(tracer.getRecent()).toEqual([
      expect.objectContaining({
        sourceChannelType: "telegram",
        sourceChannelId: "blocked-chat",
        targetChannelType: "telegram",
        targetChannelId: "blocked-chat",
        status: "filtered",
        traceId: "blocked-trace",
        latencyMs: 40,
      }),
    ]);
    expect(tracer.getStats()).toMatchObject({ total: 1, filtered: 1 });
  });

  it("records a terminal rejection that occurs before session resolution", () => {
    bus.emit("message:terminal", {
      channelType: "telegram",
      channelId: "blocked-before-resolution",
      sourceMessageId: "blocked-before-resolution-message",
      outcome: "error",
      reason: "inbound_rejected",
      timestamp: 3_000,
    });

    expect(tracer.getRecent()).toEqual([
      expect.objectContaining({
        sourceChannelType: "telegram",
        sourceChannelId: "blocked-before-resolution",
        status: "error",
        error: "inbound_rejected",
        sessionKey: null,
        traceId: null,
      }),
    ]);
  });

  it("replaces an early terminal fallback with one later authoritative diagnostic", () => {
    emitReceived("queued-chat", "telegram", "queued-message", "queued-trace");
    bus.emit("message:terminal", {
      channelType: "telegram",
      channelId: "queued-chat",
      sourceMessageId: "queued-message",
      outcome: "aborted",
      reason: "queue_aborted",
      timestamp: Date.now(),
    });

    emitDiagnosticProcessed({
      messageId: "queued-message",
      channelId: "queued-chat",
      traceId: "queued-trace",
      status: "aborted",
    });
    bus.emit("message:terminal", {
      channelType: "telegram",
      channelId: "queued-chat",
      sourceMessageId: "queued-message",
      outcome: "aborted",
      reason: "execution_completed",
      timestamp: Date.now(),
    });

    expect(tracer.getRecent({ limit: 10 })).toEqual([
      expect.objectContaining({
        traceId: "queued-trace",
        status: "aborted",
        evidence: "diagnostic",
      }),
    ]);
    expect(tracer.getStats()).toMatchObject({ total: 1, aborted: 1 });
  });

  it("bounds pending correlations by evicting the globally oldest inbound message", () => {
    for (let index = 0; index <= 1_000; index += 1) {
      emitReceived(
        `channel-${index}`,
        "telegram",
        `message-${index}`,
        `trace-${index}`,
      );
    }

    emitSent("channel-0", "message-0");
    emitSent("channel-1000", "message-1000");

    expect(tracer.getRecent({ limit: 10 })).toEqual([
      expect.objectContaining({
        sourceChannelId: "channel-1000",
        traceId: "trace-1000",
      }),
    ]);
  });

  it("replaces correlation fallbacks only within the matching channel type", () => {
    const repeatedMessageId = "00000000-0000-0000-0000-000000000099";
    emitReceived("shared", "telegram", repeatedMessageId, "telegram-trace");
    emitReceived("shared", "slack", repeatedMessageId, "slack-trace");
    emitSent("shared", repeatedMessageId, "slack");
    emitSent("shared", repeatedMessageId, "telegram");

    emitDiagnosticProcessed({
      messageId: repeatedMessageId,
      channelId: "shared",
      channelType: "slack",
      traceId: "slack-trace",
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(2);
    expect(recent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceChannelType: "telegram",
        traceId: "telegram-trace",
        evidence: "message_correlation",
      }),
      expect.objectContaining({
        sourceChannelType: "slack",
        traceId: "slack-trace",
        evidence: "diagnostic",
      }),
    ]));
  });

  it("replaces a message correlation fallback with the authoritative diagnostic", () => {
    emitReceived("ch-corr", "telegram", "inbound-1", "trace-1");
    emitSent("ch-corr", "inbound-1");
    emitDiagnosticProcessed({
      messageId: "inbound-1",
      channelId: "ch-corr",
      traceId: "trace-1",
      toolCalls: 4,
      llmCalls: 5,
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      traceId: "trace-1",
      toolCalls: 4,
      llmCalls: 5,
      evidence: "diagnostic",
    });
    expect(tracer.getStats().total).toBe(1);
  });

  it("keeps fallback correlation across pending-entry sweeps", () => {
    tracer.dispose();
    vi.useFakeTimers({ now: 0 });
    tracer = createDeliveryTracer({ eventBus: bus });

    vi.advanceTimersByTime(29_999);
    emitReceived("ch-corr", "telegram", "inbound-1", "trace-1");
    emitSent("ch-corr", "inbound-1");

    // Cross 60 seconds and the next pending-entry sweep boundary. Completed
    // fallback correlation has a separate, longer retention window.
    vi.advanceTimersByTime(61_000);
    emitDiagnosticProcessed({
      messageId: "inbound-1",
      channelId: "ch-corr",
      channelType: "telegram",
      traceId: "trace-1",
    });

    expect(tracer.getRecent({ limit: 10 })).toEqual([
      expect.objectContaining({ traceId: "trace-1", evidence: "diagnostic" }),
    ]);
    expect(tracer.getStats()).toMatchObject({ total: 1, attempted: 1, successes: 1 });
  });

  it("expires fallback metadata before correlating a reused message id", () => {
    tracer.dispose();
    vi.useFakeTimers({ now: 0 });
    tracer = createDeliveryTracer({ eventBus: bus });

    emitReceived("ch-corr", "telegram", "reused-id", "trace-old");
    vi.advanceTimersByTime(1);
    emitSent("ch-corr", "reused-id");

    vi.advanceTimersByTime(5 * 60_000 + 1);
    emitReceived("ch-corr", "telegram", "reused-id", "trace-new");
    vi.advanceTimersByTime(2);
    emitSent("ch-corr", "reused-id");
    emitDiagnosticProcessed({
      messageId: "reused-id",
      channelId: "ch-corr",
      channelType: "telegram",
      traceId: "trace-new",
      totalDurationMs: 3,
    });

    expect(tracer.getRecent({ limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ traceId: "trace-old", evidence: "message_correlation" }),
      expect.objectContaining({ traceId: "trace-new", evidence: "diagnostic" }),
    ]));
    expect(tracer.getStats()).toMatchObject({
      total: 2,
      attempted: 2,
      successes: 2,
      attemptedLatencyMs: 4,
    });
  });

  it("expires fallback metadata independently when the wall clock changes", () => {
    tracer.dispose();
    vi.useFakeTimers({ now: 1_000 });
    tracer = createDeliveryTracer({ eventBus: bus });

    emitReceived("ch-a", "telegram", "message-a", "trace-a");
    emitSent("ch-a", "message-a");

    vi.setSystemTime(-1_000_000);
    emitReceived("ch-b", "telegram", "message-b", "trace-b");
    emitSent("ch-b", "message-b");

    // The second fallback expires first because it was created after a large
    // backward clock adjustment. Its TTL must not be blocked by the first row.
    vi.setSystemTime(0);
    emitDiagnosticProcessed({
      messageId: "message-b",
      channelId: "ch-b",
      traceId: "trace-b-diagnostic",
      timestamp: 0,
    });

    expect(tracer.getRecent({ limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ traceId: "trace-a", evidence: "message_correlation" }),
      expect.objectContaining({ traceId: "trace-b", evidence: "message_correlation" }),
      expect.objectContaining({ traceId: "trace-b-diagnostic", evidence: "diagnostic" }),
    ]));
    expect(tracer.getStats()).toMatchObject({ total: 3, attempted: 3, successes: 3 });
  });

  it("uses the source message id instead of a stale same-channel pending message", () => {
    emitReceived("ch-corr", "telegram", "inbound-stale", "trace-stale");
    emitReceived("ch-corr", "telegram", "inbound-current", "trace-current");
    emitSent("ch-corr", "inbound-current");
    emitDiagnosticProcessed({
      messageId: "inbound-current",
      channelId: "ch-corr",
      traceId: "trace-current",
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      traceId: "trace-current",
      evidence: "diagnostic",
    });
    expect(tracer.getStats()).toMatchObject({ total: 1, attempted: 1, successes: 1 });
  });

  it("correlates reverse-order same-channel sends by their source message ids", () => {
    vi.useFakeTimers({ now: 1_000 });
    emitReceived("ch-corr", "telegram", "inbound-1", "trace-1");
    vi.advanceTimersByTime(10);
    emitReceived("ch-corr", "telegram", "inbound-2", "trace-2");

    vi.advanceTimersByTime(10);
    emitSent("ch-corr", "inbound-2");
    vi.advanceTimersByTime(10);
    emitSent("ch-corr", "inbound-1");
    const correlations = tracer.getRecent({ limit: 10 });

    emitDiagnosticProcessed({
      messageId: "inbound-2",
      channelId: "ch-corr",
      traceId: "trace-2",
    });
    emitDiagnosticProcessed({
      messageId: "inbound-1",
      channelId: "ch-corr",
      traceId: "trace-1",
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(2);
    expect(recent.every((record) => record.evidence === "diagnostic")).toBe(true);
    expect(new Set(recent.map((record) => record.traceId))).toEqual(new Set(["trace-1", "trace-2"]));
    expect(tracer.getStats()).toMatchObject({ total: 2, attempted: 2, successes: 2 });
    expect(correlations.map(({ traceId, latencyMs }) => ({ traceId, latencyMs }))).toEqual([
      { traceId: "trace-1", latencyMs: 30 },
      { traceId: "trace-2", latencyMs: 10 },
    ]);
  });

  it("does not append a late message correlation after an authoritative diagnostic", () => {
    emitReceived("ch-corr", "telegram", "inbound-1", "trace-1");
    emitDiagnosticProcessed({
      messageId: "inbound-1",
      channelId: "ch-corr",
      traceId: "trace-1",
    });
    emitSent("ch-corr", "inbound-1");

    expect(tracer.getRecent({ limit: 10 })).toHaveLength(1);
    expect(tracer.getRecent()[0]!.evidence).toBe("diagnostic");
    expect(tracer.getStats().total).toBe(1);
  });

  it("keeps unrelated message ids distinct on the same channel", () => {
    emitReceived("ch-corr", "telegram", "inbound-1", "trace-1");
    emitSent("ch-corr", "inbound-1");
    emitDiagnosticProcessed({
      messageId: "inbound-2",
      channelId: "ch-corr",
      traceId: "trace-2",
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(2);
    expect(new Set(recent.map((row) => row.traceId))).toEqual(new Set(["trace-1", "trace-2"]));
  });

  it("replaces same message ids only within the matching channel", () => {
    emitReceived("ch-a", "telegram", "shared-id", "trace-a");
    emitSent("ch-a", "shared-id");
    emitReceived("ch-b", "telegram", "shared-id", "trace-b");
    emitSent("ch-b", "shared-id");

    emitDiagnosticProcessed({
      messageId: "shared-id",
      channelId: "ch-b",
      traceId: "trace-b",
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(2);
    expect(recent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceChannelId: "ch-a",
        traceId: "trace-a",
        evidence: "message_correlation",
      }),
      expect.objectContaining({
        sourceChannelId: "ch-b",
        traceId: "trace-b",
        evidence: "diagnostic",
      }),
    ]));
    expect(tracer.getStats()).toMatchObject({ total: 2, attempted: 2, successes: 2 });
  });

  it("preserves unknown primary call counts as null", () => {
    emitDiagnosticProcessed({ toolCalls: null, llmCalls: null });

    const recent = tracer.getRecent();
    expect(recent[0]!.toolCalls).toBeNull();
    expect(recent[0]!.llmCalls).toBeNull();
  });

  it("labels a delivery-stage failure without reusing the successful executor reason", () => {
    emitDiagnosticProcessed({
      status: "error",
      failureStage: "delivery",
      errorKind: "platform",
      finishReason: "stop",
    });

    expect(tracer.getRecent()[0]).toMatchObject({
      status: "error",
      error: "delivery_failed",
      failureStage: "delivery",
      errorKind: "platform",
    });
  });

  it("marks a stage-unknown error as an execution failure in the trace", () => {
    emitDiagnosticProcessed({
      status: "error",
      finishReason: "error",
    });

    expect(tracer.getRecent()[0]).toMatchObject({
      status: "error",
      failureStage: null,
      steps: expect.arrayContaining([
        expect.objectContaining({
          name: "execute",
          status: "error",
          error: "error",
        }),
      ]),
    });
  });

  it("does not reuse executor stop for late aborts or abort-driven execution errors", () => {
    emitDiagnosticProcessed({ status: "aborted", finishReason: "stop" });
    emitDiagnosticProcessed({
      status: "error",
      failureStage: "execution",
      errorKind: "precondition",
      finishReason: "stop",
    });

    expect(tracer.getRecent({ limit: 2 }).map((record) => record.error)).toEqual(
      expect.arrayContaining(["execution_failed", "aborted"]),
    );
  });

  it("getRecent returns newest first", () => {
    emitDiagnosticProcessed({ channelId: "ch-1", timestamp: 1000 });
    emitDiagnosticProcessed({ channelId: "ch-2", timestamp: 2000 });
    emitDiagnosticProcessed({ channelId: "ch-3", timestamp: 3000 });

    const recent = tracer.getRecent();
    expect(recent).toHaveLength(3);
    // Newest first (last pushed = ch-3)
    expect(recent[0]!.sourceChannelId).toBe("ch-3");
    expect(recent[1]!.sourceChannelId).toBe("ch-2");
    expect(recent[2]!.sourceChannelId).toBe("ch-1");
  });

  it("getRecent applies its limit after sorting by delivery timestamp", () => {
    emitDiagnosticProcessed({ channelId: "ch-newer", timestamp: 3000 });
    emitDiagnosticProcessed({ channelId: "ch-older", timestamp: 1000 });

    const recent = tracer.getRecent({ limit: 1 });

    expect(recent).toHaveLength(1);
    expect(recent[0]!.sourceChannelId).toBe("ch-newer");
  });

  it("getRecent filters by sinceMs", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    // Old event (60 seconds ago)
    emitDiagnosticProcessed({ channelId: "ch-old", timestamp: now - 60_000 });
    // Recent event (5 seconds ago)
    emitDiagnosticProcessed({ channelId: "ch-new", timestamp: now - 5_000 });

    // Filter to last 30 seconds
    const filtered = tracer.getRecent({ sinceMs: 30_000 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sourceChannelId).toBe("ch-new");
  });

  it("getRecent filters by channelId", () => {
    emitDiagnosticProcessed({ channelId: "ch-A" });
    emitDiagnosticProcessed({ channelId: "ch-B" });
    emitDiagnosticProcessed({ channelId: "ch-A" });

    const filtered = tracer.getRecent({ channelId: "ch-A" });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.sourceChannelId === "ch-A")).toBe(true);
  });

  it("getRecent matches a channel pair on the same delivery endpoint", () => {
    emitReceived("source-id", "telegram", "inbound-routed", "trace-routed");
    emitSent("source-id", "inbound-routed", "telegram");
    const routed = tracer.getRecent()[0]!;
    routed.targetChannelId = "target-id";
    routed.targetChannelType = "slack";

    expect(tracer.getRecent({ channelType: "telegram", channelId: "source-id" })).toHaveLength(1);
    expect(tracer.getRecent({ channelType: "slack", channelId: "target-id" })).toHaveLength(1);
    expect(tracer.getRecent({ channelType: "slack", channelId: "source-id" })).toEqual([]);
    expect(tracer.getRecent({ channelType: "telegram", channelId: "target-id" })).toEqual([]);
    expect(tracer.getRecent({ channelType: "slack" })).toHaveLength(1);
    expect(tracer.getRecent({ channelId: "source-id" })).toHaveLength(1);
  });

  it("getRecent respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      emitDiagnosticProcessed({ channelId: `ch-${i}` });
    }

    const limited = tracer.getRecent({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("ring buffer evicts oldest when full", () => {
    const small = createDeliveryTracer({ eventBus: bus, maxRecords: 3 });

    for (let i = 0; i < 5; i++) {
      bus.emit("diagnostic:message_processed", {
        messageId: `msg-${i}`,
        channelId: `ch-${i}`,
        channelType: "telegram",
        agentId: "agent-1",
        sessionKey: "default:user-1:ch-1",
        traceId: `trace-${i}`,
        toolCalls: i,
        llmCalls: i + 1,
        receivedAt: Date.now() - 100,
        executionDurationMs: 80,
        deliveryDurationMs: 20,
        totalDurationMs: 100,
        tokensUsed: 50,
        cost: 0.001,
        status: "success",
        finishReason: "stop",
        timestamp: Date.now() + i,
      });
    }

    const recent = small.getRecent({ limit: 100 });
    expect(recent).toHaveLength(3);

    // Newest first: ch-4, ch-3, ch-2
    expect(recent[0]!.sourceChannelId).toBe("ch-4");
    expect(recent[1]!.sourceChannelId).toBe("ch-3");
    expect(recent[2]!.sourceChannelId).toBe("ch-2");

    small.dispose();
  });

  it("retains the full maximum API page by default", () => {
    for (let index = 0; index < 10_000; index += 1) {
      emitDiagnosticProcessed({
        messageId: `message-${index}`,
        channelId: `channel-${index}`,
        traceId: `trace-${index}`,
        timestamp: index,
      });
    }

    const recent = tracer.getRecent({ limit: 10_000 });
    expect(recent).toHaveLength(10_000);
    expect(recent[0]?.traceId).toBe("trace-9999");
    expect(recent.at(-1)?.traceId).toBe("trace-0");
  });

  it("replaces an evicted fallback as the same logical delivery", () => {
    vi.useFakeTimers({ now: 1_000 });
    const small = createDeliveryTracer({ eventBus: bus, maxRecords: 1 });

    try {
      emitReceived("ch-a", "telegram", "inbound-a", "trace-a");
      vi.advanceTimersByTime(1);
      emitSent("ch-a", "inbound-a");
      emitDiagnosticProcessed({
        messageId: "inbound-b",
        channelId: "ch-b",
        traceId: "trace-b",
        totalDurationMs: 5,
      });
      expect(small.getRecent()[0]).toMatchObject({ traceId: "trace-b", evidence: "diagnostic" });
      vi.advanceTimersByTime(61_000);

      emitDiagnosticProcessed({
        messageId: "inbound-a",
        channelId: "ch-a",
        traceId: "trace-a",
        totalDurationMs: 7,
      });

      expect(small.getRecent()).toEqual([
        expect.objectContaining({ traceId: "trace-a", evidence: "diagnostic" }),
      ]);
      expect(small.getStats()).toMatchObject({
        total: 2,
        attempted: 2,
        successes: 2,
        attemptedLatencyMs: 12,
        avgLatencyMs: 6,
      });
    } finally {
      small.dispose();
    }
  });

  it("repeated inbound message ids replace each fallback exactly once", () => {
    emitReceived("ch-a", "telegram", "inbound-repeated", "trace-a-1");
    emitSent("ch-a", "inbound-repeated");
    emitReceived("ch-a", "telegram", "inbound-repeated", "trace-a-2");
    emitSent("ch-a", "inbound-repeated");

    emitDiagnosticProcessed({
      messageId: "inbound-repeated",
      channelId: "ch-a",
      traceId: "trace-a-1",
    });
    emitDiagnosticProcessed({
      messageId: "inbound-repeated",
      channelId: "ch-a",
      traceId: "trace-a-2",
    });

    const recent = tracer.getRecent({ limit: 10 });
    expect(recent).toHaveLength(2);
    expect(recent.every((record) => record.evidence === "diagnostic")).toBe(true);
    expect(tracer.getStats()).toMatchObject({ total: 2, attempted: 2, successes: 2 });
  });

  it("getStats keeps error, timeout, filtered, and aborted outcomes distinct", () => {
    emitDiagnosticProcessed({ status: "success", totalDurationMs: 100 });
    emitDiagnosticProcessed({ status: "error", failureStage: "execution", errorKind: "dependency", totalDurationMs: 200, finishReason: "error" });
    emitDiagnosticProcessed({ status: "timeout", failureStage: "execution", errorKind: "timeout", totalDurationMs: 50, finishReason: "prompt_timeout" });
    emitDiagnosticProcessed({ status: "filtered", totalDurationMs: 25 });
    emitDiagnosticProcessed({ status: "aborted", totalDurationMs: 75 });

    const stats = tracer.getStats();
    expect(stats.total).toBe(5);
    expect(stats.attempted).toBe(3);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
    expect(stats.timeouts).toBe(1);
    expect(stats.filtered).toBe(1);
    expect(stats.aborted).toBe(1);
    // Attempted average: (100 + 200 + 50) / 3 = 116.67 -> rounds to 117.
    expect(stats.avgLatencyMs).toBe(117);
  });

  it("getStats applies the requested time window to every delivery category", () => {
    const now = 2_000_000;
    vi.useFakeTimers({ now });
    emitDiagnosticProcessed({
      messageId: "old-error",
      status: "error",
      failureStage: "execution",
      totalDurationMs: 200,
      timestamp: now - 2 * 60 * 60_000,
    });
    emitDiagnosticProcessed({
      messageId: "recent-success",
      status: "success",
      totalDurationMs: 100,
      timestamp: now - 60_000,
    });
    emitDiagnosticProcessed({
      messageId: "recent-filtered",
      status: "filtered",
      totalDurationMs: 25,
      timestamp: now - 30_000,
    });

    expect(tracer.getStats({ sinceMs: 60 * 60_000 })).toEqual({
      total: 2,
      attempted: 1,
      successes: 1,
      failures: 0,
      timeouts: 0,
      filtered: 1,
      aborted: 0,
      attemptedLatencyMs: 100,
      avgLatencyMs: 100,
    });
  });

  it("reset clears all records", () => {
    emitDiagnosticProcessed();
    emitDiagnosticProcessed();

    expect(tracer.getRecent({ limit: 100 })).toHaveLength(2);

    tracer.reset();

    expect(tracer.getRecent({ limit: 100 })).toHaveLength(0);
    expect(tracer.getStats().total).toBe(0);
  });

  it("dispose unsubscribes from EventBus", () => {
    // Emit before dispose
    emitDiagnosticProcessed({ channelId: "ch-before" });
    expect(tracer.getRecent()).toHaveLength(1);

    tracer.dispose();

    // Emit after dispose -- should NOT be collected
    emitDiagnosticProcessed({ channelId: "ch-after" });
    emitReceived("ch-new");
    emitSent("ch-new", "00000000-0000-0000-0000-000000000001");

    // Still only 1 record from before dispose
    expect(tracer.getRecent({ limit: 100 })).toHaveLength(1);
    expect(tracer.getRecent()[0]!.sourceChannelId).toBe("ch-before");
  });
});
