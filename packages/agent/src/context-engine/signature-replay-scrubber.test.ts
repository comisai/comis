// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the signature replay scrubber context engine layer.
 *
 * Verifies the always-on latest-message-preserving scrub policy: every
 * assistant message older than the most recent assistant turn has its
 * thinkingSignature cleared and its toolCall thoughtSignature stripped;
 * the latest assistant message is preserved untouched; redacted_thinking
 * blocks are never modified; cache fence is respected; immutability
 * guarantees hold; INFO log is emitted exactly once per apply() when at
 * least one older assistant message was scrubbed.
 */

import { describe, it, expect, vi } from "vitest";
import { createSignatureReplayScrubber } from "./signature-replay-scrubber.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";
import type { ComisLogger } from "@comis/infra";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeThinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}
function makeSignedThinkingBlock(text: string, sig: string) {
  return { type: "thinking" as const, thinking: text, thinkingSignature: sig };
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

function makeLoggerMock(): ComisLogger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape match for test mock
    child: vi.fn(),
  } as unknown as ComisLogger;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSignatureReplayScrubber", () => {
  it("layer name is 'signature-replay-scrubber'", () => {
    const layer = createSignatureReplayScrubber({ logger: makeLoggerMock() });
    expect(layer.name).toBe("signature-replay-scrubber");
  });

  // -------------------------------------------------------------------------
  // Empty / no assistant
  // -------------------------------------------------------------------------

  it("empty messages array returns same reference", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });
    const messages: AgentMessage[] = [];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
    expect(onScrubbed).not.toHaveBeenCalled();
  });

  it("history with no assistant messages returns same reference and does not emit INFO log", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });
    const messages: AgentMessage[] = [makeUserMsg("hello")];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
    expect(onScrubbed).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Single assistant: untouched, no INFO log
  // -------------------------------------------------------------------------

  it("single assistant message: signatures preserved, no scrub, no INFO log", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeSignedThinkingBlock("t", "sig-1"), makeTextBlock("a")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages); // zero-alloc same-ref return
    expect(result[0]).toBe(messages[0]);
    expect(logger.info).not.toHaveBeenCalled();
    // onScrubbed still fires so snapshot stays consistent on zero-touch turns.
    expect(onScrubbed).toHaveBeenCalledTimes(1);
    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 0,
      blocksAffected: 0,
      toolCallsAffected: 0,
      latestAssistantIdx: 0,
      dropped: 0,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Two assistants: older scrubbed, latest preserved
  // -------------------------------------------------------------------------

  it("two assistant messages: signatures cleared on the older, preserved on the latest", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const olderAssistant = makeAssistantMsg([makeSignedThinkingBlock("old", "sig-old"), makeTextBlock("a")]);
    const latestAssistant = makeAssistantMsg([makeSignedThinkingBlock("new", "sig-new"), makeTextBlock("b")]);

    const messages: AgentMessage[] = [
      makeUserMsg("u1"),
      olderAssistant,
      makeUserMsg("u2"),
      latestAssistant,
    ];
    const result = await layer.apply(messages, stubBudget);

    // Older assistant scrubbed: thinkingSignature cleared (property kept as "").
    const m1 = result[1] as { content: Array<Record<string, unknown>> };
    expect(m1.content).toHaveLength(2);
    expect(m1.content[0]).toMatchObject({ type: "thinking", thinking: "old", thinkingSignature: "" });
    expect(m1.content[1]).toEqual(makeTextBlock("a"));

    // Latest assistant: untouched, same reference preserved.
    expect(result[3]).toBe(messages[3]);

    // INFO log emitted exactly once with the right counters.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 1,
        blocksAffected: 1,
        toolCallsAffected: 0,
        latestAssistantIdx: 3,
      },
      "Dropped thinking signatures from non-latest assistant messages",
    );

    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 1,
      blocksAffected: 1,
      toolCallsAffected: 0,
      latestAssistantIdx: 3,
      dropped: 1,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // N-1 earlier assistants scrubbed; only the Nth preserved
  // -------------------------------------------------------------------------

  it("N-1 earlier assistant messages all scrubbed; only the Nth preserved", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });

    const messages: AgentMessage[] = [
      makeUserMsg("u1"),
      makeAssistantMsg([makeSignedThinkingBlock("a1", "s1"), makeToolCallBlock({ thoughtSignature: "ts1" })]),
      makeUserMsg("u2"),
      makeAssistantMsg([makeSignedThinkingBlock("a2", "s2"), makeToolCallBlock({ thoughtSignature: "ts2" })]),
      makeUserMsg("u3"),
      makeAssistantMsg([makeSignedThinkingBlock("a3", "s3"), makeToolCallBlock({ thoughtSignature: "ts3" })]),
      makeUserMsg("u4"),
      makeAssistantMsg([makeSignedThinkingBlock("a4", "s4"), makeToolCallBlock({ thoughtSignature: "ts4" })]),
    ];
    const result = await layer.apply(messages, stubBudget);

    for (const idx of [1, 3, 5]) {
      const m = result[idx] as { content: Array<Record<string, unknown>> };
      expect(m.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "" });
      expect(m.content[1]).not.toHaveProperty("thoughtSignature");
      expect(m.content[1]).toMatchObject({ type: "tool_call", toolCallId: "call-1", toolName: "test_tool" });
    }

    // Latest assistant (index 7) untouched, same reference.
    expect(result[7]).toBe(messages[7]);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 3,
        blocksAffected: 3,
        toolCallsAffected: 3,
        latestAssistantIdx: 7,
      },
      "Dropped thinking signatures from non-latest assistant messages",
    );
  });

  // -------------------------------------------------------------------------
  // Redacted thinking blocks left untouched
  // -------------------------------------------------------------------------

  it("redacted_thinking blocks are left untouched in older assistant messages", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const redacted = makeRedactedThinkingBlock();

    const olderAssistant = makeAssistantMsg([
      makeSignedThinkingBlock("signed", "sig-s"),
      redacted,
      makeTextBlock("after"),
    ]);
    const latestAssistant = makeAssistantMsg([makeTextBlock("latest")]);
    const messages: AgentMessage[] = [olderAssistant, latestAssistant];

    const result = await layer.apply(messages, stubBudget);

    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content).toHaveLength(3);
    // Signed thinking: signature cleared, property kept as "".
    expect(m0.content[0]).toMatchObject({ type: "thinking", thinking: "signed", thinkingSignature: "" });
    // Redacted thinking: byte-identical (same reference).
    expect(m0.content[1]).toBe(redacted);
    // Trailing text untouched.
    expect(m0.content[2]).toEqual(makeTextBlock("after"));

    // Latest preserved as same reference.
    expect(result[1]).toBe(messages[1]);
  });

  // -------------------------------------------------------------------------
  // toolCall thoughtSignature stripped
  // -------------------------------------------------------------------------

  it("thoughtSignature stripped from toolCall in older assistant messages, other fields preserved", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeToolCallBlock({ thoughtSignature: "sig-A" })]),
      makeAssistantMsg([makeTextBlock("latest")]),
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

    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 1,
      blocksAffected: 0,
      toolCallsAffected: 1,
      latestAssistantIdx: 1,
      dropped: 0,
      signaturesStripped: 1,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Pass-through cases
  // -------------------------------------------------------------------------

  it("messages without any thinking blocks pass through unchanged (zero-alloc)", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeTextBlock("a"), makeTextBlock("b")]),
      makeUserMsg("u"),
      makeAssistantMsg([makeTextBlock("c")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    // Zero-alloc same-ref return when nothing changed.
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 0,
      blocksAffected: 0,
      toolCallsAffected: 0,
      latestAssistantIdx: 2,
      dropped: 0,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  it("user and toolResult messages pass through; assistant signatures preserved on latest", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const userMsg = makeUserMsg("hello");
    const toolResult = { role: "toolResult", content: [{ type: "text", text: "result" }] } as AgentMessage;
    const latestAssistant = makeAssistantMsg([makeSignedThinkingBlock("t", "sig-X"), makeTextBlock("a")]);
    const messages: AgentMessage[] = [userMsg, toolResult, latestAssistant];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(result[0]).toBe(userMsg);
    expect(result[1]).toBe(toolResult);
    expect(result[2]).toBe(latestAssistant);
    expect(logger.info).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Cache fence
  // -------------------------------------------------------------------------

  it("respects budget.cacheFenceIndex: messages at/below fence untouched even if older than latest", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeSignedThinkingBlock("t0", "s0"), makeTextBlock("a0")]), // index 0 — fenced
      makeAssistantMsg([makeSignedThinkingBlock("t1", "s1"), makeTextBlock("a1")]), // index 1 — fenced
      makeAssistantMsg([makeSignedThinkingBlock("t2", "s2"), makeTextBlock("a2")]), // index 2 — older + past fence → scrubbed
      makeAssistantMsg([makeSignedThinkingBlock("t3", "s3"), makeTextBlock("a3")]), // index 3 — latest, untouched
    ];

    const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 1 };
    const result = await layer.apply(messages, fencedBudget);

    // Fenced messages: same references, untouched.
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    // Older + past fence: signature cleared.
    const m2 = result[2] as { content: Array<Record<string, unknown>> };
    expect(m2.content[0]).toMatchObject({ type: "thinking", thinking: "t2", thinkingSignature: "" });
    expect(m2.content[1]).toEqual(makeTextBlock("a2"));
    // Latest assistant: untouched.
    expect(result[3]).toBe(messages[3]);

    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 1,
      blocksAffected: 1,
      toolCallsAffected: 0,
      latestAssistantIdx: 3,
      dropped: 1,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it("immutability: deep-frozen input does not throw, original blocks unchanged", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });

    const olderAssistant = makeAssistantMsg([
      makeSignedThinkingBlock("t1", "sig-orig"),
      makeTextBlock("a1"),
      makeToolCallBlock({ thoughtSignature: "sig-tc" }),
    ]);
    const latestAssistant = makeAssistantMsg([makeTextBlock("latest")]);
    const inputMessages: AgentMessage[] = [olderAssistant, latestAssistant];

    // Deep-freeze input
    for (const msg of inputMessages) {
      const m = msg as { content: unknown[] };
      Object.freeze(m.content);
      for (const block of m.content) Object.freeze(block);
      Object.freeze(msg);
    }
    Object.freeze(inputMessages);

    // Should not throw
    const result = await layer.apply(inputMessages, stubBudget);

    // Originals still intact.
    const orig = inputMessages[0] as { content: Array<Record<string, unknown>> };
    expect(orig.content).toHaveLength(3);
    expect(orig.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "sig-orig" });
    expect(orig.content[2]).toHaveProperty("thoughtSignature", "sig-tc");

    // Result reflects the scrub.
    const scrubbed = result[0] as { content: Array<Record<string, unknown>> };
    expect(scrubbed.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "" });
    expect(scrubbed.content[2]).not.toHaveProperty("thoughtSignature");
  });

  // -------------------------------------------------------------------------
  // INFO log shape (explicit assertion of exact payload)
  // -------------------------------------------------------------------------

  it("INFO log shape and counters", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        makeSignedThinkingBlock("o1", "s1"),
        makeToolCallBlock({ thoughtSignature: "ts1" }),
      ]),
      makeAssistantMsg([
        makeSignedThinkingBlock("o2", "s2"),
        makeToolCallBlock({ thoughtSignature: "ts2" }),
      ]),
      makeAssistantMsg([makeTextBlock("latest")]),
    ];
    await layer.apply(messages, stubBudget);

    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 2,
        blocksAffected: 2,
        toolCallsAffected: 2,
        latestAssistantIdx: 2,
      },
      "Dropped thinking signatures from non-latest assistant messages",
    );
  });

  // -------------------------------------------------------------------------
  // Already-empty signature pass-through
  // -------------------------------------------------------------------------

  it("thinking block with empty thinkingSignature is left untouched (no double-scrub)", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const blockWithEmptySig = { type: "thinking" as const, thinking: "t", thinkingSignature: "" };
    const olderAssistant = makeAssistantMsg([blockWithEmptySig, makeTextBlock("a")]);
    const latestAssistant = makeAssistantMsg([makeTextBlock("latest")]);
    const messages: AgentMessage[] = [olderAssistant, latestAssistant];

    const result = await layer.apply(messages, stubBudget);
    // No work to do: zero-alloc same-ref return.
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 0,
      blocksAffected: 0,
      toolCallsAffected: 0,
      latestAssistantIdx: 1,
      dropped: 0,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Plain-thinking (no signature) untouched
  // -------------------------------------------------------------------------

  it("thinking block with NO thinkingSignature property is left untouched", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const plainBlock = makeThinkingBlock("plain");
    const olderAssistant = makeAssistantMsg([plainBlock]);
    const latestAssistant = makeAssistantMsg([makeTextBlock("latest")]);
    const messages: AgentMessage[] = [olderAssistant, latestAssistant];

    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
