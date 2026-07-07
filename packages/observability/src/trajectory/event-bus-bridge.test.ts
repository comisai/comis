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
import { TRAJECTORY_EVENT_TYPES } from "./types.js";

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
  it("tool_started_maps_to_tool.call with toolName + toolCallId; correlation keys stripped from data", () => {
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
    // Envelope-only correlation keys — must NOT appear in data.
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

  it("forwards the content-free web_search grounding summary (resultCount + domains) onto tool.result", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:executed", {
      toolName: "web_search",
      toolCallId: "tc-ws",
      durationMs: 800,
      success: true,
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      resultCount: 5,
      domains: ["example.com", "news.example.org"],
    });

    expect(recorder.calls[0].type).toBe("tool.result");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.resultCount).toBe(5);
    expect(data.domains).toEqual(["example.com", "news.example.org"]);
  });

  // The two breaker transitions must land in the trajectory as
  // tool.breaker_opened / tool.breaker_reset with ids/counts/typed-reason only
  // (no raw error body). obs.explain reads these.
  it("tool_breaker_opened_maps_to_tool.breaker_opened with toolName/consecutiveFailures/errorTag/reason/seq", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:breaker_opened", {
      toolName: "bash",
      consecutiveFailures: 5,
      errorTag: "spawn_enoent",
      reason: "tool_failure_threshold",
      seq: 3,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.breaker_opened");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.toolName).toBe("bash");
    expect(data.consecutiveFailures).toBe(5);
    expect(data.errorTag).toBe("spawn_enoent");
    expect(data.reason).toBe("tool_failure_threshold");
    expect(data.seq).toBe(3);
  });

  it("tool_breaker_reset_maps_to_tool.breaker_reset with toolName/reason/seq", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:breaker_reset", {
      toolName: "web_fetch",
      reason: "success",
      seq: 7,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.breaker_reset");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.toolName).toBe("web_fetch");
    expect(data.reason).toBe("success");
    expect(data.seq).toBe(7);
  });

  // The per-session health rollup must land in the trajectory as
  // session.summary carrying counts/flags only — the replay shape
  // (degraded run, 8/10 web_fetch failures). obs.explain reads it.
  it("session_summary_maps_to_session.summary with degraded/turnCount/costUsd/toolStats/breakerTripCount", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("session:summary", {
      sessionKey: "t1:u1:c1",
      agentId: "agent-1",
      traceId: "trace-1",
      degraded: true,
      turnCount: 24,
      costUsd: 1.45,
      toolStats: { web_fetch: { ok: 2, failed: 8 } },
      breakerTripCount: 1,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("session.summary");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.degraded).toBe(true);
    expect(data.turnCount).toBe(24);
    expect(data.costUsd).toBe(1.45);
    expect(data.toolStats).toEqual({ web_fetch: { ok: 2, failed: 8 } });
    expect(data.breakerTripCount).toBe(1);
  });

  // The trajectory record carries counts/flags ONLY — the envelope
  // correlation ids (agentId/sessionKey/traceId) are handled separately and
  // must NOT appear in the translated data.
  it("session_summary_strips_envelope_ids_from_data", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("session:summary", {
      sessionKey: "t1:u1:c1",
      agentId: "agent-1",
      traceId: "trace-1",
      degraded: false,
      turnCount: 3,
      costUsd: 0.02,
      toolStats: {},
      breakerTripCount: 0,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
  });

  it("tool_result_offloaded_maps_to_tool.result_offloaded with toolName/toolCallId/originalChars/diskPathRel", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:result_offloaded", {
      toolName: "bash",
      toolCallId: "call-offload-1",
      originalChars: 42_000,
      // workspace-relative pointer ONLY — the trajectory record must never
      // carry the absolute host path (residency; T-151-05).
      diskPathRel: "tool-results/call-offload-1.json",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.result_offloaded");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.toolName).toBe("bash");
    expect(data.toolCallId).toBe("call-offload-1");
    expect(data.originalChars).toBe(42_000);
    expect(data.diskPathRel).toBe("tool-results/call-offload-1.json");
  });

  it("tool_executed_forwards_D1_provenance_into_tool.result.data", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:executed", {
      toolName: "web_fetch",
      toolCallId: "tc-prov",
      durationMs: 1234,
      success: false,
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      // Provenance fields (obs.explain reads these).
      classifiedFailureBy: "failure_detector",
      transportOk: true,
      httpStatus: 200,
      matchedRule: "status_token",
      matchedToken: "503",
      resultBytes: 1234,
      resultDigest: "abc123def456",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("tool.result");
    const data = recorder.calls[0].data as Record<string, unknown>;
    // All 7 provenance fields must reach the trajectory `data` — without
    // this forwarding, obs.explain is blind.
    expect(data.classifiedFailureBy).toBe("failure_detector");
    expect(data.transportOk).toBe(true);
    expect(data.httpStatus).toBe(200);
    expect(data.matchedRule).toBe("status_token");
    expect(data.matchedToken).toBe("503");
    expect(data.resultBytes).toBe(1234);
    expect(data.resultDigest).toBe("abc123def456");
  });

  it("tool_executed_omits_absent_provenance_keys_from_tool.result.data", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    // A success with NO provenance fields — the keys must be ABSENT
    // (presence-conditional, never `undefined` values).
    bus.emit("tool:executed", {
      toolName: "bash",
      toolCallId: "tc-clean",
      durationMs: 10,
      success: true,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect("classifiedFailureBy" in data).toBe(false);
    expect("transportOk" in data).toBe(false);
    expect("httpStatus" in data).toBe(false);
    expect("matchedRule" in data).toBe(false);
    expect("matchedToken" in data).toBe(false);
    expect("resultBytes" in data).toBe(false);
    expect("resultDigest" in data).toBe(false);
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

  // When the per-turn token_usage event carries stopReason/finishReason,
  // the existing token_usage->model.completed translator forwards them
  // presence-conditionally (the same pattern used for provenance). No new
  // mapping key / case is added — the event is already mapped to model.completed.
  it("model_completed_forwards_stopReason_and_finishReason when the token_usage event carries them", () => {
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
      stopReason: "refusal",
      finishReason: "stop",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("model.completed");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.stopReason).toBe("refusal");
    expect(data.finishReason).toBe("stop");
  });

  it("model_completed_omits_stopReason_and_finishReason_keys when the token_usage event lacks them (no undefined keys)", () => {
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
    const data = recorder.calls[0].data as Record<string, unknown>;
    // Presence-conditional: when absent on the source event, NEITHER key is
    // present on model.completed (not even as an undefined value).
    expect("stopReason" in data).toBe(false);
    expect("finishReason" in data).toBe(false);
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

// ---------------------------------------------------------------------------
// Image-generation lifecycle bridge tests.
//
// The 4 image:* events are DIRECT-emitted by the daemon image RPC handler
// (the daemon context has no bus bridge), but they MUST be declared in
// EventMap + TRAJECTORY_BRIDGE_MAPPING + TRAJECTORY_EVENT_TYPES + a translator
// for arch-closure. The translator forwards ONLY content-free
// ids/labels/numbers/booleans (provider/model/costUsd/sizeBytes/outcome/
// channelType/errorKind/delivered/mainProvider) — never the prompt, image
// bytes, a key, or a raw provider message.
// ---------------------------------------------------------------------------
describe("attachTrajectoryToEventBus -- image generation", () => {
  it("image_requested_maps_to_image.requested with provider/mainProvider; correlation keys stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("image:requested", {
      provider: "openai",
      mainProvider: "openai",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-img",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("image.requested");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.provider).toBe("openai");
    expect(data.mainProvider).toBe("openai");
    // Envelope-only correlation keys — must NOT appear in data.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
  });

  it("image_generated_maps_to_image.generated carrying costUsd/model/provider/sizeBytes/outcome (cost-carry)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("image:generated", {
      provider: "openai",
      model: "gpt-image-1",
      costUsd: 0.04,
      sizeBytes: 4242,
      outcome: "ok",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("image.generated");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.provider).toBe("openai");
    expect(data.model).toBe("gpt-image-1");
    // The cost-carry field — the cost rides the trajectory record so
    // `comis explain` reconstructs it.
    expect(data.costUsd).toBe(0.04);
    expect(data.sizeBytes).toBe(4242);
    expect(data.outcome).toBe("ok");
  });

  it("image_delivered_maps_to_image.delivered with channelType/delivered", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("image:delivered", {
      channelType: "telegram",
      delivered: true,
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("image.delivered");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.channelType).toBe("telegram");
    expect(data.delivered).toBe(true);
  });

  it("image_failed_maps_to_image.failed with errorKind/provider (no raw message)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("image:failed", {
      errorKind: "content_blocked",
      provider: "openai",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("image.failed");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.errorKind).toBe("content_blocked");
    expect(data.provider).toBe("openai");
  });

  it("image events are all trajectory-mapped (arch closure)", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["image:requested"]).toBe("image.requested");
    expect(TRAJECTORY_BRIDGE_MAPPING["image:generated"]).toBe("image.generated");
    expect(TRAJECTORY_BRIDGE_MAPPING["image:delivered"]).toBe("image.delivered");
    expect(TRAJECTORY_BRIDGE_MAPPING["image:failed"]).toBe("image.failed");
    expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes("image.generated")).toBe(true);
  });
});

