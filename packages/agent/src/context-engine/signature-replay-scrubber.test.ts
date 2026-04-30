// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the signature replay scrubber context engine layer.
 *
 * Verifies the always-on, latest-included scrub policy: every assistant
 * message (latest included) has its thinkingSignature cleared and its
 * toolCall thoughtSignature stripped; redacted_thinking blocks are never
 * modified; cache fence is IGNORED (260430-anthropic-400-thinking-block);
 * immutability guarantees hold; INFO log is emitted exactly once per
 * apply() when at least one assistant message was scrubbed.
 *
 * 260428-nzp: the previous "preserve latest" carve-out was removed —
 * cross-turn signature validation invalidates the latest's signatures too
 * because the surrounding context (system + tools + history) drifts
 * turn-to-turn under comis's dynamic context engine.
 *
 * 260430-anthropic-400-thinking-block: the previous "preserve fenced"
 * carve-out was also removed. The scrubber is pure/deterministic, so
 * stripping uniformly across the array keeps the scrubbed prefix identical
 * across iterations of the same execution. This is what Anthropic's
 * prompt-cache validator requires; the prior fence-skip caused per-
 * execution divergence (iter 1 stripped, iter 2 preserved fence-protected
 * messages with their on-disk signatures intact, cache validator rejected
 * with `400 ... blocks cannot be modified`).
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
  // Single assistant: latest IS scrubbed (260428-nzp)
  // -------------------------------------------------------------------------

  it("single assistant message: signed thinking block stripped from the latest (no carve-out)", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeSignedThinkingBlock("t", "sig-1"), makeTextBlock("a")]),
    ];
    const result = await layer.apply(messages, stubBudget);

    // Signed thinking block stripped entirely; text block remains.
    expect(result).not.toBe(messages);
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content).toHaveLength(1);
    expect(m0.content[0]).toEqual(makeTextBlock("a"));

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 1,
        blocksAffected: 1,
        toolCallsAffected: 0,
        latestAssistantIdx: 0,
      },
      "Dropped thinking signatures from all assistant messages (cross-turn replay)",
    );

    expect(onScrubbed).toHaveBeenCalledTimes(1);
    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 1,
      blocksAffected: 1,
      toolCallsAffected: 0,
      latestAssistantIdx: 0,
      dropped: 1,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Two assistants: BOTH scrubbed (latest no longer preserved)
  // -------------------------------------------------------------------------

  it("two assistant messages: signed thinking stripped from BOTH (older + latest)", async () => {
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

    // Older assistant: signed thinking block stripped, text block remains.
    const m1 = result[1] as { content: Array<Record<string, unknown>> };
    expect(m1.content).toHaveLength(1);
    expect(m1.content[0]).toEqual(makeTextBlock("a"));

    // Latest assistant ALSO stripped (no carve-out).
    expect(result[3]).not.toBe(messages[3]);
    const m3 = result[3] as { content: Array<Record<string, unknown>> };
    expect(m3.content).toHaveLength(1);
    expect(m3.content[0]).toEqual(makeTextBlock("b"));

    // User messages preserved as same references.
    expect(result[0]).toBe(messages[0]);
    expect(result[2]).toBe(messages[2]);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 2,
        blocksAffected: 2,
        toolCallsAffected: 0,
        latestAssistantIdx: 3,
      },
      "Dropped thinking signatures from all assistant messages (cross-turn replay)",
    );

    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 2,
      blocksAffected: 2,
      toolCallsAffected: 0,
      latestAssistantIdx: 3,
      dropped: 2,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // ALL assistants scrubbed (including the latest)
  // -------------------------------------------------------------------------

  it("ALL assistant messages scrubbed: thinking blocks stripped and tool_call signatures stripped on every turn", async () => {
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

    // Every assistant turn (1, 3, 5, 7) — INCLUDING the latest at index 7 — is scrubbed.
    for (const idx of [1, 3, 5, 7]) {
      const m = result[idx] as { content: Array<Record<string, unknown>> };
      // Signed thinking block stripped; only the toolCall block remains.
      expect(m.content).toHaveLength(1);
      expect(m.content[0]).not.toHaveProperty("thoughtSignature");
      expect(m.content[0]).toMatchObject({ type: "tool_call", toolCallId: "call-1", toolName: "test_tool" });
      expect(result[idx]).not.toBe(messages[idx]);
    }

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 4,
        blocksAffected: 4,
        toolCallsAffected: 4,
        latestAssistantIdx: 7,
      },
      "Dropped thinking signatures from all assistant messages (cross-turn replay)",
    );
  });

  // -------------------------------------------------------------------------
  // Redacted thinking blocks left untouched (everywhere, latest included)
  // -------------------------------------------------------------------------

  it("redacted_thinking blocks are left untouched in older AND latest assistant messages", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const olderRedacted = makeRedactedThinkingBlock();
    const latestRedacted = makeRedactedThinkingBlock();

    const olderAssistant = makeAssistantMsg([
      makeSignedThinkingBlock("signed-o", "sig-o"),
      olderRedacted,
      makeTextBlock("after-o"),
    ]);
    const latestAssistant = makeAssistantMsg([
      makeSignedThinkingBlock("signed-l", "sig-l"),
      latestRedacted,
      makeTextBlock("after-l"),
    ]);
    const messages: AgentMessage[] = [olderAssistant, latestAssistant];

    const result = await layer.apply(messages, stubBudget);

    // Older assistant: signed block stripped, redacted byte-identical, text kept.
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content).toHaveLength(2);
    expect(m0.content[0]).toBe(olderRedacted);
    expect(m0.content[1]).toEqual(makeTextBlock("after-o"));

    // Latest assistant: signed block stripped, redacted byte-identical, text kept.
    const m1 = result[1] as { content: Array<Record<string, unknown>> };
    expect(m1.content).toHaveLength(2);
    expect(m1.content[0]).toBe(latestRedacted);
    expect(m1.content[1]).toEqual(makeTextBlock("after-l"));
  });

  // -------------------------------------------------------------------------
  // toolCall thoughtSignature stripped on the latest too
  // -------------------------------------------------------------------------

  it("thoughtSignature stripped from toolCall on the LATEST assistant message", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    // Single-assistant history: the only assistant IS the latest. Verifies the
    // carve-out is gone — its tool_call signature still gets stripped.
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeToolCallBlock({ thoughtSignature: "sig-A" })]),
    ];
    const result = await layer.apply(messages, stubBudget);

    expect(result).not.toBe(messages);
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
      latestAssistantIdx: 0,
      dropped: 0,
      signaturesStripped: 1,
      reason: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // Pass-through cases (no-op zero-allocation preserved)
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

  it("user and toolResult messages pass through; latest assistant with no signed state is byte-identical", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const userMsg = makeUserMsg("hello");
    const toolResult = { role: "toolResult", content: [{ type: "text", text: "result" }] } as AgentMessage;
    // Latest assistant has plain (unsigned) thinking — nothing to do.
    const latestAssistant = makeAssistantMsg([makeThinkingBlock("plain"), makeTextBlock("a")]);
    const messages: AgentMessage[] = [userMsg, toolResult, latestAssistant];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(result[0]).toBe(userMsg);
    expect(result[1]).toBe(toolResult);
    expect(result[2]).toBe(latestAssistant);
    expect(logger.info).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Cache fence is IGNORED (260430-anthropic-400-thinking-block)
  //
  // The scrubber must strip uniformly across the array, regardless of
  // budget.cacheFenceIndex. Stripping is pure/deterministic so the same
  // input produces the same scrubbed output every time, which is what
  // Anthropic's prompt-cache validator requires.
  // -------------------------------------------------------------------------

  it("260430-anthropic-400-thinking-block: cacheFenceIndex is ignored — fence-protected messages are still scrubbed", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const messages: AgentMessage[] = [
      makeAssistantMsg([makeSignedThinkingBlock("t0", "s0"), makeTextBlock("a0")]), // index 0 — would be fenced
      makeAssistantMsg([makeSignedThinkingBlock("t1", "s1"), makeTextBlock("a1")]), // index 1 — would be fenced
      makeAssistantMsg([makeSignedThinkingBlock("t2", "s2"), makeTextBlock("a2")]), // index 2 — past fence
      makeAssistantMsg([makeSignedThinkingBlock("t3", "s3"), makeTextBlock("a3")]), // index 3 — latest
    ];

    const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 1 };
    const result = await layer.apply(messages, fencedBudget);

    // ALL 4 assistants get their signed thinking stripped — the fence is no
    // longer a gate. Verifies the fix for the "blocks cannot be modified"
    // 400 error class.
    for (const idx of [0, 1, 2, 3]) {
      expect(result[idx]).not.toBe(messages[idx]);
      const m = result[idx] as { content: Array<Record<string, unknown>> };
      expect(m.content).toHaveLength(1);
      expect(m.content[0]).toEqual(makeTextBlock(`a${idx}`));
    }

    expect(onScrubbed).toHaveBeenCalledWith({
      scrubbedAssistantMessages: 4,
      blocksAffected: 4,
      toolCallsAffected: 0,
      latestAssistantIdx: 3,
      dropped: 4,
      signaturesStripped: 0,
      reason: undefined,
    });
  });

  it("260430-anthropic-400-thinking-block: deterministic across cacheFenceIndex variations — same input → same scrubbed output", async () => {
    // Pin the prefix-stability invariant: the bug was that fence=-1 produced
    // one prefix and fence>0 produced a different prefix for the SAME on-disk
    // messages. The fix makes the output independent of cacheFenceIndex.
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });

    const buildMessages = (): AgentMessage[] => [
      makeAssistantMsg([makeSignedThinkingBlock("t0", "s0"), makeTextBlock("a0"), makeToolCallBlock({ thoughtSignature: "ts0" })]),
      makeAssistantMsg([makeSignedThinkingBlock("t1", "s1"), makeTextBlock("a1")]),
      makeAssistantMsg([makeSignedThinkingBlock("t2", "s2"), makeToolCallBlock({ thoughtSignature: "ts2" })]),
      makeAssistantMsg([makeSignedThinkingBlock("t3", "s3"), makeTextBlock("a3")]),
    ];

    const resultFenceMinus1 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: -1 });
    const resultFence0 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 0 });
    const resultFence2 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 2 });
    const resultFence3 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 3 });
    const resultFence99 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 99 });

    // All five outputs must be byte-equal. JSON.stringify is sufficient for
    // structural equality on POJO content here.
    const ref = JSON.stringify(resultFenceMinus1);
    expect(JSON.stringify(resultFence0)).toBe(ref);
    expect(JSON.stringify(resultFence2)).toBe(ref);
    expect(JSON.stringify(resultFence3)).toBe(ref);
    expect(JSON.stringify(resultFence99)).toBe(ref);
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it("immutability: deep-frozen input does not throw, original blocks unchanged (latest scrubbed too)", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });

    const olderAssistant = makeAssistantMsg([
      makeSignedThinkingBlock("t1", "sig-orig"),
      makeTextBlock("a1"),
      makeToolCallBlock({ thoughtSignature: "sig-tc" }),
    ]);
    const latestAssistant = makeAssistantMsg([
      makeSignedThinkingBlock("t-latest", "sig-latest"),
      makeTextBlock("latest"),
    ]);
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
    const orig0 = inputMessages[0] as { content: Array<Record<string, unknown>> };
    expect(orig0.content).toHaveLength(3);
    expect(orig0.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "sig-orig" });
    expect(orig0.content[2]).toHaveProperty("thoughtSignature", "sig-tc");

    const orig1 = inputMessages[1] as { content: Array<Record<string, unknown>> };
    expect(orig1.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "sig-latest" });

    // Result reflects the scrub on BOTH older and latest.
    const scrubbed0 = result[0] as { content: Array<Record<string, unknown>> };
    // Signed thinking block stripped; text block + toolCall (sans thoughtSignature) remain.
    expect(scrubbed0.content).toHaveLength(2);
    expect(scrubbed0.content[0]).toEqual(makeTextBlock("a1"));
    expect(scrubbed0.content[1]).not.toHaveProperty("thoughtSignature");

    const scrubbed1 = result[1] as { content: Array<Record<string, unknown>> };
    // Signed thinking block stripped; text block remains.
    expect(scrubbed1.content).toHaveLength(1);
    expect(scrubbed1.content[0]).toEqual(makeTextBlock("latest"));
  });

  // -------------------------------------------------------------------------
  // INFO log shape (explicit assertion of exact payload)
  // -------------------------------------------------------------------------

  it("INFO log shape and counters reflect TOTAL counts across all scrubbed messages (latest included)", async () => {
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
      makeAssistantMsg([
        makeSignedThinkingBlock("latest", "s3"),
        makeToolCallBlock({ thoughtSignature: "ts3" }),
      ]),
    ];
    await layer.apply(messages, stubBudget);

    expect(logger.info).toHaveBeenCalledWith(
      {
        module: "agent.context-engine.signature-replay-scrub",
        scrubbedAssistantMessages: 3,
        blocksAffected: 3,
        toolCallsAffected: 3,
        latestAssistantIdx: 2,
      },
      "Dropped thinking signatures from all assistant messages (cross-turn replay)",
    );
  });

  // -------------------------------------------------------------------------
  // Already-empty signature pass-through (no double-scrub)
  // -------------------------------------------------------------------------

  it("thinking block with empty thinkingSignature is left untouched (no double-scrub) — latest included", async () => {
    const logger = makeLoggerMock();
    const onScrubbed = vi.fn();
    const layer = createSignatureReplayScrubber({ logger, onScrubbed });

    const blockWithEmptySig = { type: "thinking" as const, thinking: "t", thinkingSignature: "" };
    // Single assistant (which is also the latest) — empty sig means nothing to do.
    const onlyAssistant = makeAssistantMsg([blockWithEmptySig, makeTextBlock("a")]);
    const messages: AgentMessage[] = [onlyAssistant];

    const result = await layer.apply(messages, stubBudget);
    // No work to do: zero-alloc same-ref return.
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
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
  // Plain-thinking (no signature) untouched
  // -------------------------------------------------------------------------

  it("thinking block with NO thinkingSignature property is left untouched (older + latest)", async () => {
    const logger = makeLoggerMock();
    const layer = createSignatureReplayScrubber({ logger });
    const olderPlain = makeThinkingBlock("plain-o");
    const latestPlain = makeThinkingBlock("plain-l");
    const olderAssistant = makeAssistantMsg([olderPlain]);
    const latestAssistant = makeAssistantMsg([latestPlain]);
    const messages: AgentMessage[] = [olderAssistant, latestAssistant];

    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
