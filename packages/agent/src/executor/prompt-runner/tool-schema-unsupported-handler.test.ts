// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for `handleToolSchemaUnsupported` — the
 * tool_schema_unsupported strip-and-retry repair.
 *
 * Pins the full handler contract:
 *   - strip-before-retry ORDERING observed at the retry-invocation boundary
 *     (the fake invokeRetry serializes mergedCustomTools AT INVOCATION TIME);
 *     the PROPAGATION proof is the real-SDK decider in
 *     tool-schema-strip.test.ts — the two compose, neither substitutes;
 *   - exactly ONE invokeRetry per session (module once-gate keyed by
 *     formatSessionKey, set BEFORE the retry);
 *   - signed-replay-shaped post-retry empty-check;
 *   - privacy-bounded WARN: tool + keyword NAMES only, hint names
 *     comisCompat.toolSchemaProfile, errorKind "validation", NO schema
 *     bodies and NO raw provider body in any new log line;
 *   - execution:tool_schema_unsupported event with the locked 8-field payload;
 *   - NOTHING-TO-STRIP branch: no futile retry, honest terminal failure.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { hostileMcpTool, wellFormedTool } from "../../provider/tool-schema/gbnf-hostile-fixtures.js";
import { setSessionStateClock } from "../executor-session-state.js";
import type { RunPromptParams } from "./prompt-runner-types.js";
import type { BridgeSnapshot, InvokeRetry, RetryState } from "./silent-failure-handlers.js";
import {
  handleToolSchemaUnsupported,
  resetToolSchemaStripGateForTest,
} from "./tool-schema-unsupported-handler.js";

// Module-level clock for executor-session-state's bounded session map (the
// session-lifetime once-gate lives there).
setSessionStateClock({ now: () => Date.now(), nowDate: () => new Date() });

// ---------------------------------------------------------------------------
// Fakes (hand-built partials per AGENTS.md §2.5 — only what the SUT calls)
// ---------------------------------------------------------------------------