describe("attachTrajectoryToEventBus -- vision analysis (append-only)", () => {
  it("vision_requested_maps_to_media.vision.requested with provider/mainProvider; correlation keys stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("media.vision:requested", {
      provider: "anthropic",
      mainProvider: "anthropic",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-vis",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("media.vision.requested");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.provider).toBe("anthropic");
    expect(data.mainProvider).toBe("anthropic");
    // Envelope-only correlation keys — must NOT appear in data.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
  });

  it("vision_completed_maps_to_media.vision.completed carrying path/costUsd/model/provider/outcome (cost-carry + path label)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("media.vision:completed", {
      provider: "anthropic",
      mainProvider: "anthropic",
      model: "claude-sonnet-4-5",
      costUsd: 0.002,
      path: "main-vision",
      outcome: "ok",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("media.vision.completed");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.provider).toBe("anthropic");
    expect(data.mainProvider).toBe("anthropic");
    expect(data.model).toBe("claude-sonnet-4-5");
    // The cost-carry field — cost rides the trajectory record.
    expect(data.costUsd).toBe(0.002);
    // The "which path" signal.
    expect(data.path).toBe("main-vision");
    expect(data.outcome).toBe("ok");
    expect(data.agentId).toBeUndefined();
  });

  it("vision_completed on the registry tier carries NO costUsd (those adapters return no cost)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("media.vision:completed", {
      provider: "gemini",
      mainProvider: "anthropic",
      model: "gemini-pro-vision",
      path: "registry",
      outcome: "ok",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.path).toBe("registry");
    // Absent costUsd must NOT appear as an undefined key (presence-conditional spread).
    expect("costUsd" in data).toBe(false);
  });

  it("vision_failed_maps_to_media.vision.failed with errorKind/path (no raw message)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("media.vision:failed", {
      errorKind: "empty_response",
      path: "main-vision",
      provider: "anthropic",
      mainProvider: "anthropic",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("media.vision.failed");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.errorKind).toBe("empty_response");
    expect(data.path).toBe("main-vision");
    expect(data.provider).toBe("anthropic");
  });

  it("vision events are all trajectory-mapped (arch closure) + image.* tuple intact (append-only)", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["media.vision:requested"]).toBe("media.vision.requested");
    expect(TRAJECTORY_BRIDGE_MAPPING["media.vision:completed"]).toBe("media.vision.completed");
    expect(TRAJECTORY_BRIDGE_MAPPING["media.vision:failed"]).toBe("media.vision.failed");
    expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes("media.vision.completed")).toBe(true);
    // The SemVer-frozen image.* mapping is STILL present (not renamed by the append).
    expect(TRAJECTORY_BRIDGE_MAPPING["image:generated"]).toBe("image.generated");
  });

  // Video-generation lifecycle bridge mapping. The daemon
  // video RPC handler + the off-turn background poller DIRECT-emit these via the
  // per-session recorder (no bus bridge in the daemon RPC/poller context — the
  // image.*/media.vision.* precedent); the mapping is declared for arch-closure +
  // a future bus emitter. APPEND-ONLY beside image.*/media.vision.* —
  // never a rename, which would trip the bridge-entry-count guard + web codegen.
  it("all five video:* events are trajectory-mapped (arch closure); the +5 rows are exactly these", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["video:requested"]).toBe("video.requested");
    expect(TRAJECTORY_BRIDGE_MAPPING["video:submitted"]).toBe("video.submitted");
    expect(TRAJECTORY_BRIDGE_MAPPING["video:generated"]).toBe("video.generated");
    expect(TRAJECTORY_BRIDGE_MAPPING["video:delivered"]).toBe("video.delivered");
    expect(TRAJECTORY_BRIDGE_MAPPING["video:failed"]).toBe("video.failed");
    // The 5 trajectory-type literals are present in the closed tuple (append-only).
    for (const t of [
      "video.requested",
      "video.submitted",
      "video.generated",
      "video.delivered",
      "video.failed",
    ]) {
      expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes(t)).toBe(true);
    }
    // The SemVer-frozen image.*/media.vision.* mappings are STILL present (the
    // video append renamed nothing).
    expect(TRAJECTORY_BRIDGE_MAPPING["image:generated"]).toBe("image.generated");
    expect(TRAJECTORY_BRIDGE_MAPPING["media.vision:completed"]).toBe("media.vision.completed");
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

