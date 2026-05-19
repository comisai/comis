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
  it("tool_started_maps_to_tool.call with toolName, toolCallId, traceId in data", () => {
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
    expect(data.traceId).toBe("trace-1");
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
  });
});
