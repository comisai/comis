// SPDX-License-Identifier: Apache-2.0
/**
 * Event-bus bridge tests.
 *
 * The bridge subscribes to the typed EventBus and translates each
 * mapped event into a trajectory `recordEvent` call. Mappings are
 * verified against EventMap declarations in
 * packages/core/src/event-bus/events-agent.ts and events-channel.ts.
 *
 * Coverage (10 behavior-named cases):
 *   - tool_started_maps_to_tool.call
 *   - tool_executed_maps_to_tool.result
 *   - tool_timeout_event_maps_to_tool.timeout
 *   - model_fallback_attempt_maps
 *   - lkw_fallback_attempt_has_lkw_flag
 *   - observability_token_usage_maps_to_model.completed
 *   - delivery_enqueued_maps_to_delivery.queued
 *   - delivery_complete_maps_to_delivery.dispatched
 *   - unsubscribe_stops_recording
 *   - filter_excludes_events
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "@comis/core";
import type { EventMap } from "@comis/core";

import { attachTrajectoryToEventBus, TRAJECTORY_BRIDGE_MAPPING } from "./event-bus-bridge.js";
import type { TrajectoryEventType, TrajectoryRecorder } from "./types.js";

// ---------------------------------------------------------------------------
// Test-double recorder — records the calls into a captured array
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly type: TrajectoryEventType;
  readonly data: unknown;
  readonly parentEntryId: string | undefined;
}

function createCaptureRecorder(filePath = "/tmp/x.jsonl"): TrajectoryRecorder & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    filePath,
    recordEvent: vi.fn(
      (type: TrajectoryEventType, data: unknown, parentEntryId?: string) => {
        calls.push({ type, data, parentEntryId });
        return "queued" as const;
      },
    ),
    flush: vi.fn(async () => undefined),
    flushAndClose: vi.fn(async () => undefined),
    calls,
  };
}

function makeBus(): TypedEventBus {
  return new TypedEventBus();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachTrajectoryToEventBus -- tool events", () => {
  it("tool_started_maps_to_tool.call with toolName + toolCallId; correlation keys stripped from data (design §6.2)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:started", {
      toolName: "bash",
      toolCallId: "tc-1",
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-1",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.call");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.toolName).toBe("bash");
    expect(data.toolCallId).toBe("tc-1");
    // Envelope-only correlation keys (deviation C) — must NOT appear in data.
    expect(data.traceId).toBeUndefined();
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.sessionId).toBeUndefined();
  });

  it("tool_executed_maps_to_tool.result with durationMs, success, errorKind", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:executed", {
      toolName: "bash",
      durationMs: 1234,
      success: false,
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      errorKind: "internal",
      errorMessage: "boom",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.result");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.toolName).toBe("bash");
    expect(data.durationMs).toBe(1234);
    expect(data.success).toBe(false);
    expect(data.errorKind).toBe("internal");
  });

  it("tool_timeout_event_maps_to_tool.timeout sharing toolCallId for dedup with tool:executed", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:timeout", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-tout",
      toolName: "bash",
      toolCallId: "tc-77",
      timeoutMs: 30_000,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.timeout");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.toolName).toBe("bash");
    expect(data.toolCallId).toBe("tc-77");
    expect(data.timeoutMs).toBe(30_000);
  });
});

describe("attachTrajectoryToEventBus -- model events", () => {
  it("model_fallback_attempt_maps with fromProvider/toProvider/attemptNumber", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("model:fallback_attempt", {
      fromProvider: "anthropic",
      fromModel: "claude-3",
      toProvider: "openai",
      toModel: "gpt-4",
      error: "rate-limited",
      attemptNumber: 2,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("model.fallback_attempt");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.fromProvider).toBe("anthropic");
    expect(data.toProvider).toBe("openai");
    expect(data.attemptNumber).toBe(2);
  });

  it("lkw_fallback_attempt_has_lkw_flag in trajectory data", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("model:lkw_fallback_attempt", {
      fromProvider: "anthropic",
      fromModel: "claude-3",
      toProvider: "anthropic",
      toModel: "claude-3-lkw",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("model.fallback_attempt");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.lkw).toBe(true);
  });

  it("observability_token_usage_maps_to_model.completed with inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens/durationMs", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-tu",
      agentId: "agent-1",
      channelId: "c1",
      executionId: "exec-001",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      tokens: { prompt: 1000, completion: 250, total: 1250 },
      cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0, total: 0.018 },
      latencyMs: 2500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      sessionKey: "t1:u1:c1",
      savedVsUncached: 0,
      cacheEligible: true,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("model.completed");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.provider).toBe("anthropic");
    expect(data.modelId).toBe("claude-sonnet-4-20250514");
    expect(data.inputTokens).toBe(1000);
    expect(data.outputTokens).toBe(250);
    expect(data.cacheReadTokens).toBe(100);
    expect(data.cacheCreationTokens).toBe(50);
    expect(data.durationMs).toBe(2500);
  });
});

describe("attachTrajectoryToEventBus -- delivery events", () => {
  it("delivery_enqueued_maps_to_delivery.queued with channelType/channelId", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("delivery:enqueued", {
      entryId: "e1",
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chan-1",
      origin: "user",
      timestamp: Date.now(),
    } as any);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("delivery.queued");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.channelType).toBe("telegram");
    expect(data.channelId).toBe("chan-1");
  });

  it("delivery_complete_maps_to_delivery.dispatched with status derived from totals", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    // Successful dispatch — all chunks delivered.
    bus.emit("delivery:complete", {
      entryId: "e2",
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chan-1",
      origin: "user",
      strategy: "single",
      totalChunks: 3,
      deliveredChunks: 3,
      failedChunks: 0,
      totalChars: 1500,
      durationMs: 250,
      timestamp: Date.now(),
    } as any);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("delivery.dispatched");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.status).toBe("success");
    expect(data.durationMs).toBe(250);

    // Partial dispatch — some chunks failed.
    bus.emit("delivery:complete", {
      entryId: "e3",
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chan-1",
      origin: "user",
      strategy: "single",
      totalChunks: 3,
      deliveredChunks: 1,
      failedChunks: 2,
      totalChars: 1500,
      durationMs: 320,
      timestamp: Date.now(),
    } as any);
    expect(recorder.calls).toHaveLength(2);
    const data2 = recorder.calls[1].data as Record<string, unknown>;
    expect(data2.status).toBe("partial");
  });
});

describe("attachTrajectoryToEventBus -- unsubscribe + filter", () => {
  it("unsubscribe_stops_recording after the returned function is called", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    const unsubscribe = attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:started", {
      toolName: "x",
      toolCallId: "tc-1",
      timestamp: Date.now(),
    });
    expect(recorder.calls).toHaveLength(1);

    unsubscribe();

    bus.emit("tool:started", {
      toolName: "y",
      toolCallId: "tc-2",
      timestamp: Date.now(),
    });
    expect(recorder.calls).toHaveLength(1); // unchanged
  });

  it("filter_excludes_events when filter returns false (only tool:* events trajectory-mapped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({
      eventBus: bus,
      recorder,
      filter: (eventName) => eventName.startsWith("tool:"),
    });

    bus.emit("tool:started", {
      toolName: "x",
      toolCallId: "tc-1",
      timestamp: Date.now(),
    });
    bus.emit("model:fallback_attempt", {
      fromProvider: "anthropic",
      fromModel: "claude-3",
      toProvider: "openai",
      toModel: "gpt-4",
      error: "rate-limited",
      attemptNumber: 1,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.call");
  });
});

describe("attachTrajectoryToEventBus -- envelope-only correlation invariant (design §6.2)", () => {
  // Parameterized over EVERY mapped event name. Each emit carries the
  // four correlation keys (`traceId`, `agentId`, `sessionKey`, `sessionId`);
  // the bridge MUST strip them out before handing to `recordEvent`.
  // Sample-shaped payloads carry the minimum fields each translator
  // reads so the switch doesn't error on missing nested fields
  // (e.g., `tokens.prompt`, `totalChunks`, `tokens` object for token_usage).
  const SAMPLE_PAYLOADS: Record<string, Record<string, unknown>> = {
    "tool:started": { toolName: "x", toolCallId: "tc-1", timestamp: 0 },
    "tool:executed": { toolName: "x", toolCallId: "tc-1", durationMs: 1, success: true, timestamp: 0 },
    "tool:timeout": { toolName: "x", toolCallId: "tc-1", timeoutMs: 1000, timestamp: 0 },
    "tool:policy_filtered": { profile: "default", filtered: ["tool-a"] },
    "observability:token_usage": {
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 0,
      provider: "anthropic",
      model: "claude",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      timestamp: 0,
    },
    "model:fallback_attempt": {
      fromProvider: "a",
      fromModel: "m",
      toProvider: "b",
      toModel: "n",
      error: "x",
      attemptNumber: 1,
      timestamp: 0,
    },
    "model:lkw_fallback_attempt": {
      fromProvider: "a",
      fromModel: "m",
      toProvider: "b",
      toModel: "n",
      timestamp: 0,
    },
    "model:fallback_exhausted": {
      provider: "a",
      model: "m",
      totalAttempts: 3,
      timestamp: 0,
    },
    "model:auth_cooldown": {
      keyName: "k",
      provider: "a",
      cooldownMs: 0,
      failureCount: 0,
      timestamp: 0,
    },
    "skill:prompt_loaded": {
      skillName: "s",
      source: "registry",
      bodyLength: 10,
    },
    "skill:prompt_invoked": {
      skillName: "s",
      invokedBy: "user",
      args: {},
    },
    "prompt:submitted": {
      promptChars: 100,
      provider: "a",
      modelId: "m",
      messageCount: 1,
      systemDigest: "d",
      messagesDigest: "d",
    },
    "session:started": {
      channelType: "telegram",
      channelId: "c1",
    },
    "session:ended": {
      totalTurns: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      durationMs: 1,
      exitReason: "ok",
    },
    "memory:injected": {
      hitCount: 1,
      charsInjected: 100,
      trustTags: ["external"],
    },
    "delivery:enqueued": {
      entryId: "e",
      channelType: "telegram",
      channelId: "c",
      origin: "user",
    },
    "delivery:complete": {
      entryId: "e",
      channelType: "telegram",
      channelId: "c",
      origin: "user",
      strategy: "single",
      totalChunks: 1,
      deliveredChunks: 1,
      failedChunks: 0,
      totalChars: 10,
      durationMs: 10,
      timestamp: 0,
    },
    "context:pipeline": {
      tokensLoaded: 100,
      tokensEvicted: 10,
      tokensMasked: 0,
      tokensCompacted: 0,
      thinkingBlocksRemoved: 0,
      budgetUtilization: 0.5,
      evictionCategories: {},
      rereadCount: 0,
      rereadTools: [],
      sessionDepth: 1,
      sessionToolResults: 0,
      cacheHitTokens: 50,
      cacheWriteTokens: 10,
      cacheMissTokens: 0,
      durationMs: 25,
      layerCount: 3,
      layers: [
        { name: "system", durationMs: 5, messagesIn: 1, messagesOut: 1 },
      ],
      timestamp: 0,
    },
    // BRIDGE-01 queue events
    "queue:enqueued": {
      sessionKey: "t1:u1:c1",
      channelType: "telegram",
      queueDepth: 1,
      mode: "collect",
      timestamp: 0,
    },
    "queue:dequeued": {
      sessionKey: "t1:u1:c1",
      channelType: "telegram",
      waitTimeMs: 100,
      timestamp: 0,
    },
    "queue:overflow": {
      sessionKey: "t1:u1:c1",
      channelType: "telegram",
      policy: "drop_oldest",
      droppedCount: 1,
      timestamp: 0,
    },
    "queue:coalesced": {
      sessionKey: "t1:u1:c1",
      channelType: "telegram",
      messageCount: 3,
      timestamp: 0,
    },
    // BRIDGE-03 execution events
    "execution:aborted": {
      sessionKey: "t1:u1:c1",
      reason: "user_stop",
      agentId: "agent-1",
      timestamp: 0,
    },
    "execution:budget_warning": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      totalTokens: 50000,
      llmCallCount: 8,
      projectedCallsLeft: 2,
      timestamp: 0,
    },
    "execution:prompt_timeout": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timeoutMs: 30000,
      timestamp: 0,
    },
    "execution:output_escalated": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      originalMaxTokens: 4096,
      escalatedMaxTokens: 8192,
      timestamp: 0,
    },
    "execution:signed_replay_recovered": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      blocksRemoved: 1,
      thoughtSignaturesStripped: 1,
      succeeded: true,
      timestamp: 0,
    },
    // BRIDGE-04 scanned subset
    "security:injection_detected": {
      source: "user_input",
      patterns: ["test"],
      riskLevel: "low",
      timestamp: 0,
    },
    "sender:blocked": {
      channelType: "telegram",
      senderId: "123",
      channelId: "chan-1",
      timestamp: 0,
    },
  };

  it.each(Object.keys(TRAJECTORY_BRIDGE_MAPPING))(
    "translatePayload_strips_correlation_keys_from_data: %s",
    (eventName) => {
      const bus = makeBus();
      const recorder = createCaptureRecorder();
      attachTrajectoryToEventBus({ eventBus: bus, recorder });

      const base = SAMPLE_PAYLOADS[eventName];
      expect(base, `missing SAMPLE_PAYLOADS for ${eventName}`).toBeDefined();

      // Inject the four correlation keys into every payload.
      const payload = {
        ...base,
        traceId: "trace-X",
        agentId: "agent-X",
        sessionKey: "skey-X",
        sessionId: "sid-X",
      };
      // Cast through `unknown` to satisfy TypeScript's strict EventMap
      // typing — payloads are intentionally permissive shapes for the
      // architecture-level test.
      bus.emit(eventName as keyof EventMap, payload as never);

      expect(recorder.calls).toHaveLength(1);
      const data = recorder.calls[0].data as Record<string, unknown>;
      expect(data.traceId, `${eventName}.data.traceId`).toBeUndefined();
      expect(data.agentId, `${eventName}.data.agentId`).toBeUndefined();
      expect(data.sessionKey, `${eventName}.data.sessionKey`).toBeUndefined();
      expect(data.sessionId, `${eventName}.data.sessionId`).toBeUndefined();
    },
  );
});

describe("TRAJECTORY_BRIDGE_MAPPING -- architecture-test surface", () => {
  it("exposes the EventBus → trajectory mapping for enumeration by the architecture test", () => {
    // Spot-check: prompt/session/memory/tool-timeout events are all mapped.
    expect(TRAJECTORY_BRIDGE_MAPPING["prompt:submitted"]).toBe("prompt.submitted");
    expect(TRAJECTORY_BRIDGE_MAPPING["session:started"]).toBe("session.started");
    expect(TRAJECTORY_BRIDGE_MAPPING["session:ended"]).toBe("session.ended");
    expect(TRAJECTORY_BRIDGE_MAPPING["memory:injected"]).toBe("memory.injected");
    expect(TRAJECTORY_BRIDGE_MAPPING["tool:timeout"]).toBe("tool.timeout");

    // Tool/model/skill/delivery — confirms the full bridge surface.
    expect(TRAJECTORY_BRIDGE_MAPPING["tool:started"]).toBe("tool.call");
    expect(TRAJECTORY_BRIDGE_MAPPING["tool:executed"]).toBe("tool.result");
    expect(TRAJECTORY_BRIDGE_MAPPING["tool:policy_filtered"]).toBe("tool.policy_filtered");
    expect(TRAJECTORY_BRIDGE_MAPPING["model:fallback_attempt"]).toBe("model.fallback_attempt");
    expect(TRAJECTORY_BRIDGE_MAPPING["model:lkw_fallback_attempt"]).toBe("model.fallback_attempt");
    expect(TRAJECTORY_BRIDGE_MAPPING["model:fallback_exhausted"]).toBe("model.fallback_exhausted");
    expect(TRAJECTORY_BRIDGE_MAPPING["model:auth_cooldown"]).toBe("model.auth_cooldown");
    expect(TRAJECTORY_BRIDGE_MAPPING["observability:token_usage"]).toBe("model.completed");
    expect(TRAJECTORY_BRIDGE_MAPPING["skill:prompt_loaded"]).toBe("skill.prompt_loaded");
    expect(TRAJECTORY_BRIDGE_MAPPING["skill:prompt_invoked"]).toBe("skill.prompt_invoked");
    expect(TRAJECTORY_BRIDGE_MAPPING["delivery:enqueued"]).toBe("delivery.queued");
    expect(TRAJECTORY_BRIDGE_MAPPING["delivery:complete"]).toBe("delivery.dispatched");
    // Context engine pipeline → context.compiled.
    expect(TRAJECTORY_BRIDGE_MAPPING["context:pipeline"]).toBe("context.compiled");
  });
});

describe("attachTrajectoryToEventBus -- context engine", () => {
  it("context_pipeline_maps_to_context_compiled_with_pipeline_metrics_in_data", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:pipeline", {
      agentId: "agent-X",
      sessionKey: "skey-X",
      tokensLoaded: 12000,
      tokensEvicted: 800,
      tokensMasked: 0,
      tokensCompacted: 4000,
      thinkingBlocksRemoved: 1,
      budgetUtilization: 0.61,
      evictionCategories: { tool_result: 800 },
      rereadCount: 0,
      rereadTools: [],
      sessionDepth: 7,
      sessionToolResults: 12,
      cacheHitTokens: 9000,
      cacheWriteTokens: 1500,
      cacheMissTokens: 1500,
      cacheFenceIndex: 4,
      durationMs: 87,
      layerCount: 5,
      layers: [
        { name: "system", durationMs: 3, messagesIn: 1, messagesOut: 1 },
        { name: "tools", durationMs: 12, messagesIn: 4, messagesOut: 4 },
      ],
      timestamp: 0,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.compiled");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.tokensLoaded).toBe(12000);
    expect(data.tokensEvicted).toBe(800);
    expect(data.tokensCompacted).toBe(4000);
    expect(data.budgetUtilization).toBeCloseTo(0.61);
    expect(data.durationMs).toBe(87);
    expect(data.layerCount).toBe(5);
    expect(Array.isArray(data.layers)).toBe(true);
    expect((data.layers as Array<unknown>).length).toBe(2);
    expect(data.cacheFenceIndex).toBe(4);
  });

  it("context_pipeline_omits_cacheFenceIndex_from_data_when_payload_omits_it", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:pipeline", {
      agentId: "a",
      sessionKey: "sk",
      tokensLoaded: 100,
      tokensEvicted: 0,
      tokensMasked: 0,
      tokensCompacted: 0,
      thinkingBlocksRemoved: 0,
      budgetUtilization: 0.1,
      evictionCategories: {},
      rereadCount: 0,
      rereadTools: [],
      sessionDepth: 0,
      sessionToolResults: 0,
      cacheHitTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 0,
      durationMs: 5,
      layerCount: 1,
      layers: [{ name: "system", durationMs: 5, messagesIn: 1, messagesOut: 1 }],
      timestamp: 0,
    });

    const data = recorder.calls[0].data as Record<string, unknown>;
    // No cacheFenceIndex in the source payload → not present in data.
    expect("cacheFenceIndex" in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BRIDGE-01/03/04 — Queue, Execution, Security, Sender bridge tests
// ---------------------------------------------------------------------------

describe("BRIDGE-01/03/04 queue + execution + sender", () => {
  // ---- BRIDGE-01: Queue lifecycle events ----

  it("queue_enqueued_maps_to_queue.enqueued with channelType/queueDepth/mode; sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("queue:enqueued", {
      sessionKey: "t1:u1:c1" as any,
      channelType: "telegram",
      queueDepth: 1,
      mode: "collect",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("queue.enqueued");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.channelType).toBe("telegram");
    expect(data.queueDepth).toBe(1);
    expect(data.mode).toBe("collect");
    // Envelope-only — must NOT appear in data.
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
    expect(data.traceId).toBeUndefined();
    expect(data.agentId).toBeUndefined();
  });

  it("incident_replay_2026_05_24_double_enqueue_produces_two_queue.enqueued_events_with_queueDepth_1_then_2", () => {
    // Incident replay: the 2026-05-24 duplicate-adapter bug caused the same
    // sessionKey to be enqueued twice. Two queue.enqueued events with
    // queueDepth 1 then 2 on the same sessionKey would have diagnosed this
    // in a single trajectory query.
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    const sessionKey = "incident-session:user1:telegram" as any;

    // First enqueue.
    bus.emit("queue:enqueued", {
      sessionKey,
      channelType: "telegram",
      queueDepth: 1,
      mode: "collect",
      timestamp: Date.now(),
    });

    // Second enqueue (duplicate adapter fires again).
    bus.emit("queue:enqueued", {
      sessionKey,
      channelType: "telegram",
      queueDepth: 2,
      mode: "collect",
      timestamp: Date.now(),
    });

    // Exactly two queue.enqueued trajectory events.
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0].type).toBe("queue.enqueued");
    expect(recorder.calls[1].type).toBe("queue.enqueued");

    const data0 = recorder.calls[0].data as Record<string, unknown>;
    const data1 = recorder.calls[1].data as Record<string, unknown>;

    // Depths 1 then 2 — the headline diagnostic signal.
    expect(data0.queueDepth).toBe(1);
    expect(data1.queueDepth).toBe(2);
  });

  it("queue_dequeued_maps_to_queue.dequeued with channelType/waitTimeMs; sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("queue:dequeued", {
      sessionKey: "t1:u1:c1" as any,
      channelType: "discord",
      waitTimeMs: 250,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("queue.dequeued");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.channelType).toBe("discord");
    expect(data.waitTimeMs).toBe(250);
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("queue_overflow_maps_to_queue.overflow with channelType/policy/droppedCount; sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("queue:overflow", {
      sessionKey: "t1:u1:c1" as any,
      channelType: "slack",
      policy: "drop_oldest",
      droppedCount: 3,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("queue.overflow");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.channelType).toBe("slack");
    expect(data.policy).toBe("drop_oldest");
    expect(data.droppedCount).toBe(3);
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("queue_coalesced_maps_to_queue.coalesced with channelType/messageCount; sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("queue:coalesced", {
      sessionKey: "t1:u1:c1" as any,
      channelType: "telegram",
      messageCount: 5,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("queue.coalesced");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.channelType).toBe("telegram");
    expect(data.messageCount).toBe(5);
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  // ---- BRIDGE-03: Execution lifecycle events ----

  it("execution_aborted_maps_to_execution.aborted with reason; sessionKey/agentId stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:aborted", {
      sessionKey: "t1:u1:c1" as any,
      reason: "user_stop",
      agentId: "agent-1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.aborted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("user_stop");
    expect(data.sessionKey).toBeUndefined();
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("execution_budget_warning_maps_to_execution.budget_warning with totalTokens/llmCallCount/projectedCallsLeft; sessionKey/agentId stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:budget_warning", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      totalTokens: 85000,
      llmCallCount: 12,
      projectedCallsLeft: 3,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.budget_warning");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.totalTokens).toBe(85000);
    expect(data.llmCallCount).toBe(12);
    expect(data.projectedCallsLeft).toBe(3);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("execution_prompt_timeout_maps_to_execution.prompt_timeout with timeoutMs; sessionKey/agentId stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:prompt_timeout", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timeoutMs: 30000,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.prompt_timeout");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.timeoutMs).toBe(30000);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("execution_output_escalated_maps_to_execution.output_escalated with originalMaxTokens/escalatedMaxTokens; sessionKey/agentId stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:output_escalated", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      originalMaxTokens: 4096,
      escalatedMaxTokens: 8192,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.output_escalated");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.originalMaxTokens).toBe(4096);
    expect(data.escalatedMaxTokens).toBe(8192);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("execution_signed_replay_recovered_maps_to_execution.replay_recovered (NOT execution.signed_replay_recovered) with blocksRemoved/thoughtSignaturesStripped/succeeded; agentId/sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:signed_replay_recovered", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      blocksRemoved: 2,
      thoughtSignaturesStripped: 1,
      succeeded: true,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    // Must map to "execution.replay_recovered" — NOT "execution.signed_replay_recovered".
    expect(recorder.calls[0].type).toBe("execution.replay_recovered");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.blocksRemoved).toBe(2);
    expect(data.thoughtSignaturesStripped).toBe(1);
    expect(data.succeeded).toBe(true);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  // ---- BRIDGE-04 (scanned subset): Security + Sender ----

  it("security_injection_detected_maps_to_security.injection_detected with source/riskLevel only; patterns[] MUST NOT be forwarded (L4 security invariant)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("security:injection_detected", {
      source: "user_input",
      patterns: ["IGNORE ALL PRIOR INSTRUCTIONS", "jailbreak_attempt"],
      riskLevel: "high",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("security.injection_detected");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // Only source + riskLevel in data.
    expect(data.source).toBe("user_input");
    expect(data.riskLevel).toBe("high");

    // patterns[] must NOT appear — forwarding injection strings is a security anti-pattern (L4).
    expect(data.patterns).toBeUndefined();
    expect("patterns" in data).toBe(false);

    // Envelope-only fields must be stripped.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("sender_blocked_maps_to_sender.blocked with channelType only; senderId/channelId MUST NOT be forwarded (L4/L2 PII invariant)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("sender:blocked", {
      channelType: "telegram",
      senderId: "12345678901",
      channelId: "chan-private-1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("sender.blocked");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // Only channelType in data.
    expect(data.channelType).toBe("telegram");

    // senderId (user identifier) must NOT appear in trajectory data (L4/L2).
    expect(data.senderId).toBeUndefined();
    expect("senderId" in data).toBe(false);

    // channelId must NOT appear.
    expect(data.channelId).toBeUndefined();
    expect("channelId" in data).toBe(false);

    expect(data.timestamp).toBeUndefined();
  });

  // ---- Coverage spot-check ----

  it("TRAJECTORY_BRIDGE_MAPPING contains all 11 new BRIDGE-01/03/04 keys", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    const expected = [
      "queue:enqueued",
      "queue:dequeued",
      "queue:overflow",
      "queue:coalesced",
      "execution:aborted",
      "execution:budget_warning",
      "execution:prompt_timeout",
      "execution:output_escalated",
      "execution:signed_replay_recovered",
      "security:injection_detected",
      "sender:blocked",
    ];
    for (const key of expected) {
      expect(mapping[key], `TRAJECTORY_BRIDGE_MAPPING missing key: ${key}`).toBeDefined();
    }
    // Total bridge size should be ≥ 29 (18 existing + 11 new).
    expect(Object.keys(mapping).length).toBeGreaterThanOrEqual(29);
  });
});