describe("attachTrajectoryToEventBus -- envelope-only correlation invariant", () => {
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
    "tool:breaker_opened": { toolName: "x", consecutiveFailures: 5, errorTag: "spawn_enoent", reason: "tool_failure_threshold", seq: 1, timestamp: 0 },
    "tool:breaker_reset": { toolName: "x", reason: "success", seq: 1, timestamp: 0 },
    "tool:result_offloaded": { toolName: "x", toolCallId: "tc-1", originalChars: 42_000, diskPathRel: "tool-results/tc-1.json", timestamp: 0 },
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
    "memory:skill_used": {
      usedSkillIds: ["skill-a", "skill-b"],
      usedCount: 2,
    },
    "memory:skill_surfaced": {
      surfacedCount: 3,
      creditedCount: 1,
      scores: [
        { name: "skill-a", coverage: 1.0, sharedCount: 9, credited: true, hasTopicTokens: true },
        { name: "skill-b", coverage: 0.45, sharedCount: 5, credited: false, hasTopicTokens: true },
      ],
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
    "session:summary": {
      degraded: true,
      turnCount: 1,
      costUsd: 0.01,
      toolStats: { web_fetch: { ok: 1, failed: 1 } },
      breakerTripCount: 1,
    },
    "memory:injected": {
      hitCount: 1,
      charsInjected: 100,
      trustTags: ["external"],
    },
    "memory:recalled": {
      lanes: 2,
      ftsCandidates: 5,
      vectorCandidates: 3,
      entityCandidates: 0,
      finalCount: 4,
      rerankerAvailable: true,
      durationMs: 12,
    },
    "memory:reranked": {
      candidateCount: 8,
      hitCount: 4,
      rerankerAvailable: true,
      timedOut: false,
      fellBack: false,
      durationMs: 7,
    },
    "memory:generation_quality": {
      agentId: "default",
      pass: "user_representation",
      sourceScript: "hebrew",
      outputScript: "latin",
      languageMismatch: true,
      emptyOutput: false,
      formatViolation: false,
      timestamp: 1000,
    },
    "observability:cache_break": {
      provider: "anthropic",
      reason: "tools_changed",
      tokenDrop: 1000,
      tokenDropRelative: 0.5,
      previousCacheRead: 2000,
      currentCacheRead: 1000,
      callCount: 3,
      changes: {
        systemChanged: false,
        toolsChanged: true,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: ["tool-a"],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
      },
      toolsChanged: ["tool-a"],
      ttlCategory: undefined,
      toolsAdded: ["tool-a"],
      toolsRemoved: [],
      toolsSchemaChanged: [],
      systemCharDelta: 10,
      model: "claude-3-5-sonnet-20241022",
    },
    "learning:outcome_observed": {
      agentId: "default",
      trajectoryId: "trace-lo-1",
      outcome: "success",
      source: "tool",
      confidence: 0.9,
      timestamp: 1000,
    },
    // The soft-eviction transition counts (daemon-side emit).
    "learning:memory_demoted": {
      agentId: "default",
      count: 3,
      timestamp: 1000,
    },
    "learning:memory_evicted": {
      agentId: "default",
      count: 2,
      timestamp: 1000,
    },
    "learning:memory_failure_attributed": {
      agentId: "default",
      count: 2,
      timestamp: 1000,
    },
    // The reflection-run telemetry
    // (daemon-side emit) — count / funnel-counts / admissionOutcome closed-enum ONLY.
    "reflect:admitted": {
      agentId: "default",
      count: 2,
      timestamp: 1000,
    },
    "reflect:funnel": {
      agentId: "default",
      synthesized: 2,
      validated: 2,
      admitted: 0,
      maxClusterCardinality: 1,
      admissionOutcome: "uncorroborated",
      timestamp: 1000,
    },
    // The promote/demote telemetry (daemon-side emit) — count ONLY.
    "learning:skill_promoted": {
      agentId: "default",
      count: 2,
      timestamp: 1000,
    },
    "learning:skill_demoted": {
      agentId: "default",
      count: 1,
      timestamp: 1000,
    },
    "background_task:promoted": {
      agentId: "default",
      taskId: "t-1",
      toolName: "terminal_session_wait",
      timestamp: 1000,
    },
    "background_task:completed": {
      agentId: "default",
      taskId: "t-1",
      toolName: "terminal_session_wait",
      durationMs: 4200,
      origin: { agentId: "default", sessionKey: "k" },
      timestamp: 1000,
    },
    "background_task:failed": {
      agentId: "default",
      taskId: "t-1",
      toolName: "exec",
      error: "boom",
      durationMs: 9,
      origin: { agentId: "default", sessionKey: "k" },
      timestamp: 1000,
    },
    "terminal:drive_promoted": {
      sessionId: "term-1",
      agentId: "default",
      reason: "mode_detached",
      timestamp: 1000,
    },
    "terminal:session_evicted": {
      sessionId: "term-1",
      agentId: "default",
      reason: "idle",
      durationMs: 1_800_000,
      timestamp: 1000,
    },
    "orchestrate:run_summary": {
      agentId: "default",
      sessionKey: "t1:u1:c1",
      runId: "orch-1",
      leaseId: "child-lease-1",
      rootRunId: "root-1",
      language: "ts",
      durationMs: 1234,
      exitCode: 0,
      stdoutBytesRaw: 100,
      stdoutCharsReentered: 100,
      resultRefCount: 0,
      resultRefBytes: 0,
      estSavedTokens: 0,
      savedRatio: 0,
      timestamp: 1000,
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
    "delivery:aborted": {
      channelId: "c",
      channelType: "telegram",
      reason: "spend_exceeded",
      chunksDelivered: 0,
      totalChunks: 2,
      durationMs: 5,
      origin: "agent",
      timestamp: 0,
    },
    "execution:recovery_attempted": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      reason: "silent_retry",
      succeeded: true,
      timestamp: 0,
    },
    "activity:turn_finalized": {
      sessionKey: "t1:u1:c1",
      agentId: "agent-1",
      channelType: "telegram",
      strategy: "EditPlace",
      outcome: "failure",
      errorKind: "resource",
      reason: "stopped — spend limit reached",
      reclassified: false,
      failedEventCount: 1,
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
    // queue events
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
    // execution events
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
    "execution:tool_schema_unsupported": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      toolNames: ["schedule_task"],
      strippedKeywords: ["pattern", "format"],
      retried: true,
      succeeded: true,
      timestamp: 0,
    },
    // scanned subset
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
    // retry events
    "retry:attempted": {
      channelId: "chan-1",
      chatId: "12345678901",
      attempt: 1,
      maxAttempts: 5,
      delayMs: 500,
      error: "ETIMEDOUT",
      timestamp: 0,
    },
    "retry:exhausted": {
      channelId: "chan-1",
      chatId: "12345678901",
      totalAttempts: 5,
      finalError: "ECONNREFUSED",
      timestamp: 0,
    },
    "retry:markdown_fallback": {
      channelId: "chan-1",
      chatId: "12345678901",
      originalParseMode: "MarkdownV2",
      timestamp: 0,
    },
    // mcp events
    "mcp:server:disconnected": {
      serverName: "fs-server",
      reason: "transport_closed",
      timestamp: 0,
    },
    "mcp:server:reconnecting": {
      serverName: "fs-server",
      attempt: 1,
      maxAttempts: 5,
      nextDelayMs: 1000,
      timestamp: 0,
    },
    "mcp:server:reconnect_failed": {
      serverName: "fs-server",
      attempts: 5,
      lastError: "ECONNREFUSED",
      timestamp: 0,
    },
    "mcp:server:reconnected": {
      serverName: "fs-server",
      attempt: 2,
      toolCount: 10,
      durationMs: 200,
      timestamp: 0,
    },
    "mcp:server:connected": {
      serverName: "fs-server",
      transport: "stdio",
      toolCount: 10,
      durationMs: 200,
      timestamp: 0,
    },
    "mcp:server:connect_failed": {
      serverName: "fs-server",
      transport: "stdio",
      reason: "server_exited",
      timestamp: 0,
    },
    "mcp:server:tools_changed": {
      serverName: "fs-server",
      previousToolCount: 10,
      currentToolCount: 11,
      addedTools: ["new_tool"],
      removedTools: [],
      timestamp: 0,
    },
    // channel events
    "channel:health_changed": {
      channelType: "telegram",
      previousState: "healthy",
      currentState: "degraded",
      connectionMode: "polling",
      error: null,
      lastMessageAt: null,
      timestamp: 0,
    },
    "channel:registered": {
      channelType: "telegram",
      pluginId: "tg",
      capabilities: {} as any,
      timestamp: 0,
    },
    "channel:deregistered": {
      channelType: "telegram",
      pluginId: "tg",
      timestamp: 0,
    },
    // security events
    "security:memory_tainted": {
      agentId: "agent-1",
      originalTrustLevel: "trusted",
      adjustedTrustLevel: "tainted",
      patterns: ["x"],
      blocked: true,
      timestamp: 0,
    },
    "security:warn": {
      category: "secret_access",
      agentId: "agent-1",
      message: "warn",
      timestamp: 0,
    },
    // compaction events
    "compaction:started": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 0,
    },
    "compaction:flush": {
      sessionKey: "t1:u1:c1",
      memoriesWritten: 1,
      trigger: "threshold",
      success: true,
      timestamp: 0,
    },
    "compaction:recommended": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      contextPercent: 0.85,
      contextTokens: 170000,
      contextWindow: 200000,
      timestamp: 0,
    },
    // context events
    "context:budget_computed": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall",
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: 31_572,
      outputHeadroom: 768,
      verdict: "exhausted",
    },
    "context:evicted": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      evictedCount: 1,
      evictedChars: 100,
      categories: {},
      timestamp: 0,
    },
    "context:masked": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      maskedCount: 1,
      totalChars: 100,
      persistedToDisk: false,
      timestamp: 0,
    },
    "context:reread": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      rereadCount: 1,
      rereadTools: ["bash"],
      timestamp: 0,
    },
    "context:overflow": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      contextTokens: 200000,
      budgetTokens: 195000,
      recoveryAction: "evict",
      timestamp: 0,
    },
    "context:integrity": {
      conversationId: "conv-1",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      issueCount: 0,
      repairsApplied: 0,
      errorsLogged: 0,
      issueTypes: [],
      durationMs: 5,
      timestamp: 0,
    },
    "context:rehydrated": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      sectionsInjected: 1,
      filesInjected: 0,
      skillsInjected: 0,
      overflowStripped: false,
      timestamp: 0,
    },
    // The two multilingual signals — the envelope-only
    // correlation invariant must hold for them too (no agentId/sessionKey leak).
    "context:script_zero_hit": {
      conversationId: "t1:u1:c1",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      scriptClass: "hebrew",
      lane: "tri",
      timestamp: 0,
    },
    "context:summary_language_mismatch": {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      sourceScript: "hebrew",
      summaryScript: "latin",
      depth: 1,
      timestamp: 0,
    },
    // approval events
    "approval:requested": {
      requestId: "req-1",
      toolName: "bash",
      action: "execute",
      params: { cmd: "ls" },
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "trusted",
      createdAt: 0,
      timeoutMs: 60000,
      timestamp: 0,
    },
    "approval:resolved": {
      requestId: "req-1",
      approved: true,
      approvedBy: "owner",
      resolvedAt: 0,
    },
    // duplicate inbound dedup event
    "dedup:duplicate_inbound": {
      messageId: "m1",
      channelType: "telegram",
      chatId: "123",
      firstSeenAt: 1000,
      duplicateAt: 1001,
      deltaMs: 1,
      source: "pipeline",
      timestamp: 0,
    },
    // health budget exceeded event
    "health:budget_exceeded": {
      kind: "network",
      count: 100,
      windowMs: 60000,
      timestamp: 0,
    },
    // Image-generation lifecycle — the envelope-only
    // correlation invariant must hold for them too (no agentId/sessionKey leak).
    "image:requested": {
      provider: "openai",
      mainProvider: "openai",
      timestamp: 0,
    },
    "image:generated": {
      provider: "openai",
      model: "gpt-image-1",
      costUsd: 0.04,
      sizeBytes: 4242,
      outcome: "ok",
      timestamp: 0,
    },
    "image:delivered": {
      channelType: "telegram",
      delivered: true,
      timestamp: 0,
    },
    "image:failed": {
      errorKind: "content_blocked",
      provider: "openai",
      timestamp: 0,
    },
    // Vision-analysis lifecycle — the envelope-only
    // correlation invariant must hold for them too (no agentId/sessionKey leak).
    "media.vision:requested": {
      provider: "anthropic",
      mainProvider: "anthropic",
      timestamp: 0,
    },
    "media.vision:completed": {
      provider: "anthropic",
      mainProvider: "anthropic",
      model: "claude-sonnet-4-5",
      costUsd: 0.002,
      path: "main-vision",
      outcome: "ok",
      timestamp: 0,
    },
    "media.vision:failed": {
      errorKind: "empty_response",
      path: "main-vision",
      provider: "anthropic",
      mainProvider: "anthropic",
      timestamp: 0,
    },
    // Video-generation lifecycle — the envelope-only
    // correlation invariant must hold for them too (no agentId/sessionKey leak).
    "video:requested": {
      provider: "veo",
      mainProvider: "google",
      timestamp: 0,
    },
    "video:submitted": {
      provider: "veo",
      jobId: "veo-op-123",
      timestamp: 0,
    },
    "video:generated": {
      provider: "veo",
      model: "veo-3.1",
      costUsd: 1.2,
      sizeBytes: 9_000_000,
      durationSecs: 8,
      outcome: "ok",
      timestamp: 0,
    },
    "video:delivered": {
      channelType: "telegram",
      delivered: true,
      timestamp: 0,
    },
    "video:failed": {
      errorKind: "content_blocked",
      provider: "veo",
      timestamp: 0,
    },
    // Voice STT/TTS lifecycle — the envelope-only
    // correlation invariant must hold for them too (no agentId/sessionKey/traceId
    // leak; onSkip is a closed rung-list, NOT an envelope key — it stays).
    "media.stt:requested": {
      provider: "local",
      keyless: true,
      source: "keyless-local",
      onSkip: ["fallback \"openai\" skipped: no key"],
      timestamp: 0,
    },
    "media.stt:completed": {
      provider: "local",
      keyless: true,
      model: "base",
      durationMs: 1200,
      audioBytes: 5000,
      costUsd: 0,
      source: "keyless-local",
      timestamp: 0,
    },
    "media.stt:failed": {
      errorKind: "model_load_failed",
      provider: "local",
      source: "keyless-local",
      timestamp: 0,
    },
    "media.tts:requested": {
      provider: "edge",
      keyless: true,
      source: "keyless-local",
      timestamp: 0,
    },
    "media.tts:completed": {
      provider: "edge",
      keyless: true,
      model: "en-US-AriaNeural",
      durationMs: 700,
      costUsd: 0,
      source: "keyless-local",
      timestamp: 0,
    },
    "media.tts:failed": {
      errorKind: "network",
      provider: "edge",
      source: "explicit",
      timestamp: 0,
    },
    // Counts/enums/booleans only — the correlation invariant must hold
    // (no agentId/sessionKey leak into the trajectory record data).
    "pipeline:authored": {
      action: "execute",
      capabilityClass: "small",
      schemaValid: true,
      repaired: false,
      timestamp: 0,
    },
    "graph:repaired": {
      pattern: "debate",
      nodeCount: 3,
      capabilityClass: "small",
      timestamp: 0,
    },
    "graph:synthesized_from_intent": {
      pattern: "research-fanout",
      nodeCount: 4,
      timestamp: 0,
    },
    // Counts/ids + the closed-union mode only — the correlation
    // invariant must hold (no sessionKey/traceId leak into the record data).
    "subagent:steered": {
      runId: "run-1",
      agentId: "agent-1",
      mode: "steer",
      timestamp: 0,
    },
    // The three sub-agent-lifecycle events — the correlation invariant
    // must hold (agent ids / timestamp never leak into data).
    "security:sandbox_downgrade_refused": {
      parentAgentId: "researcher",
      childAgentId: "unconfined-child",
      violatedDimensions: ["exec"],
      parentPosture: { exec: "always" },
      childPosture: { exec: "never" },
      timestamp: 0,
    },
    "subagent:delivery_deadlettered": {
      runId: "run-dl",
      channelType: "telegram",
      attempt: 3,
      transient: true,
      timestamp: 0,
    },
    "subagent:delivery_retried": {
      runId: "run-rt",
      channelType: "telegram",
      attempt: 2,
      transient: true,
      timestamp: 0,
    },
    "subagent:budget_exceeded": {
      graphId: "g1",
      nodeId: "greedy",
      agentId: "researcher",
      tokenBudget: 5000,
      tokensUsed: 17770,
      capSource: "node",
      timestamp: 0,
    },
    // The per-cap audit — the correlation invariant must
    // hold (agentId/traceId/sessionKey/sessionId never leak into data).
    "capability:audited": {
      capability: "orch:read",
      tool: "memory_search",
      method: "tool.invoke",
      decision: "allow",
      rootRunId: "run-1",
      leaseId: "lease-abc",
      parentLeaseId: "lease-root",
      agentId: "agent-1",
      timestamp: 0,
    },
    // The per-graph-node spawn-tree leaf. The child agentId
    // rides `nodeAgentId` (data), NOT the correlation key `agentId` (envelope-only) —
    // the strip invariant still holds (data.agentId never set by the translator).
    "graph:node_spawned": {
      graphId: "g1",
      nodeId: "analyst-0",
      rootRunId: "run-1",
      agentId: "analyst",
      tokenBudget: 5000,
      timestamp: 0,
    },
    // Spend kill-switch — content-free (scope enum + $ numbers
    // + provider/model config ids); the envelope correlation keys are stripped.
    "observability:spend_warning": {
      scope: "tenant",
      spentUsd: 8.4,
      capUsd: 10,
      fraction: 0.8,
      timestamp: 0,
    },
    "observability:spend_exceeded": {
      scope: "global",
      spentUsd: 99.5,
      capUsd: 100,
      estUsd: 0.75,
      timestamp: 0,
    },
    "observability:spend_unpriceable": {
      provider: "anthropic",
      model: "claude-opus-4",
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

describe("TRAJECTORY_BRIDGE_MAPPING -- pipeline:authored (arch-closure)", () => {
  it("maps pipeline:authored -> pipeline.authored (mirrors the memory:generation_quality entry)", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["pipeline:authored"]).toBe("pipeline.authored");
  });

  it("pipeline:authored is a member of TrajectoryBridgedEventName (keyof the mapping — EventMap-membership arch closure)", () => {
    // keyof closure: the key is enumerable on the const mapping (the arch test
    // enumerates Object.keys to confirm every EventMap member is mapped-or-allowlisted).
    const keys = Object.keys(TRAJECTORY_BRIDGE_MAPPING);
    expect(keys).toContain("pipeline:authored");
    // The reserved trajectory type name is a valid TrajectoryEventType.
    const allTypes = new Set<string>(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(allTypes.has("pipeline.authored")).toBe(true);
  });

  it("bridge translates pipeline:authored to a content-free record (counts/enums/booleans only)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("pipeline:authored", {
      action: "execute",
      capabilityClass: "small",
      schemaValid: false,
      repaired: false,
      agentId: "agent-X",
      sessionKey: "skey-X",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("pipeline.authored");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    // The counts/enums/booleans cross; the correlation ids are envelope-only.
    expect(data.action).toBe("execute");
    expect(data.capabilityClass).toBe("small");
    expect(data.schemaValid).toBe(false);
    expect(data.repaired).toBe(false);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    // No pipeline body / type_config ever crosses the bridge.
    for (const forbidden of ["nodes", "graph", "type_config", "typeConfig", "task", "label", "body"]) {
      expect(data[forbidden], `forbidden body key on trajectory record: ${forbidden}`).toBeUndefined();
    }
  });
});

