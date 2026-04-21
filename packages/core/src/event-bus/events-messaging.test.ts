// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const testSessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
const testMessage = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  channelId: "c1",
  channelType: "telegram" as const,
  senderId: "u1",
  text: "hello",
  timestamp: Date.now(),
  attachments: [],
  metadata: {},
};

describe("MessagingEvents payload structure", () => {
  it("message:received delivers NormalizedMessage + SessionKey", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on("message:received", handler);
    bus.emit("message:received", { message: testMessage, sessionKey: testSessionKey });

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]![0] as EventMap["message:received"];
    expect(payload.message.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(payload.message.channelType).toBe("telegram");
    expect(payload.message.text).toBe("hello");
    expect(payload.message.attachments).toEqual([]);
    expect(payload.sessionKey.tenantId).toBe("t1");
    expect(payload.sessionKey.userId).toBe("u1");
    expect(payload.sessionKey.channelId).toBe("c1");
  });

  it("message:sent delivers channelId, messageId, content", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["message:sent"] = {
      channelId: "c1",
      messageId: "msg-001",
      content: "Reply text",
    };

    bus.on("message:sent", handler);
    bus.emit("message:sent", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["message:sent"];
    expect(received.channelId).toBe("c1");
    expect(received.messageId).toBe("msg-001");
    expect(received.content).toBe("Reply text");
  });

  it("message:streaming delivers delta + accumulated", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["message:streaming"] = {
      channelId: "c1",
      messageId: "msg-002",
      delta: "world",
      accumulated: "hello world",
    };

    bus.on("message:streaming", handler);
    bus.emit("message:streaming", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["message:streaming"];
    expect(received.delta).toBe("world");
    expect(received.accumulated).toBe("hello world");
  });

  it("session:created delivers sessionKey + timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["session:created"] = {
      sessionKey: testSessionKey,
      timestamp: now,
    };

    bus.on("session:created", handler);
    bus.emit("session:created", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["session:created"];
    expect(received.sessionKey).toEqual(testSessionKey);
    expect(received.timestamp).toBe(now);
  });

  it("session:expired delivers sessionKey + reason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:expired"] = {
      sessionKey: testSessionKey,
      reason: "idle_timeout",
    };

    bus.on("session:expired", handler);
    bus.emit("session:expired", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["session:expired"];
    expect(received.reason).toBe("idle_timeout");
  });

  it("session:cross_send delivers mode union type", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();

    for (const mode of ["fire-and-forget", "wait", "ping-pong"] as const) {
      const payload: EventMap["session:cross_send"] = {
        fromSessionKey: "session-a",
        toSessionKey: "session-b",
        mode,
        timestamp: now,
      };
      bus.on("session:cross_send", handler);
      bus.emit("session:cross_send", payload);
      bus.removeAllListeners("session:cross_send");
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0].mode).toBe("fire-and-forget");
    expect(handler.mock.calls[1]![0].mode).toBe("wait");
    expect(handler.mock.calls[2]![0].mode).toBe("ping-pong");
  });

  it("session:sub_agent_spawned delivers runId, parentSessionKey, agentId, task", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_spawned"] = {
      runId: "run-001",
      parentSessionKey: "parent-session",
      agentId: "sub-agent-1",
      task: "summarize conversation",
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_spawned", handler);
    bus.emit("session:sub_agent_spawned", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_spawned"];
    expect(received.runId).toBe("run-001");
    expect(received.parentSessionKey).toBe("parent-session");
    expect(received.agentId).toBe("sub-agent-1");
    expect(received.task).toBe("summarize conversation");
  });

  it("compaction:started delivers agentId, sessionKey, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["compaction:started"] = {
      agentId: "agent-1",
      sessionKey: testSessionKey,
      timestamp: now,
    };

    bus.on("compaction:started", handler);
    bus.emit("compaction:started", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["compaction:started"];
    expect(received.agentId).toBe("agent-1");
    expect(received.sessionKey).toEqual(testSessionKey);
  });

  it("compaction:recommended delivers contextPercent, contextTokens, contextWindow", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["compaction:recommended"] = {
      agentId: "agent-1",
      sessionKey: testSessionKey,
      contextPercent: 92.5,
      contextTokens: 185000,
      contextWindow: 200000,
      timestamp: Date.now(),
    };

    bus.on("compaction:recommended", handler);
    bus.emit("compaction:recommended", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["compaction:recommended"];
    expect(received.contextPercent).toBe(92.5);
    expect(received.contextTokens).toBe(185000);
    expect(received.contextWindow).toBe(200000);
  });

  it("execution:aborted delivers reason union type", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const reasons = [
      "user_stop",
      "budget_exceeded",
      "circuit_breaker",
      "max_steps",
      "context_exhausted",
      "pipeline_timeout",
    ] as const;

    for (const reason of reasons) {
      const payload: EventMap["execution:aborted"] = {
        sessionKey: testSessionKey,
        reason,
        agentId: "agent-1",
        timestamp: Date.now(),
      };
      bus.on("execution:aborted", handler);
      bus.emit("execution:aborted", payload);
      bus.removeAllListeners("execution:aborted");
    }

    expect(handler).toHaveBeenCalledTimes(6);
    expect(handler.mock.calls[0]![0].reason).toBe("user_stop");
    expect(handler.mock.calls[4]![0].reason).toBe("context_exhausted");
    expect(handler.mock.calls[5]![0].reason).toBe("pipeline_timeout");
  });

  it("execution:prompt_timeout delivers agentId, sessionKey, timeoutMs", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["execution:prompt_timeout"] = {
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      timeoutMs: 180_000,
      timestamp: Date.now(),
    };
    bus.on("execution:prompt_timeout", handler);
    bus.emit("execution:prompt_timeout", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["execution:prompt_timeout"];
    expect(received.agentId).toBe("agent-1");
    expect(received.timeoutMs).toBe(180_000);
  });

  it("announcement:dead_lettered delivers runId, channelType, reason, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["announcement:dead_lettered"] = {
      runId: "run-dlq-001",
      channelType: "telegram",
      reason: "connection_timeout",
      timestamp: now,
    };

    bus.on("announcement:dead_lettered", handler);
    bus.emit("announcement:dead_lettered", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["announcement:dead_lettered"];
    expect(received.runId).toBe("run-dlq-001");
    expect(received.channelType).toBe("telegram");
    expect(received.reason).toBe("connection_timeout");
    expect(received.timestamp).toBe(now);
  });

  it("announcement:dead_letter_delivered delivers runId, channelType, attemptCount, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["announcement:dead_letter_delivered"] = {
      runId: "run-dlq-002",
      channelType: "discord",
      attemptCount: 3,
      timestamp: now,
    };

    bus.on("announcement:dead_letter_delivered", handler);
    bus.emit("announcement:dead_letter_delivered", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["announcement:dead_letter_delivered"];
    expect(received.runId).toBe("run-dlq-002");
    expect(received.channelType).toBe("discord");
    expect(typeof received.attemptCount).toBe("number");
    expect(received.attemptCount).toBe(3);
    expect(received.timestamp).toBe(now);
  });

  it("type safety: @ts-expect-error for missing required fields", () => {
    const bus = new TypedEventBus();

    // @ts-expect-error - missing sessionKey in message:received
    bus.emit("message:received", { message: testMessage });

    // @ts-expect-error - missing content in message:sent
    bus.emit("message:sent", { channelId: "c1", messageId: "m1" });
  });
});