interface FakeLogger {
  trace: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLogger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface MakeParamsResult {
  params: RunPromptParams;
  logger: FakeLogger;
  emit: ReturnType<typeof vi.fn>;
  tools: Array<{ name: string; description?: string; parameters?: unknown }>;
  bridgeGetResult: ReturnType<typeof vi.fn>;
  getLastAssistantText: ReturnType<typeof vi.fn>;
}

function makeParams(overrides?: {
  channelId?: string;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
}): MakeParamsResult {
  const logger = makeLogger();
  const emit = vi.fn();
  const tools = overrides?.tools ?? [
    {
      name: hostileMcpTool.name,
      description: hostileMcpTool.description,
      parameters: structuredClone(hostileMcpTool.parameters),
    },
    {
      name: wellFormedTool.name,
      description: wellFormedTool.description,
      parameters: structuredClone(wellFormedTool.parameters),
    },
  ];
  const getLastAssistantText = vi.fn(() => "recovered visible text");
  const bridgeGetResult = vi.fn(() => ({ llmCalls: 1, textEmitted: true }));

  const params = {
    session: { getLastAssistantText, messages: [] },
    sessionKey: { tenantId: "t1", userId: "u1", channelId: overrides?.channelId ?? "c1" },
    agentId: "agent-1",
    bridge: { getResult: bridgeGetResult },
    mergedCustomTools: tools,
    resolvedModel: { id: "qwen3.6:35b", provider: "my-ollama" },
    config: { provider: "my-ollama", model: "qwen3.6:35b" },
    effectiveTimeout: { promptTimeoutMs: 1000, retryPromptTimeoutMs: 1000 },
    onResetTimer: () => {},
    deps: {
      logger,
      eventBus: { emit },
      clock: { now: () => 1234 },
      timers: {
        setTimeout: (fn: () => void) => {
          fn();
          return { cancelled: false, cancel: () => {}, unref: () => {} };
        },
      },
    },
  } as unknown as RunPromptParams;

  return { params, logger, emit, tools, bridgeGetResult, getLastAssistantText };
}

/** Recognizable raw provider body — must NEVER surface in the new log lines. */
const RAW_PROVIDER_BODY =
  'JSON schema conversion failed: SECRET_MARKER schema dump {"type":"object","properties":{}}';

function makeBridgeSnapshot(): BridgeSnapshot {
  return {
    llmCalls: 1,
    finishReason: "error",
    textEmitted: false,
    lastLlmErrorMessage: RAW_PROVIDER_BODY,
  } as BridgeSnapshot;
}

function makeRetryState(): RetryState {
  return { promptSucceeded: false, promptError: undefined };
}

function allLogArgsStringified(logger: FakeLogger): string {
  return JSON.stringify([...logger.warn.mock.calls, ...logger.info.mock.calls]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleToolSchemaUnsupported — strip-and-retry contract", () => {
  beforeEach(() => {
    resetToolSchemaStripGateForTest();
  });

  it("strips pattern/format BEFORE the retry fires — observed at the retry-invocation boundary — and performs exactly ONE invokeRetry", async () => {
    const { params, tools } = makeParams();
    const retryState = makeRetryState();
    const capturedAtInvocation: string[] = [];
    const invokeRetry: InvokeRetry = vi.fn(async () => {
      // ORDERING pin: serialize the session-held toolset AT INVOCATION TIME.
      capturedAtInvocation.push(JSON.stringify(params.mergedCustomTools));
      return { succeeded: true };
    });

    await handleToolSchemaUnsupported(params, "msg", undefined, makeBridgeSnapshot(), retryState, invokeRetry);

    expect(invokeRetry).toHaveBeenCalledTimes(1);
    expect(capturedAtInvocation).toHaveLength(1);
    expect(capturedAtInvocation[0]).not.toContain('"pattern"');
    expect(capturedAtInvocation[0]).not.toContain('"format"');
    expect(retryState.promptSucceeded).toBe(true);
    // The clean tool rode along untouched.
    expect(JSON.stringify(tools[1].parameters)).toBe(JSON.stringify(wellFormedTool.parameters));
  });

  it("post-retry empty-check mirrors signed-replay: succeeded retry with empty text and llmCalls>0 && !textEmitted declares terminal failure", async () => {
    const { params, getLastAssistantText, bridgeGetResult } = makeParams();
    getLastAssistantText.mockReturnValue("");
    bridgeGetResult.mockReturnValue({ llmCalls: 2, textEmitted: false, finishReason: "error" });
    const retryState = makeRetryState();
    const invokeRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));

    await handleToolSchemaUnsupported(params, "msg", undefined, makeBridgeSnapshot(), retryState, invokeRetry);

    expect(retryState.promptSucceeded).toBe(false);
    expect(retryState.promptError).toBeInstanceOf(Error);
  });

  it("WARN carries tool + keyword NAMES with errorKind validation and a hint naming comisCompat.toolSchemaProfile — never schema bodies or the raw provider body", async () => {
    const { params, logger } = makeParams();
    const retryState = makeRetryState();
    const invokeRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));

    await handleToolSchemaUnsupported(params, "msg", undefined, makeBridgeSnapshot(), retryState, invokeRetry);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnArg = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(warnArg.toolNames).toEqual(["schedule_task"]);
    expect(warnArg.strippedKeywords).toEqual(["pattern", "format"]);
    expect(warnArg.provider).toBe("my-ollama");
    expect(warnArg.modelId).toBe("qwen3.6:35b");
    expect(warnArg.errorKind).toBe("validation");
    expect(String(warnArg.hint)).toContain("comisCompat.toolSchemaProfile");