describe("TRAJECTORY_BRIDGE_MAPPING -- graph:repaired + graph:synthesized_from_intent (arch-closure)", () => {
  it("maps graph:repaired -> graph.repaired (mirrors the pipeline:authored entry)", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["graph:repaired"]).toBe("graph.repaired");
  });

  it("maps graph:synthesized_from_intent -> graph.synthesized_from_intent", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["graph:synthesized_from_intent"]).toBe(
      "graph.synthesized_from_intent",
    );
  });

  it("both AUTHOR events are members of TrajectoryBridgedEventName (keyof the mapping — EventMap-membership arch closure)", () => {
    const keys = Object.keys(TRAJECTORY_BRIDGE_MAPPING);
    expect(keys).toContain("graph:repaired");
    expect(keys).toContain("graph:synthesized_from_intent");
    // The reserved trajectory type names are valid TrajectoryEventType members.
    const allTypes = new Set<string>(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(allTypes.has("graph.repaired")).toBe(true);
    expect(allTypes.has("graph.synthesized_from_intent")).toBe(true);
  });

  it("bridge translates graph:repaired to a content-free record (pattern enum + nodeCount + tier only)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("graph:repaired", {
      pattern: "debate",
      nodeCount: 3,
      capabilityClass: "small",
      agentId: "agent-X",
      sessionKey: "skey-X",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("graph.repaired");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    // The closed enum + counts cross; the correlation ids are envelope-only.
    expect(data.pattern).toBe("debate");
    expect(data.nodeCount).toBe(3);
    expect(data.capabilityClass).toBe("small");
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    // No graph body / type_config / task ever crosses the bridge.
    for (const forbidden of ["nodes", "graph", "type_config", "typeConfig", "task", "label", "body", "intent"]) {
      expect(data[forbidden], `forbidden body key on trajectory record: ${forbidden}`).toBeUndefined();
    }
  });

  it("bridge translates graph:synthesized_from_intent to a content-free record (NO intent text crosses)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("graph:synthesized_from_intent", {
      pattern: "research-fanout",
      nodeCount: 4,
      agentId: "agent-X",
      sessionKey: "skey-X",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("graph.synthesized_from_intent");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    expect(data.pattern).toBe("research-fanout");
    expect(data.nodeCount).toBe(4);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    // The intent text (the highest-risk synthesis leak) heads the forbidden set.
    for (const forbidden of ["intent", "nodes", "graph", "type_config", "typeConfig", "task", "label", "body"]) {
      expect(data[forbidden], `forbidden body key on trajectory record: ${forbidden}`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The subagent:steered event — bridge-mapped
// for OPERATOR TRAJECTORY VISIBILITY (a steer is a meaningful per-session event
// an operator wants in `comis explain`), mirroring the authoring entries
// (pipeline:authored / graph:repaired / graph:synthesized_from_intent). This is
// a recording choice, NOT a closure-gate requirement: the closure gate scans
// agent/orchestrator emit sites only and subagent:steered is daemon-emitted
// (subagent-handlers.ts) — so it does not trip the gate (the unmapped
// subagent:budget_exceeded precedent). The translator is content-free: runId/
// agentId/mode counts/ids ONLY — NEVER the steer message body.
// ---------------------------------------------------------------------------
describe("TRAJECTORY_BRIDGE_MAPPING -- subagent:steered (operator visibility)", () => {
  it("maps subagent:steered -> subagent.steered (mirrors the graph:repaired entry)", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["subagent:steered"]).toBe("subagent.steered");
  });

  it("subagent:steered is a member of TrajectoryBridgedEventName + subagent.steered is a valid TrajectoryEventType (arch closure)", () => {
    const keys = Object.keys(TRAJECTORY_BRIDGE_MAPPING);
    expect(keys).toContain("subagent:steered");
    const allTypes = new Set<string>(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(allTypes.has("subagent.steered")).toBe(true);
  });

  it("bridge translates subagent:steered to a content-free record (runId/agentId/mode only — NO message body crosses)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("subagent:steered", {
      runId: "run-77",
      agentId: "agent-X",
      mode: "steer",
      sessionKey: "skey-X",
      traceId: "trace-X",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("subagent.steered");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    // The run identity + the closed-union mode cross.
    expect(data.runId).toBe("run-77");
    expect(data.mode).toBe("steer");
    // agentId/sessionKey/traceId are envelope-only correlation ids handled by the
    // recorder envelope (TrajectoryRecorderInit + AsyncLocalStorage) — the
    // translator MUST NOT echo them into data (the graph:repaired precedent).
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.traceId).toBeUndefined();
    // The steer MESSAGE BODY (the highest-risk leak) must NEVER cross the bridge.
    for (const forbidden of ["message", "text", "body", "content"]) {
      expect(data[forbidden], `forbidden body key on trajectory record: ${forbidden}`).toBeUndefined();
    }
  });

  it("the followup mode round-trips through the bridge (closed-union steer|followup)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("subagent:steered", {
      runId: "run-78",
      agentId: "agent-Y",
      mode: "followup",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    expect(data.mode).toBe("followup");
  });
});

// ---------------------------------------------------------------------------
// Three sub-agent-lifecycle
// events bridged for per-session `comis explain` visibility (the subagent:steered
// daemon-side precedent). Content-free: closed labels/ids/numbers ONLY — never a
// path/host/uid value (sandbox), an announcement/error body (delivery), or a task
// (budget).
// ---------------------------------------------------------------------------

describe("TRAJECTORY_BRIDGE_MAPPING -- sub-agent lifecycle (operator visibility)", () => {
  it("maps the four events to their reserved trajectory types (arch closure)", () => {
    expect(TRAJECTORY_BRIDGE_MAPPING["security:sandbox_downgrade_refused"]).toBe("security.sandbox_downgrade_refused");
    expect(TRAJECTORY_BRIDGE_MAPPING["subagent:delivery_deadlettered"]).toBe("subagent.delivery_deadlettered");
    // delivery_retried is emitted (announcement-batcher) via `?.emit`. It is the
    // sibling of delivery_deadlettered and must be reconstructable in `comis explain`
    // (the self-healing retry visibility).
    expect(TRAJECTORY_BRIDGE_MAPPING["subagent:delivery_retried"]).toBe("subagent.delivery_retried");
    expect(TRAJECTORY_BRIDGE_MAPPING["subagent:budget_exceeded"]).toBe("subagent.budget_exceeded");
    const allTypes = new Set<string>(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(allTypes.has("security.sandbox_downgrade_refused")).toBe(true);
    expect(allTypes.has("subagent.delivery_deadlettered")).toBe(true);
    expect(allTypes.has("subagent.delivery_retried")).toBe(true);
    expect(allTypes.has("subagent.budget_exceeded")).toBe(true);
  });

  it("translates security:sandbox_downgrade_refused to dimensions ONLY (no posture values / path / host / uid topology, no agent ids)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("security:sandbox_downgrade_refused", {
      timestamp: 1000,
      parentAgentId: "researcher",
      childAgentId: "unconfined-child",
      violatedDimensions: ["exec", "network"],
      parentPosture: { exec: "always", filesystem: "workspace", network: "none" },
      childPosture: { exec: "never", filesystem: "full", network: "full" },
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("security.sandbox_downgrade_refused");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    expect(data.dimensions).toEqual(["exec", "network"]);
    // The fail-closed posture VALUES + the agent ids never cross (topology leak guard).
    const serialized = JSON.stringify(data);
    expect(serialized).not.toMatch(/workspace|"full"|"none"|researcher|unconfined-child/);
    expect(data.parentPosture).toBeUndefined();
    expect(data.childPosture).toBeUndefined();
    expect(data.parentAgentId).toBeUndefined();
  });

  it("translates subagent:delivery_deadlettered to runId/channelType/transient ONLY (no announcement/error body)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("subagent:delivery_deadlettered", {
      runId: "run-dl",
      channelType: "telegram",
      attempt: 3,
      transient: true,
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("subagent.delivery_deadlettered");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    expect(data).toEqual({ runId: "run-dl", channelType: "telegram", transient: true });
    for (const forbidden of ["message", "text", "body", "content", "error"]) {
      expect(data[forbidden]).toBeUndefined();
    }
  });

  it("translates subagent:delivery_retried to runId/channelType/attempt/transient ONLY (no announcement/error body)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("subagent:delivery_retried", {
      runId: "run-rt",
      channelType: "telegram",
      attempt: 2,
      transient: true,
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("subagent.delivery_retried");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    expect(data).toEqual({ runId: "run-rt", channelType: "telegram", attempt: 2, transient: true });
    for (const forbidden of ["message", "text", "body", "content", "error"]) {
      expect(data[forbidden]).toBeUndefined();
    }
  });

  it("translates subagent:budget_exceeded to the per-incident breach view (graphId/nodeId/capSource/tokenBudget/tokensUsed — explain wants the numbers)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("subagent:budget_exceeded", {
      graphId: "g1",
      nodeId: "greedy",
      agentId: "researcher",
      tokenBudget: 5000,
      tokensUsed: 17770,
      capSource: "node",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.type).toBe("subagent.budget_exceeded");
    const data = recorder.calls[0]!.data as Record<string, unknown>;
    expect(data).toEqual({ graphId: "g1", nodeId: "greedy", capSource: "node", tokenBudget: 5000, tokensUsed: 17770 });
    // agentId is envelope-only (the steered precedent).
    expect(data.agentId).toBeUndefined();
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
// Queue, Execution, Security, Sender bridge tests
// ---------------------------------------------------------------------------

