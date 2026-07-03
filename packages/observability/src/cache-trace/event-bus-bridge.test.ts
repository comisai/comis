// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-trace EventBus bridge behavior tests.
 *
 * Coverage:
 *   - subscribes_and_unsubscribes_cleanly (no listener leaks; token-stash event)
 *   - attaches_token_counts_to_next_session_after_emit (the round-trip
 *     from bus → setLatestTokenUsage → recordStage("session:after"))
 *
 * Multi-event mapping cases:
 *   - subscribes_to_session_started_and_emits_session_start_stage
 *   - subscribes_to_session_ended_and_emits_session_end_stage
 *   - twin_emits_prompt_before_and_prompt_after_from_single_prompt_submitted
 *   - second_prompt_submitted_emits_prompt_before_with_previous_digests
 *   - subscribes_to_tool_started_and_emits_tool_before_stage
 *   - subscribes_to_tool_executed_and_emits_tool_after_stage
 *   - preserves_token_stash_side_effect_for_observability_token_usage
 *   - unsubscribe_removes_all_listeners_no_leak
 *
 * @module
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TypedEventBus } from "@comis/core";

import { createCacheTrace, type CacheTrace } from "./runtime.js";
import { attachCacheTraceToEventBus } from "./event-bus-bridge.js";
import type { CacheTraceEvent, CacheTraceStage } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-cache-trace-bus-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(filePath: string): CacheTraceEvent[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l)) as CacheTraceEvent[];
}

function makeTrace(filePath: string): CacheTrace {
  const trace = createCacheTrace({
    enabled: true,
    filePath,
    includeMessages: true,
    includePrompt: true,
    includeSystem: true,
    agentId: "agent-1",
    sessionId: "sid-1",
  });
  if (trace === null) throw new Error("makeTrace: createCacheTrace returned null");
  return trace;
}

/**
 * Build a fake CacheTrace whose `recordStage` + `setLatestTokenUsage` are
 * vitest spies. The multi-event tests assert directly on the spy calls
 * (no disk round-trip), which is faster + lets us inspect the raw
 * payloads without sanitization side-effects.
 */
function makeFakeTrace(
  spies: {
    recordStage?: ReturnType<typeof vi.fn>;
    setLatestTokenUsage?: ReturnType<typeof vi.fn>;
  } = {},
): CacheTrace {
  const recordStage = spies.recordStage ?? vi.fn(() => "queued" as const);
  const setLatestTokenUsage = spies.setLatestTokenUsage ?? vi.fn();
  return {
    filePath: "/tmp/fake.jsonl",
    includeMessages: true,
    includePrompt: true,
    includeSystem: true,
    recordStage: recordStage as unknown as CacheTrace["recordStage"],
    setLatestTokenUsage: setLatestTokenUsage as unknown as CacheTrace["setLatestTokenUsage"],
    flush: async () => undefined,
    flushAndClose: async () => undefined,
    failureCount: () => 0,
  };
}

describe("attachCacheTraceToEventBus", () => {
  it("subscribes_and_unsubscribes_cleanly across multiple cycles", () => {
    const bus = new TypedEventBus();
    const trace = makeTrace(join(tmpDir, "trace.jsonl"));

    // Baseline: no listeners.
    expect(bus.listenerCount("observability:token_usage")).toBe(0);

    // Subscribe twice, unsubscribe twice — confirm listener count
    // returns to zero each cycle (no orphan handlers).
    const unsub1 = attachCacheTraceToEventBus(trace, bus);
    expect(bus.listenerCount("observability:token_usage")).toBe(1);

    const unsub2 = attachCacheTraceToEventBus(trace, bus);
    expect(bus.listenerCount("observability:token_usage")).toBe(2);

    unsub1();
    expect(bus.listenerCount("observability:token_usage")).toBe(1);

    unsub2();
    expect(bus.listenerCount("observability:token_usage")).toBe(0);
  });

  it("attaches_token_counts_to_next_session_after_emit via bus → setLatestTokenUsage → recordStage", async () => {
    const bus = new TypedEventBus();
    const filePath = join(tmpDir, "trace.jsonl");
    const trace = makeTrace(filePath);

    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    // Synthesize a token_usage event. The bridge's handler narrows the
    // payload — we pass the canonical shape from
    // packages/core/src/event-bus/events-agent.ts.
    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "channel-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-3-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      latencyMs: 250,
      cacheReadTokens: 9999,
      cacheWriteTokens: 42,
      sessionKey: "sid-1",
      savedVsUncached: 0,
      cacheEligible: true,
    });

    // New lifecycle contract: callers do NOT emit
    // session:after directly. The terminal emit in flushAndClose drains
    // the stashed token usage onto exactly one session:after record.
    await trace.flushAndClose();

    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.stage).toBe("session:after");
    expect(lines[0]!.cacheReadInputTokens).toBe(9999);
    expect(lines[0]!.cacheCreationInputTokens).toBe(42);

    unsubscribe();
  });
});