    // Privacy: no schema bodies, no raw provider body in ANY new log line.
    const allArgs = allLogArgsStringified(logger);
    expect(allArgs).not.toContain("SECRET_MARKER");
    expect(allArgs).not.toContain('{\\"type\\"');
    expect(allArgs).not.toContain('{"type"');
  });

  it("emits exactly one execution:tool_schema_unsupported event with the locked 8-field payload (formatted sessionKey, clock-injected timestamp, reason discriminator)", async () => {
    const { params, emit } = makeParams();
    const retryState = makeRetryState();
    const invokeRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));

    await handleToolSchemaUnsupported(params, "msg", undefined, makeBridgeSnapshot(), retryState, invokeRetry);

    const schemaEvents = emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported");
    expect(schemaEvents).toHaveLength(1);
    expect(schemaEvents[0][1]).toEqual({
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      toolNames: ["schedule_task"],
      strippedKeywords: ["pattern", "format"],
      retried: true,
      succeeded: true,
      // The branch discriminator — without it the
      // gate-closed and nothing-to-strip terminal events were byte-identical
      // and the obs verdict misdirected the operator.
      reason: "stripped",
      timestamp: 1234,
    });
  });

  it("once-per-session gate: a second grammar-400 in the same session produces honest classified failure with ZERO additional retries and a retried:false event", async () => {
    const first = makeParams();
    const firstRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    await handleToolSchemaUnsupported(first.params, "msg", undefined, makeBridgeSnapshot(), makeRetryState(), firstRetry);
    expect(firstRetry).toHaveBeenCalledTimes(1);

    // Second occurrence — SAME sessionKey (fresh params object, same key).
    const second = makeParams();
    const secondRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    const secondState = makeRetryState();
    await handleToolSchemaUnsupported(second.params, "msg", undefined, makeBridgeSnapshot(), secondState, secondRetry);

    expect(secondRetry).not.toHaveBeenCalled();
    expect(secondState.promptSucceeded).toBe(false);
    expect(secondState.promptError).toBeInstanceOf(Error);
    // The terminal error carries the classified source so failure-path
    // classification yields the canned tool_schema_unsupported userMessage.
    expect(String(secondState.promptError)).toContain("JSON schema conversion failed");
    const gateEvents = second.emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported");
    expect(gateEvents).toHaveLength(1);
    // Gate-closed must be distinguishable from nothing-to-strip — a
    // session that healed once and then hit the gate previously produced a
    // verdict claiming "nothing strippable" when stripping WAS performed.
    expect(gateEvents[0][1]).toMatchObject({
      retried: false,
      succeeded: false,
      toolNames: [],
      reason: "gate_closed",
    });
    // Gate-closed WARN still actionable: hint names the durable knob.
    const warnArg = second.logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(String(warnArg.hint)).toContain("comisCompat.toolSchemaProfile");
    expect(warnArg.errorKind).toBe("validation");
  });

  it("once-per-session gate is keyed by session: a DIFFERENT sessionKey gets its own single strip-retry", async () => {
    const first = makeParams({ channelId: "c-one" });
    const firstRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    await handleToolSchemaUnsupported(first.params, "msg", undefined, makeBridgeSnapshot(), makeRetryState(), firstRetry);
    expect(firstRetry).toHaveBeenCalledTimes(1);

    const other = makeParams({ channelId: "c-two" });
    const otherRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    await handleToolSchemaUnsupported(other.params, "msg", undefined, makeBridgeSnapshot(), makeRetryState(), otherRetry);
    expect(otherRetry).toHaveBeenCalledTimes(1);
  });

  it("nothing-to-strip branch: clean toolset performs NO futile retry, WARNs with the proactive-profile hint, sets the gate, and emits retried:false", async () => {
    const clean = [
      {
        name: wellFormedTool.name,
        description: wellFormedTool.description,
        parameters: structuredClone(wellFormedTool.parameters) as Record<string, unknown>,
      },
    ];
    const { params, logger, emit } = makeParams({ tools: clean });
    const retryState = makeRetryState();
    const invokeRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));

    await handleToolSchemaUnsupported(params, "msg", undefined, makeBridgeSnapshot(), retryState, invokeRetry);

    // A retry with identical schemas is a guaranteed identical 400 — futile.
    expect(invokeRetry).not.toHaveBeenCalled();
    expect(retryState.promptSucceeded).toBe(false);
    expect(retryState.promptError).toBeInstanceOf(Error);
    const warnArg = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(warnArg.toolNames).toEqual([]);
    expect(String(warnArg.hint)).toContain('comisCompat.toolSchemaProfile');
    expect(String(warnArg.hint)).toContain('"gbnf"');
    const events = emit.mock.calls.filter((c) => c[0] === "execution:tool_schema_unsupported");
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      retried: false,
      succeeded: false,
      toolNames: [],
      reason: "nothing_to_strip",
    });

    // The once-gate is STILL set: a second occurrence does not re-enter.
    const second = makeParams({ tools: structuredClone(clean) });
    const secondRetry: InvokeRetry = vi.fn(async () => ({ succeeded: true }));
    await handleToolSchemaUnsupported(second.params, "msg", undefined, makeBridgeSnapshot(), makeRetryState(), secondRetry);
    expect(secondRetry).not.toHaveBeenCalled();
  });
});
