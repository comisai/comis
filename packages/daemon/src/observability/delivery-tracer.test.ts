// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
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
    totalDurationMs: number;
    success: boolean;
    finishReason: string;
    timestamp: number;
  }> = {}): void {
    bus.emit("diagnostic:message_processed", {
      messageId: overrides.messageId ?? "msg-1",
      channelId: overrides.channelId ?? "ch-1",
      channelType: overrides.channelType ?? "telegram",
      agentId: overrides.agentId ?? "agent-1",
      sessionKey: overrides.sessionKey ?? "default:user-1:ch-1",
      receivedAt: Date.now() - (overrides.totalDurationMs ?? 150),
      executionDurationMs: (overrides.totalDurationMs ?? 150) - 20,
      deliveryDurationMs: 20,
      totalDurationMs: overrides.totalDurationMs ?? 150,
      tokensUsed: 100,
      cost: 0.003,
      success: overrides.success ?? true,
      finishReason: overrides.finishReason ?? "stop",
      timestamp: overrides.timestamp ?? Date.now(),
    });
  }

  function emitReceived(channelId: string, channelType = "telegram"): void {
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId,
        channelType,
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId },
    });
  }

  function emitSent(channelId: string): void {
    bus.emit("message:sent", {
      channelId,
      messageId: "msg-reply",
      content: "response",
    });
  }

  it("builds DeliveryContext from diagnostic:message_processed events", () => {
    emitDiagnosticProcessed({
      channelId: "ch-1",
      channelType: "telegram",
      agentId: "agent-1",
      sessionKey: "default:user-1:ch-1",
      totalDurationMs: 200,
      success: true,
    });

    const recent = tracer.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.sourceChannelId).toBe("ch-1");
    expect(recent[0]!.sourceChannelType).toBe("telegram");
    expect(recent[0]!.targetChannelId).toBe("ch-1");
    expect(recent[0]!.latencyMs).toBe(200);
    expect(recent[0]!.success).toBe(true);
    expect(recent[0]!.agentId).toBe("agent-1");
    expect(recent[0]!.sessionKey).toBe("default:user-1:ch-1");
    expect(recent[0]!.error).toBeUndefined();
  });

  it("correlates message:received and message:sent into DeliveryContext", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    emitReceived("ch-corr");

    // Advance 50ms to simulate processing time
    vi.advanceTimersByTime(50);

    emitSent("ch-corr");

    const recent = tracer.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.sourceChannelId).toBe("ch-corr");
    expect(recent[0]!.sourceChannelType).toBe("telegram");
    expect(recent[0]!.targetChannelId).toBe("ch-corr");
    expect(recent[0]!.latencyMs).toBe(50);
    expect(recent[0]!.success).toBe(true);
    expect(recent[0]!.sessionKey).toBe("default:user-1:ch-corr");
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
        receivedAt: Date.now() - 100,
        executionDurationMs: 80,
        deliveryDurationMs: 20,
        totalDurationMs: 100,
        tokensUsed: 50,
        cost: 0.001,
        success: true,
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

  it("getStats returns accurate counts and average latency", () => {
    // 2 successes with latency 100 and 200
    emitDiagnosticProcessed({ success: true, totalDurationMs: 100 });
    emitDiagnosticProcessed({ success: true, totalDurationMs: 200 });
    // 1 failure with latency 50
    emitDiagnosticProcessed({ success: false, totalDurationMs: 50, finishReason: "error" });

    const stats = tracer.getStats();
    expect(stats.total).toBe(3);
    expect(stats.successes).toBe(2);
    expect(stats.failures).toBe(1);
    // Average: (100 + 200 + 50) / 3 = 116.67 -> rounds to 117
    expect(stats.avgLatencyMs).toBe(117);
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
    emitSent("ch-new");

    // Still only 1 record from before dispose
    expect(tracer.getRecent({ limit: 100 })).toHaveLength(1);
    expect(tracer.getRecent()[0]!.sourceChannelId).toBe("ch-before");
  });
});