describe("attachCacheTraceToEventBus multi-event mapping", () => {
  // Each test builds a fake trace with a recordStage spy + fresh bus.

  it("subscribes_to_session_started_and_emits_session_start_stage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("session:started", {
      agentId: "agent-1",
      sessionKey: "sk-1",
      traceId: "trace-1",
      channelType: "discord",
      channelId: "test-channel",
      timestamp: Date.now(),
    });

    expect(recordStageSpy).toHaveBeenCalledWith(
      "session:start",
      expect.objectContaining({
        channelType: "discord",
        channelId: "test-channel",
      }),
    );
    unsubscribe();
  });

  it("subscribes_to_session_ended_and_emits_session_end_stage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("session:ended", {
      agentId: "agent-1",
      sessionKey: "sk-1",
      traceId: "trace-1",
      totalTurns: 3,
      totalInputTokens: 500,
      totalOutputTokens: 200,
      durationMs: 12345,
      exitReason: "completed",
      timestamp: Date.now(),
    });

    const stages = recordStageSpy.mock.calls.map((c) => c[0] as CacheTraceStage);
    expect(stages).toContain("session:end");
    unsubscribe();
  });

  it("twin_emits_prompt_before_and_prompt_after_from_single_prompt_submitted", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("prompt:submitted", {
      agentId: "test-agent",
      sessionKey: "test-session",
      traceId: "trace-1",
      promptChars: 100,
      provider: "test",
      modelId: "test-model",
      messageCount: 1,
      systemDigest: "sysDigestA",
      messagesDigest: "msgDigestA",
      timestamp: Date.now(),
    });

    // The bridge must emit BOTH prompt:before AND prompt:after stages on
    // a single event.
    const stages = recordStageSpy.mock.calls.map((c) => c[0] as CacheTraceStage);
    expect(stages).toContain("prompt:before");
    expect(stages).toContain("prompt:after");

    // prompt:before for the first prompt has no prior digests — payload
    // should omit messagesDigest + systemDigest.
    const beforeCall = recordStageSpy.mock.calls.find((c) => c[0] === "prompt:before");
    expect(beforeCall).toBeDefined();
    const beforePayload = beforeCall![1] as Record<string, unknown>;
    expect(beforePayload.messagesDigest).toBeUndefined();
    expect(beforePayload.systemDigest).toBeUndefined();

    // prompt:after carries the new digests.
    const afterCall = recordStageSpy.mock.calls.find((c) => c[0] === "prompt:after");
    expect(afterCall).toBeDefined();
    const afterPayload = afterCall![1] as Record<string, unknown>;
    expect(afterPayload.messagesDigest).toBe("msgDigestA");
    expect(afterPayload.systemDigest).toBe("sysDigestA");

    unsubscribe();
  });

  it("second_prompt_submitted_emits_prompt_before_with_previous_digests", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    // First prompt — populates digest cache state.
    bus.emit("prompt:submitted", {
      agentId: "a",
      sessionKey: "s",
      traceId: "t",
      promptChars: 100,
      provider: "p",
      modelId: "m",
      messageCount: 1,
      systemDigest: "sys1",
      messagesDigest: "msg1",
      timestamp: Date.now(),
    });
    recordStageSpy.mockClear();

    // Second prompt — prompt:before now carries the previous digests.
    bus.emit("prompt:submitted", {
      agentId: "a",
      sessionKey: "s",
      traceId: "t",
      promptChars: 200,
      provider: "p",
      modelId: "m",
      messageCount: 2,
      systemDigest: "sys2",
      messagesDigest: "msg2",
      timestamp: Date.now(),
    });

    const beforeCall = recordStageSpy.mock.calls.find((c) => c[0] === "prompt:before");
    expect(beforeCall).toBeDefined();
    const beforePayload = beforeCall![1] as Record<string, unknown>;
    expect(beforePayload.messagesDigest).toBe("msg1");
    expect(beforePayload.systemDigest).toBe("sys1");

    const afterCall = recordStageSpy.mock.calls.find((c) => c[0] === "prompt:after");
    expect(afterCall).toBeDefined();
    const afterPayload = afterCall![1] as Record<string, unknown>;
    expect(afterPayload.messagesDigest).toBe("msg2");
    expect(afterPayload.systemDigest).toBe("sys2");

    unsubscribe();
  });

  it("subscribes_to_tool_started_and_emits_tool_before_stage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("tool:started", {
      toolName: "TestTool",
      toolCallId: "call-1",
      timestamp: Date.now(),
    });

    expect(recordStageSpy).toHaveBeenCalledWith(
      "tool:before",
      expect.objectContaining({
        toolName: "TestTool",
        toolCallId: "call-1",
      }),
    );
    unsubscribe();
  });

  it("subscribes_to_tool_executed_and_emits_tool_after_stage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("tool:executed", {
      toolName: "TestTool",
      toolCallId: "call-1",
      durationMs: 42,
      success: true,
      timestamp: Date.now(),
    });

    expect(recordStageSpy).toHaveBeenCalledWith(
      "tool:after",
      expect.objectContaining({
        toolName: "TestTool",
        durationMs: 42,
      }),
    );
    unsubscribe();
  });

  it("forwards provenance fields into the tool:after stage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("tool:executed", {
      toolName: "TestTool",
      toolCallId: "call-1",
      durationMs: 42,
      success: false,
      timestamp: Date.now(),
      // Provenance fields — the flight-recorder reads the cache-trace stream.
      classifiedFailureBy: "failure_detector",
      transportOk: true,
      httpStatus: 200,
      matchedRule: "status_token",
      matchedToken: "503",
      resultBytes: 1234,
      resultDigest: "abc123def456",
    });

    // All 7 provenance fields must reach the tool:after stage — without
    // this forwarding, the flight-recorder is blind.
    expect(recordStageSpy).toHaveBeenCalledWith(
      "tool:after",
      expect.objectContaining({
        toolName: "TestTool",
        classifiedFailureBy: "failure_detector",
        transportOk: true,
        httpStatus: 200,
        matchedRule: "status_token",
        matchedToken: "503",
        resultBytes: 1234,
        resultDigest: "abc123def456",
      }),
    );
    unsubscribe();
  });

  it("omits_absent_provenance_keys_from_the_tool_after_stage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const trace = makeFakeTrace({ recordStage: recordStageSpy });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    // A success with NO provenance fields — the keys must be ABSENT from
    // the stage object (presence-conditional, never `undefined` values).
    bus.emit("tool:executed", {
      toolName: "TestTool",
      toolCallId: "call-1",
      durationMs: 42,
      success: true,
      timestamp: Date.now(),
    });

    const afterCall = recordStageSpy.mock.calls.find((c) => c[0] === "tool:after");
    expect(afterCall).toBeDefined();
    const stage = afterCall![1] as Record<string, unknown>;
    expect("classifiedFailureBy" in stage).toBe(false);
    expect("transportOk" in stage).toBe(false);
    expect("httpStatus" in stage).toBe(false);
    expect("matchedRule" in stage).toBe(false);
    expect("matchedToken" in stage).toBe(false);
    expect("resultBytes" in stage).toBe(false);
    expect("resultDigest" in stage).toBe(false);
    unsubscribe();
  });

  it("preserves_token_stash_side_effect_for_observability_token_usage", () => {
    const recordStageSpy = vi.fn(() => "queued" as const);
    const setLatestTokenUsageSpy = vi.fn();
    const trace = makeFakeTrace({
      recordStage: recordStageSpy,
      setLatestTokenUsage: setLatestTokenUsageSpy,
    });
    const bus = new TypedEventBus();
    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    bus.emit("observability:token_usage", {
      timestamp: Date.now(),
      traceId: "trace-1",
      agentId: "agent-1",
      channelId: "channel-1",
      executionId: "exec-1",
      provider: "anthropic",
      model: "claude-3-opus",
      tokens: { prompt: 100, completion: 50, total: 150 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      latencyMs: 250,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      sessionKey: "sid-1",
      savedVsUncached: 0,
      cacheEligible: true,
    });

    expect(setLatestTokenUsageSpy).toHaveBeenCalledWith({
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
    });
    // observability:token_usage MUST NOT translate to a recordStage call —
    // it's a side-effect-only handler (not in the mapping table).
    const stages = recordStageSpy.mock.calls.map((c) => c[0] as string);
    expect(stages).not.toContain("observability:token_usage");
    unsubscribe();
  });

  it("unsubscribe_removes_all_listeners_no_leak", () => {
    const trace = makeFakeTrace();
    const bus = new TypedEventBus();

    const before =
      bus.listenerCount("prompt:submitted") +
      bus.listenerCount("session:started") +
      bus.listenerCount("session:ended") +
      bus.listenerCount("tool:started") +
      bus.listenerCount("tool:executed") +
      bus.listenerCount("observability:token_usage");
    expect(before).toBe(0);

    const unsubscribe = attachCacheTraceToEventBus(trace, bus);

    const during =
      bus.listenerCount("prompt:submitted") +
      bus.listenerCount("session:started") +
      bus.listenerCount("session:ended") +
      bus.listenerCount("tool:started") +
      bus.listenerCount("tool:executed") +
      bus.listenerCount("observability:token_usage");
    // 1 token-stash + 1 prompt twin-emit + 4 mapping-table entries = 6
    expect(during).toBe(6);

    unsubscribe();

    const after =
      bus.listenerCount("prompt:submitted") +
      bus.listenerCount("session:started") +
      bus.listenerCount("session:ended") +
      bus.listenerCount("tool:started") +
      bus.listenerCount("tool:executed") +
      bus.listenerCount("observability:token_usage");
    expect(after).toBe(0);
  });
});