describe("queue + execution + sender bridge", () => {
  // ---- Queue lifecycle events ----

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

  // ---- Execution lifecycle events ----

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

  it("execution_aborted forwards the perRootBudget limb payload onto the record (the explain spend-verdict's input)", () => {
    // The spend verdict names autonomy.budget.<limb> ONLY when the terminal
    // execution.aborted record carries perRootBudget — a dropped payload here
    // silently degrades the verdict to the observability.spend.* misdirection
    // (the wired-but-untested emit class that has gone obs-dark before).
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:aborted", {
      sessionKey: "t1:u1:c1" as any,
      reason: "spend_exceeded",
      agentId: "agent-1",
      timestamp: Date.now(),
      perRootBudget: { limb: "aggregateUsd", spent: 2.04, cap: 2, unit: "usd" },
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("spend_exceeded");
    expect(data.perRootBudget).toEqual({ limb: "aggregateUsd", spent: 2.04, cap: 2, unit: "usd" });
  });

  it("activity_turn_finalized maps to activity.turn_finalized carrying the terminal user-surface state", () => {
    // The pill's terminal state (kept ❌ label vs deleted scaffold) is derived
    // from this outcome + strategy — without the record, explaining what the
    // user's chat showed requires the platform screenshot (observed live).
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("activity:turn_finalized", {
      sessionKey: "t1:u1:c1",
      agentId: "agent-1",
      channelType: "telegram",
      strategy: "EditPlace",
      outcome: "failure",
      errorKind: "resource",
      reason: "stopped — spend limit reached",
      reclassified: false,
      failedEventCount: 1,
      timestamp: Date.now(),
    } as any);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("activity.turn_finalized");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.strategy).toBe("EditPlace");
    expect(data.outcome).toBe("failure");
    expect(data.errorKind).toBe("resource");
    expect(data.reason).toBe("stopped — spend limit reached");
    expect(data.reclassified).toBe(false);
  });

  it("tool_executed forwards a failure's argsPreview onto the tool.result record (the input the failed call attempted)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("tool:executed", {
      toolName: "edit",
      toolCallId: "tc-e",
      durationMs: 7,
      success: false,
      errorKind: "validation",
      errorMessage: "[text_not_found] ...",
      argsPreview: { path: "IDENTITY.md", edits: "[244 chars]" },
      timestamp: Date.now(),
    } as any);

    const rec = recorder.calls.find((c) => c.type === "tool.result");
    expect(rec).toBeDefined();
    const data = rec!.data as Record<string, unknown>;
    expect(data.argsPreview).toEqual({ path: "IDENTITY.md", edits: "[244 chars]" });
  });

  it("execution_recovery_attempted maps to execution.recovery_attempted carrying the closed reason + succeeded", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:recovery_attempted", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      reason: "silent_retry",
      succeeded: true,
      timestamp: Date.now(),
    } as any);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.recovery_attempted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("silent_retry");
    expect(data.succeeded).toBe(true);
    // Correlation keys stripped (envelope-only invariant).
    expect(data.sessionKey).toBeUndefined();
    expect(data.agentId).toBeUndefined();
  });

  it("delivery_aborted maps to delivery.aborted carrying chunk counts + the abort reason", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("delivery:aborted", {
      channelId: "chat-1",
      channelType: "telegram",
      reason: "spend_exceeded",
      chunksDelivered: 0,
      totalChunks: 2,
      durationMs: 5,
      origin: "agent",
      timestamp: Date.now(),
    } as any);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("delivery.aborted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.reason).toBe("spend_exceeded");
    expect(data.chunksDelivered).toBe(0);
    expect(data.totalChunks).toBe(2);
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

  // The enriched execution:prompt_timeout payload
  // must forward ALL attribution fields through the translator — the known
  // silent-failure mode is extending the event but missing the
  // translator, which silently drops the evidence from `comis explain`.
  it("enriched execution_prompt_timeout forwards durationMs/limit/source/bindingKnob/stallBudgetMs/makespanMs verbatim; envelope keys stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:prompt_timeout", {
      agentId: "my-agent",
      sessionKey: "t1:u1:c1",
      timeoutMs: 180_000,
      timestamp: Date.now(),
      durationMs: 195_000,
      limit: "stall",
      source: "agent_config",
      bindingKnob: "agents.my-agent.promptTimeout.promptTimeoutMs",
      operationType: undefined,
      stallBudgetMs: 180_000,
      makespanMs: 1_800_000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.prompt_timeout");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.timeoutMs).toBe(180_000);
    expect(data.durationMs).toBe(195_000);
    expect(data.limit).toBe("stall");
    expect(data.source).toBe("agent_config");
    expect(data.bindingKnob).toBe("agents.my-agent.promptTimeout.promptTimeoutMs");
    expect(data.stallBudgetMs).toBe(180_000);
    expect(data.makespanMs).toBe(1_800_000);
    // operationType was undefined at the emit — must not materialize as a key.
    expect("operationType" in data).toBe(false);
    // Envelope-only correlation keys are stripped from data (the house style).
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("a LEGACY prompt_timeout payload (no extended fields) still translates to exactly {timeoutMs} — no undefined-keyed fields", () => {
    // Back-compat guard: an emitter/row carrying only the original four fields
    // (no extended attribution) must still translate cleanly — the conditional
    // spreads must not materialize undefined-keyed entries on the persisted row.
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("execution:prompt_timeout", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timeoutMs: 30_000,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data).toEqual({ timeoutMs: 30_000 });
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

  // The GBNF strip-retry self-heal event must be
  // registered + bridged BEFORE the executor emit lands so the architecture
  // test (trajectory-event-types-known) can never catch an unmapped emit.
  // Payload is content-free: tool + keyword NAMES only — never schema
  // bodies and never the raw provider error body.
  it("execution_tool_schema_unsupported_maps_to_execution.tool_schema_unsupported with toolNames/strippedKeywords/retried/succeeded; agentId/sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    // Mapping entry locked: "execution:tool_schema_unsupported" →
    // "execution.tool_schema_unsupported" (full name — NOT shortened like
    // signed_replay_recovered → replay_recovered).
    expect(
      (TRAJECTORY_BRIDGE_MAPPING as Record<string, string>)["execution:tool_schema_unsupported"],
    ).toBe("execution.tool_schema_unsupported");
    // The canonical record kind must be in the closed TrajectoryEventType union.
    expect(TRAJECTORY_EVENT_TYPES).toContain("execution.tool_schema_unsupported");

    bus.emit("execution:tool_schema_unsupported" as keyof EventMap, {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      toolNames: ["schedule_task"],
      strippedKeywords: ["pattern", "format"],
      retried: true,
      succeeded: false,
      reason: "stripped",
      timestamp: Date.now(),
    } as never);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("execution.tool_schema_unsupported");
    const data = recorder.calls[0].data as Record<string, unknown>;
    // All 5 payload fields survive translation (the explain heuristic input).
    expect(data.toolNames).toEqual(["schedule_task"]);
    expect(data.strippedKeywords).toEqual(["pattern", "format"]);
    expect(data.retried).toBe(true);
    expect(data.succeeded).toBe(false);
    // The branch discriminator must reach the trajectory
    // so gate-closed and nothing-to-strip terminals stay distinguishable.
    expect(data.reason).toBe("stripped");
    // Envelope-only correlation keys are stripped from data.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  // ---- Security + Sender (scanned subset) ----

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

  it("TRAJECTORY_BRIDGE_MAPPING contains all 11 new queue/execution/security/sender keys", () => {
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

// ---------------------------------------------------------------------------
// Retry (delivery), MCP server, Channel lifecycle + health
// ---------------------------------------------------------------------------

describe("retry + mcp + channel bridge", () => {
  // ---- Retry (delivery reliability) events ----

  it("retry_attempted_maps_to_delivery.retry with attempt/maxAttempts/delayMs/error; chatId+channelId MUST NOT be forwarded (PII invariant)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("retry:attempted", {
      channelId: "chan-tg-1",
      chatId: "12345678901",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
      error: "ETIMEDOUT",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("delivery.retry");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // Retry telemetry fields must be present.
    expect(data.attempt).toBe(2);
    expect(data.maxAttempts).toBe(5);
    expect(data.delayMs).toBe(1000);
    expect(data.error).toBe("ETIMEDOUT");

    // chatId (Telegram long-decimal ID) must NEVER appear.
    expect(data.chatId).toBeUndefined();
    expect("chatId" in data).toBe(false);

    // channelId (channel correlator) must NEVER appear.
    expect(data.channelId).toBeUndefined();
    expect("channelId" in data).toBe(false);

    // timestamp is envelope noise — omit.
    expect(data.timestamp).toBeUndefined();
  });

  it("retry_exhausted_maps_to_delivery.retry_exhausted with totalAttempts/finalError; chatId+channelId omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("retry:exhausted", {
      channelId: "chan-tg-1",
      chatId: "98765432100",
      totalAttempts: 5,
      finalError: "Connection refused",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("delivery.retry_exhausted");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.totalAttempts).toBe(5);
    expect(data.finalError).toBe("Connection refused");

    // chatId and channelId must NEVER appear.
    expect(data.chatId).toBeUndefined();
    expect("chatId" in data).toBe(false);
    expect(data.channelId).toBeUndefined();
    expect("channelId" in data).toBe(false);
    expect(data.timestamp).toBeUndefined();
  });

  it("retry_markdown_fallback_maps_to_delivery.markdown_fallback with originalParseMode; chatId+channelId omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("retry:markdown_fallback", {
      channelId: "chan-tg-1",
      chatId: "11122233344",
      originalParseMode: "MarkdownV2",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("delivery.markdown_fallback");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.originalParseMode).toBe("MarkdownV2");

    // chatId and channelId must NEVER appear.
    expect(data.chatId).toBeUndefined();
    expect("chatId" in data).toBe(false);
    expect(data.channelId).toBeUndefined();
    expect("channelId" in data).toBe(false);
    expect(data.timestamp).toBeUndefined();
  });

  // ---- MCP server reliability events ----

  it("mcp_server_disconnected_maps_to_mcp.disconnected with serverName+reason; timestamp omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("mcp:server:disconnected", {
      serverName: "filesystem-server",
      reason: "transport_closed",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("mcp.disconnected");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.serverName).toBe("filesystem-server");
    expect(data.reason).toBe("transport_closed");
    expect(data.timestamp).toBeUndefined();
  });

  it("mcp_server_reconnecting_maps_to_mcp.reconnecting with serverName/attempt/maxAttempts/nextDelayMs; timestamp omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("mcp:server:reconnecting", {
      serverName: "filesystem-server",
      attempt: 2,
      maxAttempts: 5,
      nextDelayMs: 2000,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("mcp.reconnecting");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.serverName).toBe("filesystem-server");
    expect(data.attempt).toBe(2);
    expect(data.maxAttempts).toBe(5);
    expect(data.nextDelayMs).toBe(2000);
    expect(data.timestamp).toBeUndefined();
  });

  it("mcp_server_reconnect_failed_maps_to_mcp.reconnect_failed with serverName/attempts/lastError; timestamp omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("mcp:server:reconnect_failed", {
      serverName: "filesystem-server",
      attempts: 5,
      lastError: "ECONNREFUSED",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("mcp.reconnect_failed");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.serverName).toBe("filesystem-server");
    expect(data.attempts).toBe(5);
    expect(data.lastError).toBe("ECONNREFUSED");
    expect(data.timestamp).toBeUndefined();
  });

  it("mcp_server_reconnected_maps_to_mcp.reconnected with serverName/attempt/toolCount/durationMs; timestamp omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("mcp:server:reconnected", {
      serverName: "filesystem-server",
      attempt: 2,
      toolCount: 12,
      durationMs: 350,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("mcp.reconnected");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.serverName).toBe("filesystem-server");
    expect(data.attempt).toBe(2);
    expect(data.toolCount).toBe(12);
    expect(data.durationMs).toBe(350);
    expect(data.timestamp).toBeUndefined();
  });

  it("mcp_server_tools_changed_maps_to_mcp.tools_changed with serverName/previousToolCount/currentToolCount/addedTools/removedTools; timestamp omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("mcp:server:tools_changed", {
      serverName: "filesystem-server",
      previousToolCount: 10,
      currentToolCount: 12,
      addedTools: ["read_file", "write_file"],
      removedTools: [],
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("mcp.tools_changed");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.serverName).toBe("filesystem-server");
    expect(data.previousToolCount).toBe(10);
    expect(data.currentToolCount).toBe(12);
    expect(data.addedTools).toEqual(["read_file", "write_file"]);
    expect(data.removedTools).toEqual([]);
    expect(data.timestamp).toBeUndefined();
  });

  // ---- Channel lifecycle + health events ----

  it("channel_health_changed_maps_to_channel.health_changed with channelType/previousState/currentState/connectionMode; lastMessageAt+timestamp omitted; error forwarded conditionally", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("channel:health_changed", {
      channelType: "telegram",
      previousState: "healthy",
      currentState: "degraded",
      connectionMode: "polling",
      error: "Connection timeout",
      lastMessageAt: Date.now() - 60000,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("channel.health_changed");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.channelType).toBe("telegram");
    expect(data.previousState).toBe("healthy");
    expect(data.currentState).toBe("degraded");
    expect(data.connectionMode).toBe("polling");
    expect(data.error).toBe("Connection timeout");

    // lastMessageAt and timestamp are noise — omit.
    expect(data.lastMessageAt).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("channel_health_changed_omits_error_from_data_when_error_is_null (conditional spread)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("channel:health_changed", {
      channelType: "discord",
      previousState: "degraded",
      currentState: "healthy",
      connectionMode: "socket",
      error: null,
      lastMessageAt: null,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.channelType).toBe("discord");
    expect(data.currentState).toBe("healthy");
    // error: null → should NOT appear in data (conditional spread).
    expect(data.error).toBeUndefined();
    expect("error" in data).toBe(false);
  });

  it("channel_registered_maps_to_channel.lifecycle with channelType/pluginId/event:registered; capabilities omitted", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("channel:registered", {
      channelType: "telegram",
      pluginId: "tg-plugin",
      capabilities: { supportsEditing: true, supportsReactions: false } as any,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("channel.lifecycle");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.channelType).toBe("telegram");
    expect(data.pluginId).toBe("tg-plugin");
    // Synthetic discriminator — distinguishes registered from deregistered.
    expect(data.event).toBe("registered");

    // capabilities is omitted (noisy, not diagnostically useful for trajectory).
    expect(data.capabilities).toBeUndefined();
    expect("capabilities" in data).toBe(false);
    expect(data.timestamp).toBeUndefined();
  });

  it("channel_deregistered_maps_to_channel.lifecycle with channelType/pluginId/event:deregistered (same type, different discriminator)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("channel:deregistered", {
      channelType: "discord",
      pluginId: "discord-plugin",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    // SAME type as channel:registered — channel.lifecycle.
    expect(recorder.calls[0].type).toBe("channel.lifecycle");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.channelType).toBe("discord");
    expect(data.pluginId).toBe("discord-plugin");
    // Synthetic discriminator must be "deregistered" (not "registered").
    expect(data.event).toBe("deregistered");
    expect(data.timestamp).toBeUndefined();
  });

  it("channel_lifecycle_dual_mapping: registered and deregistered produce same type but different event discriminators", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("channel:registered", {
      channelType: "telegram",
      pluginId: "tg-plugin",
      capabilities: {} as any,
      timestamp: Date.now(),
    });

    bus.emit("channel:deregistered", {
      channelType: "telegram",
      pluginId: "tg-plugin",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(2);

    // Both produce channel.lifecycle.
    expect(recorder.calls[0].type).toBe("channel.lifecycle");
    expect(recorder.calls[1].type).toBe("channel.lifecycle");

    const data0 = recorder.calls[0].data as Record<string, unknown>;
    const data1 = recorder.calls[1].data as Record<string, unknown>;

    // But discriminators are distinct.
    expect(data0.event).toBe("registered");
    expect(data1.event).toBe("deregistered");
  });

  // ---- Coverage spot-check ----

  it("TRAJECTORY_BRIDGE_MAPPING contains all 11 new retry/mcp/channel keys and total mapping is ≥ 40", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    const expected = [
      // retry
      "retry:attempted",
      "retry:exhausted",
      "retry:markdown_fallback",
      // mcp
      "mcp:server:disconnected",
      "mcp:server:reconnecting",
      "mcp:server:reconnect_failed",
      "mcp:server:reconnected",
      "mcp:server:tools_changed",
      // channel
      "channel:health_changed",
      "channel:registered",
      "channel:deregistered",
    ];
    for (const key of expected) {
      expect(mapping[key], `TRAJECTORY_BRIDGE_MAPPING missing key: ${key}`).toBeDefined();
    }
    // Both channel registration events map to channel.lifecycle.
    expect(mapping["channel:registered"]).toBe("channel.lifecycle");
    expect(mapping["channel:deregistered"]).toBe("channel.lifecycle");
    // Total bridge size should be ≥ 40 (29 existing + 11 new).
    expect(Object.keys(mapping).length).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Security (rest), Compaction, Context, Approval
// ---------------------------------------------------------------------------

describe("security + compaction + context + approval bridge", () => {
  // ---- security:memory_tainted + security:warn ----

  it("security_memory_tainted_maps_to_security.memory_tainted with originalTrustLevel/adjustedTrustLevel/blocked; patterns[] MUST NOT be forwarded (security invariant)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("security:memory_tainted", {
      agentId: "agent-1",
      originalTrustLevel: "trusted",
      adjustedTrustLevel: "tainted",
      patterns: ["malicious-pattern", "exploit-string"],
      blocked: true,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("security.memory_tainted");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // Trust level fields must be present.
    expect(data.originalTrustLevel).toBe("trusted");
    expect(data.adjustedTrustLevel).toBe("tainted");
    expect(data.blocked).toBe(true);

    // patterns[] must NOT appear — verbatim injection strings.
    expect(data.patterns).toBeUndefined();
    expect("patterns" in data).toBe(false);

    // Envelope-only fields must be stripped.
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("security_warn_maps_to_security.warn with category only; message MUST NOT be forwarded (PII invariant)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("security:warn", {
      category: "secret_access",
      agentId: "agent-1",
      message: "Agent accessed /etc/secrets without explicit allow",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("security.warn");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // Only category in data.
    expect(data.category).toBe("secret_access");

    // message must NOT appear — may reference secrets/config paths.
    expect(data.message).toBeUndefined();
    expect("message" in data).toBe(false);

    // Envelope-only fields must be stripped.
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  // ---- Compaction events ----

  it("compaction_started_maps_to_compaction.started with empty data object (all fields are envelope-only)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("compaction:started", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("compaction.started");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // All source fields are envelope-only (agentId, sessionKey, timestamp) — data must be empty.
    expect(Object.keys(data)).toHaveLength(0);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("compaction_flush_maps_to_compaction.flush with memoriesWritten/trigger/success; sessionKey stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("compaction:flush", {
      sessionKey: "t1:u1:c1",
      memoriesWritten: 12,
      trigger: "threshold",
      success: true,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("compaction.flush");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.memoriesWritten).toBe(12);
    expect(data.trigger).toBe("threshold");
    expect(data.success).toBe(true);
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("compaction_recommended_maps_to_compaction.recommended with contextPercent/contextTokens/contextWindow; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("compaction:recommended", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      contextPercent: 0.85,
      contextTokens: 170000,
      contextWindow: 200000,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("compaction.recommended");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.contextPercent).toBeCloseTo(0.85);
    expect(data.contextTokens).toBe(170000);
    expect(data.contextWindow).toBe(200000);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  // ---- Context engine events ----

  it("context_evicted_maps_to_context.evicted with evictedCount/evictedChars/categories; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:evicted", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      evictedCount: 5,
      evictedChars: 2000,
      categories: { tool_result: 5 },
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.evicted");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.evictedCount).toBe(5);
    expect(data.evictedChars).toBe(2000);
    expect(data.categories).toEqual({ tool_result: 5 });
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_budget_computed_maps_to_context.budget forwarding the budget equation; envelope stripped", () => {
    // W2 (obs-llm-troubleshooting): the per-call budget equation must land in the
    // trajectory so obs.explain can report WHY a context_exhausted turn aborted
    // (live incident: the numbers existed only as daemon-log DEBUG lines).
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:budget_computed", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall",
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: 31_572,
      outputHeadroom: 768,
      verdict: "exhausted",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.budget");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.windowTokens).toBe(32_000);
    expect(data.rawContextWindowTokens).toBe(131_072);
    expect(data.windowCapSource).toBe("effectiveContextCapSmall");
    expect(data.systemTokens).toBe(25_694);
    expect(data.freshTailTokens).toBe(5_272);
    expect(data.budgetedHistoryTokens).toBe(0);
    expect(data.keptCount).toBe(0);
    expect(data.assembledInputTokens).toBe(31_572);
    expect(data.outputHeadroom).toBe(768);
    expect(data.verdict).toBe("exhausted");
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
  });

  // The two multilingual signals on the explain path — the bridge forwards
  // scriptClass/lane/conversationId (envelope correlation keys stripped).
  it("context_script_zero_hit_maps_to_context.script_zero_hit forwarding scriptClass/lane/conversationId; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:script_zero_hit", {
      conversationId: "t1:u1:c1",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      scriptClass: "hebrew",
      lane: "tri",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.script_zero_hit");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.scriptClass).toBe("hebrew");
    expect(data.lane).toBe("tri");
    expect(data.conversationId).toBe("t1:u1:c1");
    // Envelope-only fields are stripped from data (the budget_computed precedent).
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_summary_language_mismatch_maps_to_context.summary_language_mismatch forwarding sourceScript/summaryScript/depth; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:summary_language_mismatch", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      sourceScript: "hebrew",
      summaryScript: "latin",
      depth: 1,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.summary_language_mismatch");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.sourceScript).toBe("hebrew");
    expect(data.summaryScript).toBe("latin");
    expect(data.depth).toBe(1);
    // Envelope-only fields are stripped from data.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_masked_maps_to_context.masked with maskedCount/totalChars/persistedToDisk; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:masked", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      maskedCount: 3,
      totalChars: 500,
      persistedToDisk: true,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.masked");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.maskedCount).toBe(3);
    expect(data.totalChars).toBe(500);
    expect(data.persistedToDisk).toBe(true);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_reread_maps_to_context.reread with rereadCount/rereadTools; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:reread", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      rereadCount: 2,
      rereadTools: ["bash", "read_file"],
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.reread");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.rereadCount).toBe(2);
    expect(data.rereadTools).toEqual(["bash", "read_file"]);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_overflow_maps_to_context.overflow with contextTokens/budgetTokens/recoveryAction; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:overflow", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      contextTokens: 205000,
      budgetTokens: 200000,
      recoveryAction: "evict",
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.overflow");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.contextTokens).toBe(205000);
    expect(data.budgetTokens).toBe(200000);
    expect(data.recoveryAction).toBe("evict");
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_integrity_maps_to_context.integrity with conversationId/issueCount/repairsApplied/errorsLogged/issueTypes/durationMs; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:integrity", {
      conversationId: "conv-123",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      issueCount: 2,
      repairsApplied: 1,
      errorsLogged: 0,
      issueTypes: ["missing_tool_result"],
      durationMs: 15,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.integrity");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.conversationId).toBe("conv-123");
    expect(data.issueCount).toBe(2);
    expect(data.repairsApplied).toBe(1);
    expect(data.errorsLogged).toBe(0);
    expect(data.issueTypes).toEqual(["missing_tool_result"]);
    expect(data.durationMs).toBe(15);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("context_rehydrated_maps_to_context.rehydrated with sectionsInjected/filesInjected/skillsInjected/overflowStripped; envelope stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("context:rehydrated", {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      sectionsInjected: 4,
      filesInjected: 2,
      skillsInjected: 1,
      overflowStripped: false,
      timestamp: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("context.rehydrated");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.sectionsInjected).toBe(4);
    expect(data.filesInjected).toBe(2);
    expect(data.skillsInjected).toBe(1);
    expect(data.overflowStripped).toBe(false);
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  // ---- Approval events ----

  it("approval_requested_maps_to_approval.requested with requestId/toolName/action/trustLevel/timeoutMs/channelType; params MUST NOT be forwarded (HIGHEST risk PII)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("approval:requested", {
      requestId: "req-abc123",
      toolName: "bash",
      action: "execute",
      params: { secret: "my-api-key", path: "/etc/secrets", command: "rm -rf /tmp" },
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "trusted",
      createdAt: Date.now(),
      timeoutMs: 60000,
      channelType: "telegram",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("approval.requested");
    const data = recorder.calls[0].data as Record<string, unknown>;

    // Safe fields must be present.
    expect(data.requestId).toBe("req-abc123");
    expect(data.toolName).toBe("bash");
    expect(data.action).toBe("execute");
    expect(data.trustLevel).toBe("trusted");
    expect(data.timeoutMs).toBe(60000);
    expect(data.channelType).toBe("telegram");

    // params MUST NEVER appear — raw unbounded tool args, highest-risk field.
    expect(data.params).toBeUndefined();
    expect("params" in data).toBe(false);

    // Envelope-only fields must be stripped.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("approval_requested_omits_channelType_when_not_present (conditional spread)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("approval:requested", {
      requestId: "req-xyz",
      toolName: "write_file",
      action: "write",
      params: { content: "data" },
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      trustLevel: "untrusted",
      createdAt: Date.now(),
      timeoutMs: 30000,
      // channelType intentionally omitted
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;

    // params MUST NEVER appear.
    expect("params" in data).toBe(false);

    // channelType should be absent when not provided (conditional spread).
    expect("channelType" in data).toBe(false);

    // Other safe fields present.
    expect(data.requestId).toBe("req-xyz");
    expect(data.trustLevel).toBe("untrusted");
  });

  it("approval_resolved_maps_to_approval.resolved with requestId/approved/approvedBy/reason; resolvedAt stripped", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("approval:resolved", {
      requestId: "req-abc123",
      approved: true,
      approvedBy: "owner",
      reason: "ok",
      resolvedAt: Date.now(),
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("approval.resolved");
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.requestId).toBe("req-abc123");
    expect(data.approved).toBe(true);
    expect(data.approvedBy).toBe("owner");
    expect(data.reason).toBe("ok");

    // resolvedAt is envelope noise — omitted.
    expect(data.resolvedAt).toBeUndefined();
    expect("resolvedAt" in data).toBe(false);
  });

  it("approval_resolved_omits_reason_when_not_present (conditional spread)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("approval:resolved", {
      requestId: "req-denied",
      approved: false,
      approvedBy: "system",
      resolvedAt: Date.now(),
      // reason intentionally omitted
    });

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;

    expect(data.requestId).toBe("req-denied");
    expect(data.approved).toBe(false);
    expect(data.approvedBy).toBe("system");

    // reason absent when not provided (conditional spread).
    expect("reason" in data).toBe(false);

    // resolvedAt must be stripped.
    expect("resolvedAt" in data).toBe(false);
  });

  // ---- Coverage spot-check (count): in arch test file ----

  it("TRAJECTORY_BRIDGE_MAPPING contains all 13 new security/compaction/context/approval keys and total mapping is ≥ 53", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    const expected = [
      // security rest
      "security:memory_tainted",
      "security:warn",
      // compaction
      "compaction:started",
      "compaction:flush",
      "compaction:recommended",
      // context
      "context:evicted",
      "context:masked",
      "context:reread",
      "context:overflow",
      "context:integrity",
      "context:rehydrated",
      // approval
      "approval:requested",
      "approval:resolved",
    ];
    for (const key of expected) {
      expect(mapping[key], `TRAJECTORY_BRIDGE_MAPPING missing key: ${key}`).toBeDefined();
    }
    // Total bridge mapping should reach ≥ 53 (40 existing + 13 new).
    expect(Object.keys(mapping).length).toBeGreaterThanOrEqual(53);
  });
});

// ---------------------------------------------------------------------------
// dedup:duplicate_inbound → dedup.duplicate_inbound
// ---------------------------------------------------------------------------

describe("attachTrajectoryToEventBus -- dedup events", () => {
  it("dedup_duplicate_inbound_maps_to_dedup.duplicate_inbound_trajectory_type", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("dedup:duplicate_inbound", {
      messageId: "m1",
      channelType: "telegram",
      chatId: "123",
      firstSeenAt: 1000,
      duplicateAt: 1001,
      deltaMs: 1,
      source: "pipeline",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("dedup.duplicate_inbound");
  });

  it("dedup_duplicate_inbound_translator_returns_5_field_subset_omitting_firstSeenAt_and_duplicateAt", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("dedup:duplicate_inbound", {
      messageId: "m1",
      channelType: "telegram",
      chatId: "123",
      firstSeenAt: 1000,
      duplicateAt: 1001,
      deltaMs: 1,
      source: "pipeline",
    });

    const data = recorder.calls[0].data as Record<string, unknown>;
    // 5-field subset forwarded
    expect(data.messageId).toBe("m1");
    expect(data.channelType).toBe("telegram");
    expect(data.chatId).toBe("123");
    expect(data.deltaMs).toBe(1);
    expect(data.source).toBe("pipeline");
    // firstSeenAt and duplicateAt intentionally omitted (envelope ts covers timing)
    expect("firstSeenAt" in data).toBe(false);
    expect("duplicateAt" in data).toBe(false);
  });

  it("TRAJECTORY_BRIDGE_MAPPING_dedup:duplicate_inbound_key_maps_to_dedup.duplicate_inbound", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    expect(mapping["dedup:duplicate_inbound"]).toBe("dedup.duplicate_inbound");
  });

  it("TRAJECTORY_EVENT_TYPES_includes_dedup.duplicate_inbound", () => {
    expect(Array.from(TRAJECTORY_EVENT_TYPES as readonly string[])).toContain("dedup.duplicate_inbound");
  });
});