// ---------------------------------------------------------------------------
// Subagent context lifecycle events
// ---------------------------------------------------------------------------

describe("Subagent context lifecycle events", () => {
  it("session:sub_agent_spawn_prepared delivers rich payload", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_spawn_prepared"] = {
      runId: "run-spawn-001",
      parentSessionKey: "parent-session",
      agentId: "sub-agent-1",
      task: "analyze codebase",
      depth: 1,
      maxDepth: 3,
      artifactCount: 5,
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_spawn_prepared", handler);
    bus.emit("session:sub_agent_spawn_prepared", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_spawn_prepared"];
    expect(received.runId).toBe("run-spawn-001");
    expect(received.parentSessionKey).toBe("parent-session");
    expect(received.agentId).toBe("sub-agent-1");
    expect(received.task).toBe("analyze codebase");
    expect(received.depth).toBe(1);
    expect(received.maxDepth).toBe(3);
    expect(received.artifactCount).toBe(5);
  });

  it("session:sub_agent_result_condensed delivers condensation data", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_result_condensed"] = {
      runId: "run-cond-001",
      agentId: "sub-agent-1",
      level: 2,
      originalTokens: 8000,
      condensedTokens: 3500,
      compressionRatio: 0.4375,
      taskComplete: true,
      diskPath: "/tmp/results/run-cond-001.json",
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_result_condensed", handler);
    bus.emit("session:sub_agent_result_condensed", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_result_condensed"];
    expect(received.level).toBe(2);
    expect(received.compressionRatio).toBe(0.4375);
    expect(received.originalTokens).toBe(8000);
    expect(received.condensedTokens).toBe(3500);
    expect(received.taskComplete).toBe(true);
    expect(received.diskPath).toBe("/tmp/results/run-cond-001.json");
  });

  it("session:sub_agent_lifecycle_ended includes end reason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_lifecycle_ended"] = {
      runId: "run-end-001",
      agentId: "sub-agent-1",
      parentSessionKey: "parent-session",
      endReason: "completed",
      durationMs: 15000,
      tokensUsed: 12000,
      cost: 0.036,
      condensationLevel: 1,
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_lifecycle_ended", handler);
    bus.emit("session:sub_agent_lifecycle_ended", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_lifecycle_ended"];
    expect(received.endReason).toBe("completed");
    expect(received.durationMs).toBe(15000);
    expect(received.tokensUsed).toBe(12000);
    expect(received.cost).toBe(0.036);
    expect(received.condensationLevel).toBe(1);
  });

  it("session:sub_agent_spawn_rejected delivers rejection reason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_spawn_rejected"] = {
      parentSessionKey: "parent-session",
      agentId: "sub-agent-deep",
      task: "go deeper",
      reason: "depth_exceeded",
      currentDepth: 3,
      maxDepth: 3,
      currentChildren: 2,
      maxChildren: 5,
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_spawn_rejected", handler);
    bus.emit("session:sub_agent_spawn_rejected", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_spawn_rejected"];
    expect(received.reason).toBe("depth_exceeded");
    expect(received.currentDepth).toBe(3);
    expect(received.maxDepth).toBe(3);
  });

  it("session:sub_agent_spawn_queued delivers all fields", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_spawn_queued"] = {
      runId: "run-queued-001",
      parentSessionKey: "parent-session",
      agentId: "sub-agent-1",
      task: "queued task",
      queuePosition: 2,
      activeChildren: 5,
      maxChildren: 5,
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_spawn_queued", handler);
    bus.emit("session:sub_agent_spawn_queued", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_spawn_queued"];
    expect(received.runId).toBe("run-queued-001");
    expect(received.parentSessionKey).toBe("parent-session");
    expect(received.agentId).toBe("sub-agent-1");
    expect(received.task).toBe("queued task");
    expect(received.queuePosition).toBe(2);
    expect(received.activeChildren).toBe(5);
    expect(received.maxChildren).toBe(5);
  });

  it("existing sub_agent_spawned event still works (regression guard)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_spawned"] = {
      runId: "run-legacy-001",
      parentSessionKey: "parent-session",
      agentId: "sub-agent-1",
      task: "summarize conversation",
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_spawned", handler);
    bus.emit("session:sub_agent_spawned", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_spawned"];
    expect(received.runId).toBe("run-legacy-001");
    expect(received.task).toBe("summarize conversation");
  });
});

