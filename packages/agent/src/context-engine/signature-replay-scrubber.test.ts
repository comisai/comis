// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the signature replay scrubber context engine layer.
 *
 * Verifies the gate (drop=false → no-op), full-history scrub when drift
 * fires, cache fence respect, immutability, and reason propagation.
 */

import { describe, it, expect, vi } from "vitest";
import { createSignatureReplayScrubber } from "./signature-replay-scrubber.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";
import type { DriftCheck } from "../executor/replay-drift-detector.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeThinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}
function makeRedactedThinkingBlock() {
  return { type: "thinking" as const, thinking: "", redacted: true, thinkingSignature: "sig-r" };
}
function makeTextBlock(text: string) {
  return { type: "text" as const, text };
}
function makeToolCallBlock(extra: Record<string, unknown> = {}) {
  return {
    type: "tool_call" as const,
    toolCallId: "call-1",
    toolName: "test_tool",
    args: { a: 1 },
    ...extra,
  };
}
function makeAssistantMsg(content: unknown[]): AgentMessage {
  return { role: "assistant", content } as AgentMessage;
}
function makeUserMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

const stubBudget: TokenBudget = {
  windowTokens: 200_000,
  systemTokens: 5_000,
  outputReserveTokens: 8_192,
  safetyMarginTokens: 10_000,
  contextRotBufferTokens: 50_000,
  availableHistoryTokens: 126_808,
  cacheFenceIndex: -1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSignatureReplayScrubber", () => {
  it("layer name is 'signature-replay-scrubber'", () => {
    const layer = createSignatureReplayScrubber({ getReplayDriftMode: () => undefined });
    expect(layer.name).toBe("signature-replay-scrubber");
  });

  // -------------------------------------------------------------------------
  // Gate closed → no-op
  // -------------------------------------------------------------------------

  it("returns input reference unchanged when drift returns undefined", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => undefined,
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("t"), makeTextBlock("a")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onScrubbed).not.toHaveBeenCalled();
  });

  it("returns input reference unchanged when drift returns drop=false", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: false }),
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("t"), makeTextBlock("a")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onScrubbed).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Drop=true with no thinking / signed tool calls
  // -------------------------------------------------------------------------

  it("drop=true with no thinking/signed toolCall: returns input reference, callback fires with zero counts", async () => {
    const onScrubbed = vi.fn();
    const drift: DriftCheck = { drop: true, reason: "idle" };
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => drift,
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeUserMsg("u1"),
      makeAssistantMsg([makeTextBlock("just text"), makeToolCallBlock()]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onScrubbed).toHaveBeenCalledTimes(1);
    expect(onScrubbed).toHaveBeenCalledWith({ dropped: 0, signaturesStripped: 0, reason: "idle" });
  });

  // -------------------------------------------------------------------------
  // Drop=true: drops thinking, preserves text
  // -------------------------------------------------------------------------

  it("drop=true: drops thinking block, preserves text", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "model_change" }),
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("t1"), makeTextBlock("answer")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).not.toBe(messages);
    const m0 = result[0] as { content: unknown[] };
    expect(m0.content).toHaveLength(1);
    expect(m0.content[0]).toEqual(makeTextBlock("answer"));
    expect(onScrubbed).toHaveBeenCalledWith({ dropped: 1, signaturesStripped: 0, reason: "model_change" });
  });

  it("drop=true: drops redacted: true thinking blocks too", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "idle" }),
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeRedactedThinkingBlock(), makeTextBlock("answer")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    const m0 = result[0] as { content: unknown[] };
    expect(m0.content).toHaveLength(1);
    expect(m0.content[0]).toEqual(makeTextBlock("answer"));
    expect(onScrubbed).toHaveBeenCalledWith({ dropped: 1, signaturesStripped: 0, reason: "idle" });
  });

  // -------------------------------------------------------------------------
  // Drop=true: thoughtSignature stripped from toolCall
  // -------------------------------------------------------------------------

  it("drop=true: strips thoughtSignature from tool_call, preserves other fields", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "provider_change" }),
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        makeToolCallBlock({ thoughtSignature: "sig-A" }),
      ]),
    ];
    const result = await layer.apply(messages, stubBudget);
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content).toHaveLength(1);
    expect(m0.content[0]).not.toHaveProperty("thoughtSignature");
    expect(m0.content[0]).toMatchObject({
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "test_tool",
      args: { a: 1 },
    });
    expect(onScrubbed).toHaveBeenCalledWith({ dropped: 0, signaturesStripped: 1, reason: "provider_change" });
  });

  // -------------------------------------------------------------------------
  // Cache fence
  // -------------------------------------------------------------------------

  it("respects budget.cacheFenceIndex: messages at/below fence are untouched, only beyond fence get scrubbed", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "idle" }),
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("t0"), makeTextBlock("a0")]), // index 0 — fenced
      makeAssistantMsg([makeThinkingBlock("t1"), makeTextBlock("a1")]), // index 1 — fenced
      makeAssistantMsg([makeThinkingBlock("t2"), makeTextBlock("a2")]), // index 2 — modifiable
      makeAssistantMsg([makeThinkingBlock("t3"), makeTextBlock("a3")]), // index 3 — modifiable
    ];

    const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 1 };
    const result = await layer.apply(messages, fencedBudget);

    // Fenced messages: same references, untouched
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    // Modifiable messages: thinking dropped
    const m2 = result[2] as { content: unknown[] };
    const m3 = result[3] as { content: unknown[] };
    expect(m2.content).toHaveLength(1);
    expect(m3.content).toHaveLength(1);
    expect(m2.content[0]).toEqual(makeTextBlock("a2"));
    expect(m3.content[0]).toEqual(makeTextBlock("a3"));
    expect(onScrubbed).toHaveBeenCalledWith({ dropped: 2, signaturesStripped: 0, reason: "idle" });
  });

  // -------------------------------------------------------------------------
  // Reason propagation
  // -------------------------------------------------------------------------

  it("forwards drift.reason in the onScrubbed callback payload", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "api_change" }),
      onScrubbed,
    });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock("t"), makeTextBlock("a")]),
    ];
    await layer.apply(messages, stubBudget);
    expect(onScrubbed).toHaveBeenCalledTimes(1);
    expect(onScrubbed.mock.calls[0]![0]).toMatchObject({ reason: "api_change" });
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it("does not mutate input messages or content arrays even when scrubbing", async () => {
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "idle" }),
    });
    const inputMessages: AgentMessage[] = [
      makeAssistantMsg([
        makeThinkingBlock("t1"),
        makeTextBlock("a1"),
        makeToolCallBlock({ thoughtSignature: "sig-1" }),
      ]),
    ];
    // Deep-freeze
    for (const msg of inputMessages) {
      const m = msg as { content: unknown[] };
      Object.freeze(m.content);
      for (const block of m.content) Object.freeze(block);
      Object.freeze(msg);
    }
    Object.freeze(inputMessages);

    // Should not throw
    const result = await layer.apply(inputMessages, stubBudget);

    // Original inputs still intact: thinking + text + signed toolCall
    const orig = inputMessages[0] as { content: Array<Record<string, unknown>> };
    expect(orig.content).toHaveLength(3);
    expect(orig.content[0]).toEqual(makeThinkingBlock("t1"));
    expect(orig.content[2]).toHaveProperty("thoughtSignature", "sig-1");

    // Result reflects the scrub
    const scrubbed = result[0] as { content: Array<Record<string, unknown>> };
    expect(scrubbed.content).toHaveLength(2); // thinking dropped
    expect(scrubbed.content[1]).not.toHaveProperty("thoughtSignature");
  });

  it("handles user-only and toolResult messages as pass-through", async () => {
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "idle" }),
      onScrubbed,
    });
    const userMsg = makeUserMsg("hello");
    const toolResult = { role: "toolResult", content: [{ type: "text", text: "result" }] } as AgentMessage;
    const messages: AgentMessage[] = [
      userMsg,
      toolResult,
      makeAssistantMsg([makeThinkingBlock("t"), makeTextBlock("a")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result[0]).toBe(userMsg);
    expect(result[1]).toBe(toolResult);
    const m2 = result[2] as { content: unknown[] };
    expect(m2.content).toHaveLength(1);
    expect(onScrubbed).toHaveBeenCalledWith({ dropped: 1, signaturesStripped: 0, reason: "idle" });
  });

  it("empty messages array returns same reference", async () => {
    const layer = createSignatureReplayScrubber({
      getReplayDriftMode: () => ({ drop: true, reason: "idle" }),
    });
    const messages: AgentMessage[] = [];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
  });
});