// ---------------------------------------------------------------------------
// Health budget exceeded + mapping entry-count guard
// ---------------------------------------------------------------------------

describe("health:budget_exceeded entry (bridge entry count guard)", () => {
  it("bridge entry count matches the exact mapping size (guards a silent add/remove)", () => {
    // This count guards TRAJECTORY_BRIDGE_MAPPING against a silent add or
    // removal: any change to the mapping must update this number in lockstep,
    // forcing a deliberate review of every newly-bridged or dropped event.
    expect(Object.keys(TRAJECTORY_BRIDGE_MAPPING).length).toBe(119);
  });

  it("health:budget_exceeded mapped to health.budget_exceeded", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    expect(mapping["health:budget_exceeded"]).toBe("health.budget_exceeded");
  });

  it("TRAJECTORY_EVENT_TYPES includes health.budget_exceeded", () => {
    expect(Array.from(TRAJECTORY_EVENT_TYPES as readonly string[])).toContain("health.budget_exceeded");
  });

  it("emitting health:budget_exceeded produces trajectory health.budget_exceeded with kind/count/windowMs (timestamp is envelope-only)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("health:budget_exceeded", {
      kind: "network",
      count: 100,
      windowMs: 60000,
      timestamp: 1,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("health.budget_exceeded");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.kind).toBe("network");
    expect(data.count).toBe(100);
    expect(data.windowMs).toBe(60000);
    // timestamp is envelope-only — MUST NOT appear in data
    expect(data.timestamp).toBeUndefined();
    expect("timestamp" in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle-sweep
// soft-eviction telemetry events. The two learning:memory_* keys are daemon-side
// emit. Counts/ids/closed-enums ONLY — NEVER a memory body (the binding content-free
// constraint).
// ---------------------------------------------------------------------------

describe("learning soft-eviction events (counts-only, bridged)", () => {
  it("the two soft-eviction keys are in TRAJECTORY_BRIDGE_MAPPING with the canonical dotted names", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    expect(mapping["learning:memory_demoted"]).toBe("learning.memory_demoted");
    expect(mapping["learning:memory_evicted"]).toBe("learning.memory_evicted");
  });

  it("TRAJECTORY_EVENT_TYPES includes the two dotted soft-eviction trajectory types", () => {
    const types = Array.from(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(types).toContain("learning.memory_demoted");
    expect(types).toContain("learning.memory_evicted");
  });

  it("learning:memory_demoted → learning.memory_demoted carries the count ONLY (correlation ids stripped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("learning:memory_demoted", { agentId: "default", count: 3, timestamp: 1000 });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("learning.memory_demoted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.count).toBe(3);
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("learning:memory_evicted → learning.memory_evicted carries the count ONLY (correlation ids stripped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("learning:memory_evicted", { agentId: "default", count: 2, timestamp: 1000 });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("learning.memory_evicted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The two procedural-synthesis telemetry events. Emitted
// DAEMON-SIDE (the __SKILL_SYNTHESIS__ cron handler) after runSkillSynthesis.
// Counts / ids / closed-enums (coverage) ONLY — NEVER a procedure body, a script,
// or a finding (the content-free firewall; the translator forwards counts/coverage only).
// ---------------------------------------------------------------------------

describe("reflect:admitted / reflect:funnel (counts-only, bridged)", () => {
  it("both renamed keys are in TRAJECTORY_BRIDGE_MAPPING with the canonical dotted names", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    expect(mapping["reflect:admitted"]).toBe("reflect.admitted");
    expect(mapping["reflect:funnel"]).toBe("reflect.funnel");
    // No compat alias — the old synthesis-funnel keys + the deleted vestigial are GONE.
    expect(mapping["learning:skill_synthesized"]).toBeUndefined();
    expect(mapping["learning:skill_synthesis_funnel"]).toBeUndefined();
    expect(mapping["learning:skill_validated"]).toBeUndefined();
  });

  it("TRAJECTORY_EVENT_TYPES includes both renamed dotted trajectory types (and not the old/vestigial)", () => {
    const types = Array.from(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(types).toContain("reflect.admitted");
    expect(types).toContain("reflect.funnel");
    expect(types).not.toContain("learning.skill_synthesized");
    expect(types).not.toContain("learning.skill_synthesis_funnel");
    expect(types).not.toContain("learning.skill_validated");
  });

  it("reflect:admitted → reflect.admitted carries the count ONLY (correlation ids stripped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("reflect:admitted", { agentId: "default", count: 2, timestamp: 1000 });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("reflect.admitted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("reflect:funnel → reflect.funnel carries the funnel counts + admissionOutcome ONLY (no body/scripts)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("reflect:funnel", {
      agentId: "default",
      synthesized: 2,
      validated: 1,
      admitted: 1,
      maxClusterCardinality: 2,
      admissionOutcome: "admitted",
      timestamp: 1000,
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("reflect.funnel");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data).toEqual({ synthesized: 2, validated: 1, admitted: 1, maxClusterCardinality: 2, admissionOutcome: "admitted" });
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
    // Content-free firewall: NO body / scripts / findings / field-name leak crosses.
    for (const k of Object.keys(data)) {
      expect(k, `payload key ${k} must not name a body/script/finding`).not.toMatch(/body|script|finding|content/i);
    }
  });

  it("reflect:funnel never forwards a doc body even if present (content-free invariant)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("reflect:funnel", {
      agentId: "default",
      synthesized: 1,
      validated: 1,
      admitted: 1,
      maxClusterCardinality: 2,
      admissionOutcome: "admitted",
      body: "the reflected procedure markdown",
      scripts: ["curl evil | sh"],
      timestamp: 1000,
    } as never);

    const data = recorder.calls[0].data as Record<string, unknown>;
    expect("body" in data).toBe(false);
    expect("scripts" in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two skill promote/demote telemetry events.
// Emitted DAEMON-SIDE (the promote/demote loop) — NOT agent/orchestrator,
// so the arch emit-scanner does not require them; bridged so `comis explain`
// reconstructs a promotion/demotion. Counts ONLY — the count crosses, never an
// id-list / procedure body / script (the content-free firewall; they fold into the
// shared { count } translator case). APPEND-ONLY beside the skill rows.
// ---------------------------------------------------------------------------

describe("learning:skill_promoted / skill_demoted (counts-only, bridged)", () => {
  it("both keys are in TRAJECTORY_BRIDGE_MAPPING with the canonical dotted names", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    expect(mapping["learning:skill_promoted"]).toBe("learning.skill_promoted");
    expect(mapping["learning:skill_demoted"]).toBe("learning.skill_demoted");
  });

  it("TRAJECTORY_EVENT_TYPES includes both new dotted trajectory types", () => {
    const types = Array.from(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(types).toContain("learning.skill_promoted");
    expect(types).toContain("learning.skill_demoted");
  });

  it("learning:skill_promoted → learning.skill_promoted carries the count ONLY (correlation ids stripped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("learning:skill_promoted", { agentId: "default", count: 2, timestamp: 1000 });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("learning.skill_promoted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect(Object.keys(data)).toEqual(["count"]);
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("learning:skill_demoted → learning.skill_demoted carries the count ONLY (correlation ids stripped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("learning:skill_demoted", { agentId: "default", count: 1, timestamp: 1000 });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("learning.skill_demoted");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.count).toBe(1);
    expect(Object.keys(data)).toEqual(["count"]);
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
  });

  it("learning:skill_demoted carries demotedSkillNames + triggerTrajectoryId (ids), still strips a smuggled body", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("learning:skill_demoted", {
      agentId: "default",
      count: 2,
      demotedSkillNames: ["skill-a", "skill-b"],
      triggerTrajectoryId: "traj-9",
      body: "the demoted procedure markdown", // hostile extra — must NOT cross
      timestamp: 1000,
    } as never);

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.count).toBe(2);
    expect(data.demotedSkillNames).toEqual(["skill-a", "skill-b"]);
    expect(data.triggerTrajectoryId).toBe("traj-9");
    expect(data.body).toBeUndefined(); // Only the declared fields cross
    expect(Object.keys(data).sort()).toEqual(["count", "demotedSkillNames", "triggerTrajectoryId"]);
  });

  it("never forwards a body/script/id-list even if present on the payload (content-free firewall)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("learning:skill_promoted", {
      agentId: "default",
      count: 3,
      // hostile extras that MUST NOT cross into the trajectory:
      body: "the promoted procedure markdown",
      scripts: ["rm -rf /"],
      skillIds: ["deploy", "backup"],
      timestamp: 1000,
    } as never);

    expect(recorder.calls).toHaveLength(1);
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data).toEqual({ count: 3 });
    expect(Object.keys(data)).toEqual(["count"]);
    for (const k of Object.keys(data)) {
      expect(k, `payload key ${k} must not name a body/script/id-list`).not.toMatch(/body|script|skillids|finding|content/i);
    }
  });
});