// ---------------------------------------------------------------------------
// Config nesting integration
// ---------------------------------------------------------------------------

import { SecurityConfigSchema } from "../config/schema-security.js";

describe("Config nesting integration", () => {
  it("SecurityConfigSchema includes subagentContext with defaults", () => {
    const config = SecurityConfigSchema.parse({});
    expect(config.agentToAgent.subagentContext.maxSpawnDepth).toBe(3);
    expect(config.agentToAgent.subagentContext.maxChildrenPerAgent).toBe(5);
    expect(config.agentToAgent.subagentContext.maxResultTokens).toBe(4_000);
    expect(config.agentToAgent.subagentContext.condensationStrategy).toBe("auto");
    expect(config.agentToAgent.subagentContext.objectiveReinforcement).toBe(true);
    expect(config.agentToAgent.subagentContext.resultRetentionMs).toBe(86_400_000);
  });

  it("existing agentToAgent fields preserved", () => {
    const config = SecurityConfigSchema.parse({});
    expect(config.agentToAgent.enabled).toBe(true);
    expect(config.agentToAgent.maxPingPongTurns).toBe(3);
    expect(config.agentToAgent.subAgentMaxSteps).toBe(50);
    expect(config.agentToAgent.subAgentMcpTools).toBe("inherit");
  });

  it("subagentContext overrides merge with defaults", () => {
    const config = SecurityConfigSchema.parse({
      agentToAgent: {
        subagentContext: {
          maxSpawnDepth: 5,
          condensationStrategy: "always",
        },
      },
    });
    expect(config.agentToAgent.subagentContext.maxSpawnDepth).toBe(5);
    expect(config.agentToAgent.subagentContext.condensationStrategy).toBe("always");
    // Other defaults still applied
    expect(config.agentToAgent.subagentContext.maxChildrenPerAgent).toBe(5);
    expect(config.agentToAgent.subagentContext.maxResultTokens).toBe(4_000);
  });
});
