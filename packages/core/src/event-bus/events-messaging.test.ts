// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
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
    // "spend_exceeded" is a member of the
    // closed execution:aborted.reason union (the dollars kill-switch abort) —
    // if the union at events-messaging.ts loses it, the typed
    // payload below fails to COMPILE for that literal.
    // "denial_breaker" follows the same pattern —
    // the denial-limit breaker abort (distinct from circuit_breaker, the
    // tool-failure breaker); dropping it from the union makes the typed
    // payload for that literal fail to COMPILE.
    const reasons = [
      "user_stop",
      "budget_exceeded",
      "circuit_breaker",
      "max_steps",
      "context_exhausted",
      "pipeline_timeout",
      "loop_detected",
      "spend_exceeded",
      "denial_breaker",
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

    expect(handler).toHaveBeenCalledTimes(9);
    expect(handler.mock.calls[0]![0].reason).toBe("user_stop");
    expect(handler.mock.calls[4]![0].reason).toBe("context_exhausted");
    expect(handler.mock.calls[5]![0].reason).toBe("pipeline_timeout");
    expect(handler.mock.calls[6]![0].reason).toBe("loop_detected");
    // The dollars-kill-switch abort reason (distinct from the
    // token-budget "budget_exceeded" so the dollars-vs-tokens cause stays clear).
    expect(handler.mock.calls[7]![0].reason).toBe("spend_exceeded");
    // The denial-limit breaker abort (N consecutive floor-blocks tripped
    // the breaker; distinct from circuit_breaker, which is the tool-failure breaker).
    expect(handler.mock.calls[8]![0].reason).toBe("denial_breaker");
  });

  it("execution:aborted reason stays a CLOSED union (rejects a non-member literal)", () => {
    const bus = new TypedEventBus();
    bus.emit("execution:aborted", {
      sessionKey: testSessionKey,
      // @ts-expect-error - "spend_unpriceable" is NOT an abort-reason member; the
      // distinct observability:spend_unpriceable EVENT carries that nuance.
      reason: "spend_unpriceable",
      agentId: "agent-1",
      timestamp: Date.now(),
    });
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

  it("context:dag_compacted delivers DAG compaction metrics (sibling shape)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["context:dag_compacted"] = {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      leafSummariesCreated: 3,
      condensedSummariesCreated: 1,
      maxDepthReached: 2,
      totalSummariesCreated: 4,
      durationMs: 120,
      timestamp: now,
    };

    bus.on("context:dag_compacted", handler);
    bus.emit("context:dag_compacted", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["context:dag_compacted"];
    expect(received.conversationId).toBe("conv-1");
    expect(received.totalSummariesCreated).toBe(4);
  });

  it("context:thinking_downshifted is declared with a closed transition payload", () => {
    const source = readFileSync(new URL("./events-messaging.ts", import.meta.url), "utf8");
    const block = source.match(/"context:thinking_downshifted":\s*\{[\s\S]*?\n\s*\};/);

    expect(block, "context:thinking_downshifted must be part of MessagingEvents").not.toBeNull();
    expect(block![0]).toMatch(/agentId:\s*string/);
    expect(block![0]).toMatch(
      /originalThinkingLevel:\s*"off"\s*\|\s*"minimal"\s*\|\s*"low"\s*\|\s*"medium"\s*\|\s*"high"\s*\|\s*"xhigh"/,
    );
    expect(block![0]).toMatch(
      /effectiveThinkingLevel:\s*"off"\s*\|\s*"minimal"\s*\|\s*"low"\s*\|\s*"medium"\s*\|\s*"high"\s*\|\s*"xhigh"/,
    );
  });

  it("context:thinking_downshifted delivers the reasoning-level transition", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["context:thinking_downshifted"] = {
      agentId: "agent_a",
      originalThinkingLevel: "high",
      effectiveThinkingLevel: "medium",
    };

    bus.on("context:thinking_downshifted", handler);
    bus.emit("context:thinking_downshifted", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["context:thinking_downshifted"];
    expect(received.agentId).toBe("agent_a");
    expect(received.originalThinkingLevel).toBe("high");
    expect(received.effectiveThinkingLevel).toBe("medium");
  });

  it("context:dag_expanded delivers in-session expansion-hit metrics (ids/counts/durationMs only)", () => {
    // A dedicated content-free expansion-hit event emitted by the three
    // ctx_* tools on a hit. Closed `tool` union; recovered/hit count; durationMs.
    // NEVER message or summary content (the lossless store; AGENTS.md §2.2/§2.7).
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["context:dag_expanded"] = {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      tool: "ctx_expand",
      recoveredCount: 7,
      durationMs: 12,
      timestamp: now,
    };

    bus.on("context:dag_expanded", handler);
    bus.emit("context:dag_expanded", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["context:dag_expanded"];
    expect(received.conversationId).toBe("conv-1");
    expect(received.tool).toBe("ctx_expand");
    expect(received.recoveredCount).toBe(7);
    expect(received.durationMs).toBe(12);
    expect(received.timestamp).toBe(now);
  });

  // context:mode_switched carries the switch DIRECTION
  // (closed "pipeline" | "dag" union) plus the one-time import COST
  // (fullImport / importedCount / durationMs) + correlation ids. Mirrors
  // context:dag_compacted (identifiers + counts + durations only — NO message
  // text). Emitted from the @comis/agent DAG reconciliation seam.
  it("context:mode_switched payload shape: direction union + import cost", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    const payload: EventMap["context:mode_switched"] = {
      from: "pipeline",
      to: "dag",
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      fullImport: true,
      importedCount: 42,
      durationMs: 85,
      timestamp: now,
    };

    bus.on("context:mode_switched", handler);
    bus.emit("context:mode_switched", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["context:mode_switched"];
    expect(received.from).toBe("pipeline");
    expect(received.to).toBe("dag");
    expect(received.conversationId).toBe("conv-1");
    expect(received.agentId).toBe("agent-1");
    expect(received.sessionKey).toBe("default:user1:channel1");
    expect(received.fullImport).toBe(true);
    expect(received.importedCount).toBe(42);
    expect(received.durationMs).toBe(85);
    expect(received.timestamp).toBe(now);
  });

  it("context:mode_switched accepts the reverse direction (dag -> pipeline, incremental)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["context:mode_switched"] = {
      from: "dag",
      to: "pipeline",
      conversationId: "conv-2",
      agentId: "agent-2",
      sessionKey: "default:user2:channel2",
      fullImport: false,
      importedCount: 0,
      durationMs: 3,
      timestamp: Date.now(),
    };

    bus.on("context:mode_switched", handler);
    bus.emit("context:mode_switched", payload);

    const received = handler.mock.calls[0]![0] as EventMap["context:mode_switched"];
    expect(received.from).toBe("dag");
    expect(received.to).toBe("pipeline");
    expect(received.fullImport).toBe(false);
  });

  it("type safety: @ts-expect-error for missing required fields", () => {
    const bus = new TypedEventBus();

    // @ts-expect-error - missing sessionKey in message:received
    bus.emit("message:received", { message: testMessage });

    // @ts-expect-error - missing content in message:sent
    bus.emit("message:sent", { channelId: "c1", messageId: "m1" });
  });

  // The content-free margin-arbiter observability event.
  // If `context:arbitrated` leaves EventMap, the typed payload
  // below fails to COMPILE (a compile failure is the guard for
  // a closed event contract). Payload is per-tier kept COUNTS + discretionary
  // pool TOKENS + a relevanceFirst BOOLEAN + ids/timestamp ONLY — NEVER message,
  // memory, or query content (the lossless store; AGENTS.md §2.2/§2.7).
  it("context:arbitrated delivers per-tier kept counts + pool tokens (offered+consumed) + floor + ids + relevanceFirst (content-free)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const now = Date.now();
    // The payload distinguishes the pool OFFERED from CONSUMED,
    // carries the floor-token weight, and the kept LTM/KG ids — all content-free.
    const payload: EventMap["context:arbitrated"] = {
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      perTierKept: { history: 4, ltm: 1, kg: 0 },
      discretionaryPoolTokens: 12_000,
      poolTokensUsed: 9_500,
      floorTokens: 800,
      keptLtmIds: ["mem-ltm-1"],
      keptKgIds: [],
      relevanceFirst: true,
      timestamp: now,
    };

    bus.on("context:arbitrated", handler);
    bus.emit("context:arbitrated", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["context:arbitrated"];
    expect(received.agentId).toBe("agent-1");
    expect(received.perTierKept.history).toBe(4);
    expect(received.perTierKept.ltm).toBe(1);
    expect(received.discretionaryPoolTokens).toBe(12_000);
    // Consumed is reported distinctly from offered, plus the floor weight.
    expect(received.poolTokensUsed).toBe(9_500);
    expect(received.floorTokens).toBe(800);
    expect(received.poolTokensUsed).toBeLessThanOrEqual(received.discretionaryPoolTokens);
    // The kept cross-tier ids (content-free memory keys).
    expect(received.keptLtmIds).toEqual(["mem-ltm-1"]);
    expect(received.keptKgIds).toEqual([]);
    expect(received.relevanceFirst).toBe(true);
    expect(received.timestamp).toBe(now);
  });

  it("type safety: context:arbitrated rejects a content-bearing field (content-free contract)", () => {
    const bus = new TypedEventBus();
    bus.emit("context:arbitrated", {
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      perTierKept: { history: 1 },
      discretionaryPoolTokens: 100,
      poolTokensUsed: 80,
      floorTokens: 0,
      keptLtmIds: [],
      keptKgIds: [],
      relevanceFirst: false,
      timestamp: Date.now(),
      // @ts-expect-error - the event is content-free; no message/query text field exists
      messageText: "leaked content",
    });
  });

  // Closed-union guard: from/to are the literal
  // "pipeline" | "dag" union — an arbitrary string is a COMPILE error, not a
  // runtime discriminator. These @ts-expect-error lines fail to compile if the
  // member is ever widened to `string`.
  it("type safety: context:mode_switched from/to reject non-union strings", () => {
    const bus = new TypedEventBus();

    bus.emit("context:mode_switched", {
      // @ts-expect-error - "nope" is not a member of the "pipeline" | "dag" union
      from: "nope",
      to: "dag",
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      fullImport: true,
      importedCount: 1,
      durationMs: 1,
      timestamp: Date.now(),
    });

    bus.emit("context:mode_switched", {
      from: "pipeline",
      // @ts-expect-error - "legacy" is not a member of the "pipeline" | "dag" union
      to: "legacy",
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      fullImport: true,
      importedCount: 1,
      durationMs: 1,
      timestamp: Date.now(),
    });

    // @ts-expect-error - missing the from/to direction fields entirely
    bus.emit("context:mode_switched", {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "default:user1:channel1",
      fullImport: true,
      importedCount: 1,
      durationMs: 1,
      timestamp: Date.now(),
    });
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
// session:sub_agent_progress (the 30s read-only progress fork)
// ---------------------------------------------------------------------------
//
// The content-free advance signal a long-running child surfaces every ~30s via
// the read-only progress fork (coordinator-progress-fork.ts). If the
// `session:sub_agent_progress` member leaves the MessagingEvents map,
// the typed payload below fails to COMPILE (a compile failure is the guard
// for a closed type contract). §2.7 content-free: the shape carries
// ONLY runId/agentId/a short progressLine/counts/timestamp — NO field is allowed
// to carry the child's output, message body, or tool result.

describe("session:sub_agent_progress payload structure (content-free)", () => {
  it("delivers runId, agentId, progressLine, elapsedMs, stepsExecuted, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:sub_agent_progress"] = {
      runId: "run-progress-001",
      agentId: "child-agent-7",
      progressLine: "running, step 4",
      elapsedMs: 30_000,
      stepsExecuted: 4,
      timestamp: Date.now(),
    };

    bus.on("session:sub_agent_progress", handler);
    bus.emit("session:sub_agent_progress", payload);

    expect(handler).toHaveBeenCalledOnce();
    const received = handler.mock.calls[0]![0] as EventMap["session:sub_agent_progress"];
    expect(received.runId).toBe("run-progress-001");
    expect(received.agentId).toBe("child-agent-7");
    expect(received.progressLine).toBe("running, step 4");
    expect(received.elapsedMs).toBe(30_000);
    expect(received.stepsExecuted).toBe(4);
    expect(typeof received.timestamp).toBe("number");
  });

  it("is content-free: the payload exposes ONLY the bounded status keys (no child output/body)", () => {
    // §2.7: the only keys the event may carry are the 6 bounded
    // status fields. A `response`/`output`/`message`/`body`/`toolResult` key
    // would leak the child's content into the lead's window — assert the key set
    // is exactly the allow-list so a future widening that adds a payload field is
    // caught here.
    const payload: EventMap["session:sub_agent_progress"] = {
      runId: "r1",
      agentId: "a1",
      progressLine: "running tools, step 2",
      elapsedMs: 60_000,
      stepsExecuted: 2,
      timestamp: 1000,
    };
    expect(Object.keys(payload).sort()).toEqual(
      ["agentId", "elapsedMs", "progressLine", "runId", "stepsExecuted", "timestamp"].sort(),
    );
    // No content-bearing field exists on the typed shape.
    expect(payload).not.toHaveProperty("response");
    expect(payload).not.toHaveProperty("output");
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("toolResult");
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

// ---------------------------------------------------------------------------
// context:dag_degraded reason union — the LCD-divergence literals
// ---------------------------------------------------------------------------
//
// The closed `reason` union carries the 3 LCD-divergence literals so the
// lcd-ingest shrink skip + the leaf/condense ordinal-window skips can
// emit `context:dag_degraded` (persisted as a `health_signal` row). If a
// literal leaves the union, the corresponding payload value fails to
// COMPILE (a compile failure is the guard for a closed
// type contract). The union stays CLOSED (string literals only) — §2.8-compliant.

describe("context:dag_degraded reason union (divergence literals)", () => {
  function emitWithReason(reason: EventMap["context:dag_degraded"]["reason"]): EventMap["context:dag_degraded"]["reason"] {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["context:dag_degraded"] = {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "sess-1",
      reason,
      durationMs: 5,
      timestamp: 1000,
    };
    bus.on("context:dag_degraded", handler);
    bus.emit("context:dag_degraded", payload);
    const received = handler.mock.calls[0]![0] as EventMap["context:dag_degraded"];
    return received.reason;
  }

  it("accepts the 3 new divergence reasons (live/leaf/condense window divergence)", () => {
    // RED on pre-patch: these literals are not in the closed union → the typed
    // payload above fails to type-check for each.
    expect(emitWithReason("live_store_divergence")).toBe("live_store_divergence");
    expect(emitWithReason("leaf_window_divergence")).toBe("leaf_window_divergence");
    expect(emitWithReason("condense_window_divergence")).toBe("condense_window_divergence");
  });

  it("still accepts the 4 pre-existing reasons (additive widen — no member removed, no-BC)", () => {
    expect(emitWithReason("fail_closed_rollover")).toBe("fail_closed_rollover");
    expect(emitWithReason("serialized_wait")).toBe("serialized_wait");
    expect(emitWithReason("breaker_open")).toBe("breaker_open");
    expect(emitWithReason("spend_cap")).toBe("spend_cap");
  });
});
