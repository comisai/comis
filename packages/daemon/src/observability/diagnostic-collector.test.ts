// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDiagnosticCollector,
  type DiagnosticCollector,
} from "./diagnostic-collector.js";

describe("createDiagnosticCollector", () => {
  let bus: TypedEventBus;
  let collector: DiagnosticCollector;

  beforeEach(() => {
    bus = new TypedEventBus();
    collector = createDiagnosticCollector({ eventBus: bus });
  });

  it("collects events from EventBus subscriptions", () => {
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "t1",
      agentId: "agent-1",
      channelId: "ch-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.003, output: 0.015, total: 0.018 },
      latencyMs: 1200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const recent = collector.getRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.category).toBe("usage");
    expect(recent[0]!.eventType).toBe("observability:token_usage");
    expect(recent[0]!.agentId).toBe("agent-1");
    expect(recent[0]!.channelId).toBe("ch-1");
  });

  it("categorizes message events correctly", () => {
    bus.emit("message:received", {
      message: {
        id: "msg-1",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        senderName: "User",
        chatId: "chat-1",
        chatType: "private",
        text: "hello",
        timestamp: Date.now(),
        raw: {},
      },
      sessionKey: {
        tenantId: "default",
        userId: "user-1",
        channelId: "ch-1",
      },
    });

    bus.emit("message:sent", {
      channelId: "ch-2",
      messageId: "msg-2",
      content: "reply",
    });

    const recent = collector.getRecent({ category: "message" });
    expect(recent).toHaveLength(2);
    expect(recent.every((e) => e.category === "message")).toBe(true);
  });

  it("categorizes session events correctly", () => {
    bus.emit("session:created", {
      sessionKey: {
        tenantId: "default",
        userId: "user-1",
        channelId: "ch-1",
      },
      timestamp: Date.now(),
    });

    const recent = collector.getRecent({ category: "session" });
    expect(recent).toHaveLength(1);
    expect(recent[0]!.category).toBe("session");
    expect(recent[0]!.sessionKey).toBe("default:user-1:ch-1");
  });

  it("ring buffer evicts oldest when full", () => {
    const small = createDiagnosticCollector({ eventBus: bus, maxEvents: 3 });

    for (let i = 0; i < 5; i++) {
      bus.emit("observability:token_usage", {
        timestamp: Date.now() + i,
        traceId: `t-${i}`,
        agentId: `agent-${i}`,
        channelId: "ch-1",
        executionId: `exec-${i}`,
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost: { input: 0.003, output: 0.015, total: 0.018 },
        latencyMs: 1200,
      });
    }

    // small collector should only have last 3
    const recent = small.getRecent({ limit: 100 });
    expect(recent).toHaveLength(3);

    // Newest first: agent-4, agent-3, agent-2
    expect(recent[0]!.agentId).toBe("agent-4");
    expect(recent[1]!.agentId).toBe("agent-3");
    expect(recent[2]!.agentId).toBe("agent-2");

    small.dispose();
  });

  it("getRecent filters by category", () => {
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "t1",
      agentId: "agent-1",
      channelId: "ch-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0.003, output: 0.015, total: 0.018 },
      latencyMs: 1200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    bus.emit("message:sent", {
      channelId: "ch-2",
      messageId: "msg-1",
      content: "hello",
    });

    bus.emit("session:created", {
      sessionKey: { tenantId: "default", userId: "u1", channelId: "ch-1" },
      timestamp: Date.now(),
    });

    expect(collector.getRecent({ category: "usage" })).toHaveLength(1);
    expect(collector.getRecent({ category: "message" })).toHaveLength(1);
    expect(collector.getRecent({ category: "session" })).toHaveLength(1);
    expect(collector.getRecent({ category: "webhook" })).toHaveLength(0);
  });

  it("getRecent filters by sinceMs", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    // Emit an event with old timestamp
    bus.emit("observability:token_usage", {
      timestamp: now - 60_000,
      traceId: "old",
      agentId: "a1",
      channelId: "ch-1",
      executionId: "e1",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // Emit a recent event
    bus.emit("observability:token_usage", {
      timestamp: now - 5_000,
      traceId: "recent",
      agentId: "a2",
      channelId: "ch-1",
      executionId: "e2",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // Filter to last 30 seconds
    const filtered = collector.getRecent({ sinceMs: 30_000 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.agentId).toBe("a2");

    vi.useRealTimers();
  });

  it("getRecent respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      bus.emit("observability:token_usage", {
        timestamp: Date.now() + i,
        traceId: `t-${i}`,
        agentId: `agent-${i}`,
        channelId: "ch-1",
        executionId: `exec-${i}`,
        provider: "anthropic",
        model: "claude-sonnet-4-5-20250929",
        tokens: { prompt: 100, completion: 50, total: 150 },
        cost: { input: 0.003, output: 0.015, total: 0.018 },
        latencyMs: 1200,
      });
    }

    const limited = collector.getRecent({ limit: 3 });
    expect(limited).toHaveLength(3);
    // Should be newest first
    expect(limited[0]!.agentId).toBe("agent-9");
    expect(limited[1]!.agentId).toBe("agent-8");
    expect(limited[2]!.agentId).toBe("agent-7");
  });

  it("getCounts returns accurate per-category counts", () => {
    // 2 usage events
    for (let i = 0; i < 2; i++) {
      bus.emit("observability:token_usage", {
        timestamp: Date.now(),
        traceId: `t-${i}`,
        agentId: "a1",
        channelId: "ch-1",
        executionId: `e-${i}`,
        provider: "p",
        model: "m",
        tokens: { prompt: 1, completion: 1, total: 2 },
        cost: { input: 0, output: 0, total: 0 },
        latencyMs: 100,
      });
    }

    // 3 message events
    for (let i = 0; i < 3; i++) {
      bus.emit("message:sent", {
        channelId: `ch-${i}`,
        messageId: `msg-${i}`,
        content: "hi",
      });
    }

    // 1 session event
    bus.emit("session:created", {
      sessionKey: { tenantId: "default", userId: "u1", channelId: "ch-1" },
      timestamp: Date.now(),
    });

    const counts = collector.getCounts();
    expect(counts.usage).toBe(2);
    expect(counts.message).toBe(3);
    expect(counts.session).toBe(1);
    expect(counts.webhook).toBe(0);
  });

  it("prune removes old events", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    // Emit events with old and new timestamps
    bus.emit("observability:token_usage", {
      timestamp: now - 120_000,
      traceId: "old1",
      agentId: "a1",
      channelId: "ch-1",
      executionId: "e1",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    bus.emit("observability:token_usage", {
      timestamp: now - 90_000,
      traceId: "old2",
      agentId: "a2",
      channelId: "ch-1",
      executionId: "e2",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    bus.emit("observability:token_usage", {
      timestamp: now - 10_000,
      traceId: "recent",
      agentId: "a3",
      channelId: "ch-1",
      executionId: "e3",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    // Prune events older than 60 seconds
    const removed = collector.prune(60_000);
    expect(removed).toBe(2);
    expect(collector.getRecent({ limit: 100 })).toHaveLength(1);
    expect(collector.getRecent()[0]!.agentId).toBe("a3");

    vi.useRealTimers();
  });

  it("reset clears all events", () => {
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "t1",
      agentId: "a1",
      channelId: "ch-1",
      executionId: "e1",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    bus.emit("session:created", {
      sessionKey: { tenantId: "default", userId: "u1", channelId: "ch-1" },
      timestamp: Date.now(),
    });

    expect(collector.getRecent({ limit: 100 })).toHaveLength(2);

    collector.reset();

    expect(collector.getRecent({ limit: 100 })).toHaveLength(0);
    expect(collector.getCounts()).toEqual({
      usage: 0,
      webhook: 0,
      message: 0,
      session: 0,
    });
  });

  it("dispose unsubscribes from EventBus", () => {
    // Emit before dispose
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "before",
      agentId: "a1",
      channelId: "ch-1",
      executionId: "e1",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(collector.getRecent()).toHaveLength(1);

    collector.dispose();

    // Emit after dispose -- should NOT be collected
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "after",
      agentId: "a2",
      channelId: "ch-1",
      executionId: "e2",
      provider: "p",
      model: "m",
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, total: 0 },
      latencyMs: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    bus.emit("message:sent", {
      channelId: "ch-1",
      messageId: "msg-1",
      content: "hi",
    });

    // Still only 1 event from before dispose
    expect(collector.getRecent({ limit: 100 })).toHaveLength(1);
    expect(collector.getRecent()[0]!.agentId).toBe("a1");
  });
});