// Guard tests: three learning events (learning:skill_validated /
// learning:user_model_revised / learning:memory_generalized) are not part of the
// bridge — these assertions keep them absent from the mapping and the type union.
describe("removed learning events stay absent from the bridge mapping", () => {
  it("learning:skill_validated / user_model_revised / memory_generalized are GONE from the bridge mapping", () => {
    const mapping = TRAJECTORY_BRIDGE_MAPPING as Record<string, string>;
    expect(mapping["learning:skill_validated"]).toBeUndefined();
    expect(mapping["learning:user_model_revised"]).toBeUndefined();
    expect(mapping["learning:memory_generalized"]).toBeUndefined();
  });

  it("their dotted trajectory types are GONE from TRAJECTORY_EVENT_TYPES", () => {
    const types = Array.from(TRAJECTORY_EVENT_TYPES as readonly string[]);
    expect(types).not.toContain("learning.skill_validated");
    expect(types).not.toContain("learning.user_model_revised");
    expect(types).not.toContain("learning.memory_generalized");
  });
});

// ---------------------------------------------------------------------------
// observability:cache_break → cache.break
// (content-free — counts/digest ONLY, never the tool-name arrays or system text)
// ---------------------------------------------------------------------------

describe("attachTrajectoryToEventBus -- cache break (content-free)", () => {
  it("TRAJECTORY_BRIDGE_MAPPING maps observability:cache_break to cache.break", () => {
    expect(
      (TRAJECTORY_BRIDGE_MAPPING as Record<string, string>)["observability:cache_break"],
    ).toBe("cache.break");
  });

  it("cache.break is a known TrajectoryEventType (enumerated in types.ts)", () => {
    expect(TRAJECTORY_EVENT_TYPES as readonly string[]).toContain("cache.break");
  });

  it("cache_break_maps_to_cache.break forwarding reason + counts/digest ONLY", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("observability:cache_break", {
      provider: "anthropic",
      reason: "tools_changed",
      tokenDrop: 1000,
      tokenDropRelative: 0.5,
      previousCacheRead: 2000,
      currentCacheRead: 1000,
      callCount: 3,
      changes: {
        systemChanged: false,
        toolsChanged: true,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: ["secret-tool-name", "internal_admin_api"],
        removedTools: ["dropped_tool"],
        changedSchemaTools: ["schema_changed_tool"],
        headersChanged: false,
        extraBodyChanged: false,
      },
      toolsChanged: ["secret-tool-name", "internal_admin_api", "dropped_tool"],
      ttlCategory: undefined,
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      timestamp: 1000,
      toolsAdded: ["secret-tool-name", "internal_admin_api"],
      toolsRemoved: ["dropped_tool"],
      toolsSchemaChanged: ["schema_changed_tool"],
      systemCharDelta: 42,
      model: "claude-3-5-sonnet-20241022",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("cache.break");
    const data = recorder.calls[0].data as Record<string, unknown>;
    // Content-free fields: reason + counts + a changed-dims digest.
    expect(data.reason).toBe("tools_changed");
    expect(data.tokenDrop).toBe(1000);
    expect(data.tokenDropRelative).toBe(0.5);
    expect(data).toHaveProperty("changedDimsDigest");

    // NO tool-name arrays, NO system text crosses into the trajectory.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("secret-tool-name");
    expect(serialized).not.toContain("internal_admin_api");
    expect(serialized).not.toContain("dropped_tool");
    expect(serialized).not.toContain("schema_changed_tool");
    expect(serialized).not.toMatch(/toolsAdded|toolsRemoved|toolsSchemaChanged|toolsChanged/);
    // Envelope-only correlation keys must NOT appear in data.
    expect(data.agentId).toBeUndefined();
    expect(data.sessionKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The per-cap audit's `capability:audited`
// spawn-tree producer event. DAEMON-emitted (rpc-dispatch.ts / setup-capability-
// endpoint.ts) → outside the agent/orchestrator emit-scanner scope (the
// subagent:budget_exceeded precedent), so no EVENTS_NOT_TRAJECTORY_MAPPED entry
// is needed; the mapping here is for OPERATOR TRAJECTORY VISIBILITY + arch
// closure of keyof TrajectoryBridgedEventName. Content-free: caps/tool-NAME/
// decision/ids ONLY — NEVER the tool.invoke args, a message body, or a secret.
// ---------------------------------------------------------------------------

describe("capability:audited entry (spawn-tree producer)", () => {
  it("TRAJECTORY_BRIDGE_MAPPING maps capability:audited to capability.audited", () => {
    expect(
      (TRAJECTORY_BRIDGE_MAPPING as Record<string, string>)["capability:audited"],
    ).toBe("capability.audited");
  });

  it("capability.audited is a known TrajectoryEventType (enumerated in types.ts)", () => {
    expect(Array.from(TRAJECTORY_EVENT_TYPES as readonly string[])).toContain("capability.audited");
  });

  it("emitting capability:audited records capability.audited with the content-free tuple (envelope stripped)", () => {
    const bus = makeBus();
    const recorder = createCaptureRecorder();
    attachTrajectoryToEventBus({ eventBus: bus, recorder });

    bus.emit("capability:audited", {
      timestamp: 1000,
      agentId: "agent-1",
      capability: "orch:read",
      tool: "memory_search",
      method: "tool.invoke",
      decision: "allow",
      rootRunId: "run-1",
      leaseId: "lease-abc",
      parentLeaseId: "lease-root",
    });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].type).toBe("capability.audited");
    const data = recorder.calls[0].data as Record<string, unknown>;
    expect(data.capability).toBe("orch:read");
    expect(data.tool).toBe("memory_search");
    expect(data.decision).toBe("allow");
    expect(data.rootRunId).toBe("run-1");
    expect(data.leaseId).toBe("lease-abc");
    expect(data.parentLeaseId).toBe("lease-root");
    // Envelope-only correlation keys MUST NOT appear in data.
    expect(data.agentId).toBeUndefined();
    expect(data.timestamp).toBeUndefined();
    // method is an envelope-ish label, not part of the node tuple.
    expect(data.method).toBeUndefined();
  });
});
