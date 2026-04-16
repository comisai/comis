/**
 * Tests for the thinking block cleaner context engine layer.
 *
 * Verifies configurable keep-window stripping of thinking blocks from
 * older assistant messages while preserving redacted thinking blocks
 * and maintaining immutability guarantees.
 */

import { describe, it, expect, vi } from "vitest";
import { createThinkingBlockCleaner } from "./thinking-block-cleaner.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeThinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}

function makeRedactedThinkingBlock() {
  return {
    type: "thinking" as const,
    thinking: "",
    redacted: true,
    thinkingSignature: "sig-abc",
  };
}

function makeTextBlock(text: string) {
  return { type: "text" as const, text };
}

function makeToolCallBlock() {
  return {
    type: "tool_call" as const,
    toolCallId: "call-1",
    toolName: "test_tool",
    args: {},
  };
}

function makeAssistantMsg(content: unknown[]): AgentMessage {
  return { role: "assistant", content } as AgentMessage;
}

function makeUserMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

/** Stub budget -- thinking cleaner ignores budget so values don't matter. */
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

describe("createThinkingBlockCleaner", () => {
  it("a) no-op when no thinking blocks -- returns same reference", async () => {
    const layer = createThinkingBlockCleaner(10);
    const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
      makeAssistantMsg([makeTextBlock(`msg-${i}`)]),
    );

    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages); // reference equality
  });

  it("b) strips thinking from old messages, preserves in recent (keepTurns=10)", async () => {
    const layer = createThinkingBlockCleaner(10);
    const messages: AgentMessage[] = Array.from({ length: 12 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );

    const result = await layer.apply(messages, stubBudget);

    // First 2 (oldest) should have thinking stripped
    for (let i = 0; i < 2; i++) {
      const msg = result[i] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0]).toEqual(makeTextBlock(`text-${i}`));
    }

    // Last 10 should retain both thinking and text
    for (let i = 2; i < 12; i++) {
      const msg = result[i] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(2);
    }
  });

  it("c) preserves redacted thinking blocks regardless of age", async () => {
    const layer = createThinkingBlockCleaner(10);
    // 15 assistant messages, oldest has redacted thinking block
    const messages: AgentMessage[] = Array.from({ length: 15 }, (_, i) =>
      makeAssistantMsg([
        i === 0 ? makeRedactedThinkingBlock() : makeThinkingBlock(`think-${i}`),
        makeTextBlock(`text-${i}`),
      ]),
    );

    const result = await layer.apply(messages, stubBudget);

    // Oldest message (index 0) -- beyond keep-window (5 beyond 10)
    // But its redacted thinking block MUST be preserved
    const oldest = result[0] as { role: string; content: unknown[] };
    expect(oldest.content).toHaveLength(2); // redacted thinking + text
    const redactedBlock = oldest.content[0] as { type: string; redacted?: boolean };
    expect(redactedBlock.type).toBe("thinking");
    expect(redactedBlock.redacted).toBe(true);

    // Non-redacted old messages (indices 1-4) should have thinking stripped
    for (let i = 1; i < 5; i++) {
      const msg = result[i] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(1); // only text
      expect(msg.content[0]).toEqual(makeTextBlock(`text-${i}`));
    }
  });

  it("d) counts only assistant messages, not user messages", async () => {
    const layer = createThinkingBlockCleaner(5);
    // Interleaved: 20 total (10 user + 10 assistant)
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUserMsg(`user-${i}`));
      messages.push(
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );
    }

    const result = await layer.apply(messages, stubBudget);

    // 10 assistant messages total. keepTurns=5, so 5 oldest should be stripped.
    // Assistant messages are at indices 1, 3, 5, 7, 9, 11, 13, 15, 17, 19
    // Assistant 0-4 (indices 1,3,5,7,9) = oldest 5 = stripped
    for (let i = 0; i < 5; i++) {
      const msg = result[i * 2 + 1] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(1); // thinking stripped
    }

    // Assistant 5-9 (indices 11,13,15,17,19) = most recent 5 = preserved
    for (let i = 5; i < 10; i++) {
      const msg = result[i * 2 + 1] as { role: string; content: unknown[] };
      expect(msg.content).toHaveLength(2); // thinking + text
    }

    // All user messages pass through unchanged
    for (let i = 0; i < 10; i++) {
      expect(result[i * 2]).toBe(messages[i * 2]); // reference equality
    }
  });

  it("e) empty messages array returns empty array", async () => {
    const layer = createThinkingBlockCleaner(10);
    const result = await layer.apply([], stubBudget);
    expect(result).toEqual([]);
  });

  it("f) all messages within window -- returns same reference", async () => {
    const layer = createThinkingBlockCleaner(10);
    const messages: AgentMessage[] = Array.from({ length: 3 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );

    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages); // reference equality -- nothing to strip
  });

  it("g) messages are not mutated (immutability)", async () => {
    const layer = createThinkingBlockCleaner(2);
    const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
      makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
    );

    // Deep-freeze all messages and their content arrays
    for (const msg of messages) {
      const m = msg as { content: unknown[] };
      Object.freeze(m.content);
      for (const block of m.content) {
        Object.freeze(block);
      }
      Object.freeze(msg);
    }
    Object.freeze(messages);

    // Should NOT throw (confirming no in-place mutation)
    const result = await layer.apply(messages, stubBudget);
    expect(result).not.toBe(messages); // different array since changes were made
    expect(result).toHaveLength(5);

    // Verify originals are untouched (still frozen, still have thinking blocks)
    for (const msg of messages) {
      const m = msg as { content: unknown[] };
      expect(m.content).toHaveLength(2); // still has thinking + text
    }
  });

  it("h) mixed content blocks preserved after stripping", async () => {
    const layer = createThinkingBlockCleaner(0); // strip ALL

    const toolCall = makeToolCallBlock();
    const text = makeTextBlock("hello");
    const thinking = makeThinkingBlock("internal thought");

    const messages: AgentMessage[] = [
      makeAssistantMsg([thinking, text, toolCall]),
    ];

    const result = await layer.apply(messages, stubBudget);
    const msg = result[0] as { role: string; content: unknown[] };

    expect(msg.content).toHaveLength(2); // text + toolCall
    expect(msg.content[0]).toBe(text); // exact same object reference
    expect(msg.content[1]).toBe(toolCall); // exact same object reference
  });

  it("layer name is 'thinking-block-cleaner'", () => {
    const layer = createThinkingBlockCleaner(10);
    expect(layer.name).toBe("thinking-block-cleaner");
  });

  // -------------------------------------------------------------------------
  // idle thinking clear override (getKeepTurnsOverride)
  // -------------------------------------------------------------------------

  describe("idle thinking clear override", () => {
    it("getKeepTurnsOverride returning 0 strips ALL non-redacted thinking blocks", async () => {
      // keepTurns=10 would normally preserve all, but override returns 0
      const layer = createThinkingBlockCleaner(
        10,
        undefined,
        () => 0,
      );

      const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const result = await layer.apply(messages, stubBudget);

      // All 5 assistant messages should have thinking stripped (keepTurns overridden to 0)
      for (let i = 0; i < 5; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1); // only text
        expect(msg.content[0]).toEqual(makeTextBlock(`text-${i}`));
      }
    });

    it("getKeepTurnsOverride returning undefined uses default keepTurns", async () => {
      // keepTurns=10, override returns undefined -> use 10
      const layer = createThinkingBlockCleaner(
        10,
        undefined,
        () => undefined,
      );

      const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const result = await layer.apply(messages, stubBudget);

      // All 5 within keep window of 10 -> same reference returned
      expect(result).toBe(messages);
    });

    it("keepTurns=0 via override still preserves redacted thinking blocks", async () => {
      const layer = createThinkingBlockCleaner(
        10,
        undefined,
        () => 0, // strip all non-redacted
      );

      const messages: AgentMessage[] = [
        makeAssistantMsg([makeRedactedThinkingBlock(), makeTextBlock("text-0")]),
        makeAssistantMsg([makeThinkingBlock("think-1"), makeTextBlock("text-1")]),
      ];

      const result = await layer.apply(messages, stubBudget);

      // First message: redacted thinking preserved
      const msg0 = result[0] as { role: string; content: unknown[] };
      expect(msg0.content).toHaveLength(2); // redacted thinking + text
      const block = msg0.content[0] as { type: string; redacted?: boolean };
      expect(block.redacted).toBe(true);

      // Second message: non-redacted thinking stripped
      const msg1 = result[1] as { role: string; content: unknown[] };
      expect(msg1.content).toHaveLength(1); // only text
    });
  });

  // -------------------------------------------------------------------------
  // cache fence
  // -------------------------------------------------------------------------

  describe("cache fence", () => {
    it("skips stripping thinking blocks from messages at or before fence", async () => {
      const layer = createThinkingBlockCleaner(2); // keepTurns=2
      // 6 assistant messages: indices 0-2 fenced, 3-5 modifiable
      // Only the last 2 are in keep window (indices 4, 5). Index 3 is beyond keep window.
      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 2 };
      const result = await layer.apply(messages, fencedBudget);

      // Messages at indices 0, 1, 2 must retain thinking blocks (fenced)
      for (let i = 0; i <= 2; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2); // thinking + text preserved
      }

      // Message at index 3 is beyond keep window AND beyond fence -> stripped
      const msg3 = result[3] as { role: string; content: unknown[] };
      expect(msg3.content).toHaveLength(1); // only text

      // Messages at indices 4, 5 are in keep window -> preserved
      for (let i = 4; i <= 5; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2); // thinking + text
      }
    });

    it("fence -1 means no protection (all modifiable)", async () => {
      const layer = createThinkingBlockCleaner(2); // keepTurns=2
      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const noFenceBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: -1 };
      const result = await layer.apply(messages, noFenceBudget);

      // All 4 old messages (beyond keep window of 2) should have thinking stripped
      for (let i = 0; i < 4; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1); // only text
      }

      // Last 2 in keep window -> preserved
      for (let i = 4; i <= 5; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2); // thinking + text
      }
    });
  });

  // -------------------------------------------------------------------------
  // assistant count ceiling (cache stabilization)
  // -------------------------------------------------------------------------

  describe("assistant count ceiling", () => {
    it("ceiling caps cutoff -- only messages beyond capped window are stripped", async () => {
      // 6 assistant messages, keepTurns=2. Without ceiling: cutoff = 6-2 = 4 (strip 0-3).
      // With ceiling=4: cutoff = min(6,4)-2 = 2 (strip 0-1 only).
      const layer = createThinkingBlockCleaner(2);
      (layer as { setAssistantCountCeiling: (n: number | undefined) => void }).setAssistantCountCeiling(4);

      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const result = await layer.apply(messages, stubBudget);

      // Messages 0-1 should have thinking stripped (cutoff=2)
      for (let i = 0; i < 2; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1); // only text
      }

      // Messages 2-5 should retain thinking (within effective keep window)
      for (let i = 2; i < 6; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2); // thinking + text
      }
    });

    it("ceiling prevents new-turn shift -- cutoff stays stable after adding messages", async () => {
      // Start with ceiling=4, keepTurns=2. Call apply with 4 messages (cutoff = min(4,4)-2 = 2).
      // Add 4 more messages (total 8). Cutoff should remain 2 (min(8,4)-2 = 2), not shift to 6.
      const layer = createThinkingBlockCleaner(2);
      (layer as { setAssistantCountCeiling: (n: number | undefined) => void }).setAssistantCountCeiling(4);

      // First call with 4 assistant messages
      const messages4: AgentMessage[] = Array.from({ length: 4 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );
      const result4 = await layer.apply(messages4, stubBudget);

      // Cutoff = min(4,4)-2 = 2, so messages 0-1 stripped
      for (let i = 0; i < 2; i++) {
        const msg = result4[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }
      for (let i = 2; i < 4; i++) {
        const msg = result4[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2);
      }

      // Second call with 8 assistant messages (same ceiling=4)
      const messages8: AgentMessage[] = Array.from({ length: 8 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );
      const result8 = await layer.apply(messages8, stubBudget);

      // Cutoff should still be 2 (min(8,4)-2 = 2), NOT 6 (8-2)
      for (let i = 0; i < 2; i++) {
        const msg = result8[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }
      for (let i = 2; i < 8; i++) {
        const msg = result8[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2);
      }
    });

    it("ceiling undefined = original behavior -- raw assistant count used", async () => {
      // 6 assistant messages, keepTurns=2, ceiling=undefined.
      // Cutoff = 6-2 = 4 (original behavior, strip messages 0-3).
      const layer = createThinkingBlockCleaner(2);
      // Do NOT set ceiling -- leave as undefined (default)

      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const result = await layer.apply(messages, stubBudget);

      // Messages 0-3 stripped (cutoff=4)
      for (let i = 0; i < 4; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }

      // Messages 4-5 preserved (within keep window)
      for (let i = 4; i < 6; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2);
      }
    });

    it("clearing ceiling restores original behavior", async () => {
      // Set ceiling=4 first, then clear (set undefined). With 6 messages, keepTurns=2:
      // After clearing: cutoff = 6-2 = 4 (original behavior).
      const layer = createThinkingBlockCleaner(2);
      const ceilingLayer = layer as { setAssistantCountCeiling: (n: number | undefined) => void };

      ceilingLayer.setAssistantCountCeiling(4);

      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      // With ceiling=4: cutoff = min(6,4)-2 = 2 (strip 0-1)
      const resultCeiled = await layer.apply(messages, stubBudget);
      for (let i = 0; i < 2; i++) {
        const msg = resultCeiled[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }
      for (let i = 2; i < 6; i++) {
        const msg = resultCeiled[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2);
      }

      // Clear ceiling -- restore original behavior
      ceilingLayer.setAssistantCountCeiling(undefined);

      const resultCleared = await layer.apply(messages, stubBudget);
      // Now cutoff = 6-2 = 4 (strip 0-3)
      for (let i = 0; i < 4; i++) {
        const msg = resultCleared[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }
      for (let i = 4; i < 6; i++) {
        const msg = resultCleared[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2);
      }
    });

    it("onCleaned includes cache fence stats when blocks removed with fence active", async () => {
      const onCleaned = vi.fn();
      const layer = createThinkingBlockCleaner(2, onCleaned);
      // 6 assistant messages, keepTurns=2, fence at index 2
      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 2 };
      await layer.apply(messages, fencedBudget);

      expect(onCleaned).toHaveBeenCalledTimes(1);
      const stats = onCleaned.mock.calls[0]![0];
      // Message index 3 is beyond fence and beyond keep window -- should be stripped
      expect(stats.blocksRemoved).toBeGreaterThan(0);
      expect(stats.cacheFenceIndex).toBe(2);
      expect(stats.messagesProtected).toBe(3);
      expect(stats.totalMessages).toBe(6);
    });

    it("onCleaned omits cache fence stats when fence is -1", async () => {
      const onCleaned = vi.fn();
      const layer = createThinkingBlockCleaner(2, onCleaned);
      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const noFenceBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: -1 };
      await layer.apply(messages, noFenceBudget);

      expect(onCleaned).toHaveBeenCalledTimes(1);
      const stats = onCleaned.mock.calls[0]![0];
      expect(stats.blocksRemoved).toBeGreaterThan(0);
      // No fence data when cacheFenceIndex is -1
      expect(stats.cacheFenceIndex).toBeUndefined();
      expect(stats.messagesProtected).toBeUndefined();
    });

    it("onCleaned omits cache fence stats when no blocks removed", async () => {
      const onCleaned = vi.fn();
      // keepTurns=10 with only 5 messages -- all within window, no stripping
      const layer = createThinkingBlockCleaner(10, onCleaned);
      const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 2 };
      const result = await layer.apply(messages, fencedBudget);

      // All within keep-window, no changes, same reference returned
      expect(result).toBe(messages);
      // onCleaned not called when no changes made
      expect(onCleaned).not.toHaveBeenCalled();
    });

    it("ceiling >= actual count = no effect on behavior", async () => {
      // 6 assistant messages, keepTurns=2, ceiling=10. min(6,10) = 6.
      // Cutoff = 6-2 = 4, same as without ceiling.
      const layer = createThinkingBlockCleaner(2);
      (layer as { setAssistantCountCeiling: (n: number | undefined) => void }).setAssistantCountCeiling(10);

      const messages: AgentMessage[] = Array.from({ length: 6 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const result = await layer.apply(messages, stubBudget);

      // Same as original behavior: cutoff = 4 (strip 0-3)
      for (let i = 0; i < 4; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }
      for (let i = 4; i < 6; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(2);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Persistence: strip thinkingSignature from fileEntries
  // -------------------------------------------------------------------------

  describe("persistence to fileEntries", () => {
    // Helpers for building fileEntry-style objects
    function makeFileThinkingBlock(text: string, signature?: string) {
      return { type: "thinking" as const, thinking: text, ...(signature && { thinkingSignature: signature }) };
    }

    function makeFileRedactedThinkingBlock(signature: string) {
      return { type: "thinking" as const, thinking: "", redacted: true as const, thinkingSignature: signature };
    }

    function makeFileEntry(role: string, content: unknown[]) {
      return { type: "message", message: { role, content } };
    }

    it("strips thinkingSignature from fileEntries beyond keep-window", async () => {
      const rewriteFn = vi.fn();
      // 5 assistant messages interleaved with user messages
      // fileEntries mirror the same structure
      const fileEntries = [];
      const messages: AgentMessage[] = [];
      for (let i = 0; i < 5; i++) {
        const userContent = [{ type: "text", text: `user-${i}` }];
        const assistantContent = [
          makeFileThinkingBlock(`think-${i}`, `sig-payload-${i}`),
          { type: "text", text: `reply-${i}` },
        ];
        fileEntries.push(makeFileEntry("user", userContent));
        fileEntries.push(makeFileEntry("assistant", [...assistantContent.map(b => ({ ...b }))]));

        messages.push(makeUserMsg(`user-${i}`));
        messages.push(makeAssistantMsg([
          makeThinkingBlock(`think-${i}`),
          makeTextBlock(`reply-${i}`),
        ]));
      }

      const mockSessionManager = { fileEntries, _rewriteFile: rewriteFn };
      const layer = createThinkingBlockCleaner(
        2,
        undefined,
        undefined,
        () => mockSessionManager,
      );

      await layer.apply(messages, stubBudget);

      // 5 assistant messages, keepTurns=2, cutoff=3. Assistants 0-2 are stripped.
      // fileEntries assistant indices 0-2 (at positions 1, 3, 5) should have thinkingSignature deleted
      for (let i = 0; i < 3; i++) {
        const entry = fileEntries[i * 2 + 1]!;
        const thinkingBlock = (entry as any).message.content[0];
        expect(thinkingBlock.thinkingSignature).toBeUndefined();
        // cleartext thinking text is preserved
        expect(thinkingBlock.thinking).toBe(`think-${i}`);
      }

      // fileEntries assistant indices 3-4 (at positions 7, 9) should be untouched
      for (let i = 3; i < 5; i++) {
        const entry = fileEntries[i * 2 + 1]!;
        const thinkingBlock = (entry as any).message.content[0];
        expect(thinkingBlock.thinkingSignature).toBe(`sig-payload-${i}`);
      }

      // _rewriteFile called exactly once
      expect(rewriteFn).toHaveBeenCalledTimes(1);
    });

    it("preserves thinkingSignature for redacted blocks in fileEntries", async () => {
      const rewriteFn = vi.fn();
      const fileEntries = [
        makeFileEntry("user", [{ type: "text", text: "hi" }]),
        makeFileEntry("assistant", [makeFileRedactedThinkingBlock("redacted-sig-0"), { type: "text", text: "reply-0" }]),
        makeFileEntry("user", [{ type: "text", text: "hello" }]),
        makeFileEntry("assistant", [makeFileThinkingBlock("think-1", "sig-1"), { type: "text", text: "reply-1" }]),
        makeFileEntry("user", [{ type: "text", text: "yo" }]),
        makeFileEntry("assistant", [makeFileThinkingBlock("think-2", "sig-2"), { type: "text", text: "reply-2" }]),
      ];

      const messages: AgentMessage[] = [
        makeUserMsg("hi"),
        makeAssistantMsg([makeRedactedThinkingBlock(), makeTextBlock("reply-0")]),
        makeUserMsg("hello"),
        makeAssistantMsg([makeThinkingBlock("think-1"), makeTextBlock("reply-1")]),
        makeUserMsg("yo"),
        makeAssistantMsg([makeThinkingBlock("think-2"), makeTextBlock("reply-2")]),
      ];

      const mockSessionManager = { fileEntries, _rewriteFile: rewriteFn };
      const layer = createThinkingBlockCleaner(
        1,  // keepTurns=1, so assistants 0 and 1 are beyond keep-window
        undefined,
        undefined,
        () => mockSessionManager,
      );

      await layer.apply(messages, stubBudget);

      // Assistant 0 (redacted): thinkingSignature must be preserved
      const block0 = (fileEntries[1] as any).message.content[0];
      expect(block0.thinkingSignature).toBe("redacted-sig-0");
      expect(block0.redacted).toBe(true);

      // Assistant 1 (non-redacted, beyond keep-window): thinkingSignature stripped
      const block1 = (fileEntries[3] as any).message.content[0];
      expect(block1.thinkingSignature).toBeUndefined();
      expect(block1.thinking).toBe("think-1");

      // Assistant 2 (within keep-window): untouched
      const block2 = (fileEntries[5] as any).message.content[0];
      expect(block2.thinkingSignature).toBe("sig-2");
    });

    it("does not call _rewriteFile when all messages are within keep-window", async () => {
      const rewriteFn = vi.fn();
      const fileEntries = [
        makeFileEntry("user", [{ type: "text", text: "hi" }]),
        makeFileEntry("assistant", [makeFileThinkingBlock("think-0", "sig-0"), { type: "text", text: "reply-0" }]),
      ];

      const messages: AgentMessage[] = [
        makeUserMsg("hi"),
        makeAssistantMsg([makeThinkingBlock("think-0"), makeTextBlock("reply-0")]),
      ];

      const mockSessionManager = { fileEntries, _rewriteFile: rewriteFn };
      const layer = createThinkingBlockCleaner(
        10,  // keepTurns=10, 1 assistant is well within window
        undefined,
        undefined,
        () => mockSessionManager,
      );

      await layer.apply(messages, stubBudget);

      // No stripping happened, _rewriteFile must NOT be called
      expect(rewriteFn).not.toHaveBeenCalled();
    });

    it("no errors when getSessionManager is not provided", async () => {
      const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      // No 4th argument -- should work without errors
      const layer = createThinkingBlockCleaner(2);

      const result = await layer.apply(messages, stubBudget);
      // Should still strip in-memory blocks (3 beyond keep-window)
      for (let i = 0; i < 3; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1); // only text
      }
    });

    it("no errors when getSessionManager returns undefined", async () => {
      const messages: AgentMessage[] = Array.from({ length: 5 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`text-${i}`)]),
      );

      const layer = createThinkingBlockCleaner(
        2,
        undefined,
        undefined,
        () => undefined,  // returns undefined
      );

      const result = await layer.apply(messages, stubBudget);
      for (let i = 0; i < 3; i++) {
        const msg = result[i] as { role: string; content: unknown[] };
        expect(msg.content).toHaveLength(1);
      }
    });

    it("respects cache fence -- fenced fileEntries are not modified", async () => {
      const rewriteFn = vi.fn();
      // 4 assistant messages (no user interleave for simplicity)
      // keepTurns=1 -> cutoff=3 (assistants 0-2 beyond window)
      // cacheFenceIndex=1 -> messages at indices 0 and 1 are fenced
      const fileEntries = Array.from({ length: 4 }, (_, i) =>
        makeFileEntry("assistant", [makeFileThinkingBlock(`think-${i}`, `sig-${i}`), { type: "text", text: `reply-${i}` }]),
      );

      const messages: AgentMessage[] = Array.from({ length: 4 }, (_, i) =>
        makeAssistantMsg([makeThinkingBlock(`think-${i}`), makeTextBlock(`reply-${i}`)]),
      );

      const mockSessionManager = { fileEntries, _rewriteFile: rewriteFn };
      const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 1 };
      const layer = createThinkingBlockCleaner(
        1,
        undefined,
        undefined,
        () => mockSessionManager,
      );

      await layer.apply(messages, fencedBudget);

      // Assistants 0, 1 are fenced -- thinkingSignature preserved in fileEntries
      expect((fileEntries[0] as any).message.content[0].thinkingSignature).toBe("sig-0");
      expect((fileEntries[1] as any).message.content[0].thinkingSignature).toBe("sig-1");

      // Assistant 2 is beyond keep-window AND beyond fence -> stripped
      expect((fileEntries[2] as any).message.content[0].thinkingSignature).toBeUndefined();
      expect((fileEntries[2] as any).message.content[0].thinking).toBe("think-2");

      // Assistant 3 is within keep-window -> untouched
      expect((fileEntries[3] as any).message.content[0].thinkingSignature).toBe("sig-3");

      expect(rewriteFn).toHaveBeenCalledTimes(1);
    });

    it("preserves thinking cleartext after stripping thinkingSignature", async () => {
      const rewriteFn = vi.fn();
      const fileEntries = [
        makeFileEntry("assistant", [
          makeFileThinkingBlock("my important reasoning here", "sig-large-payload"),
          { type: "text", text: "response" },
        ]),
        makeFileEntry("assistant", [
          makeFileThinkingBlock("recent thought", "sig-recent"),
          { type: "text", text: "reply" },
        ]),
      ];

      const messages: AgentMessage[] = [
        makeAssistantMsg([makeThinkingBlock("my important reasoning here"), makeTextBlock("response")]),
        makeAssistantMsg([makeThinkingBlock("recent thought"), makeTextBlock("reply")]),
      ];

      const mockSessionManager = { fileEntries, _rewriteFile: rewriteFn };
      const layer = createThinkingBlockCleaner(
        1,  // keepTurns=1, assistant 0 is beyond window
        undefined,
        undefined,
        () => mockSessionManager,
      );

      await layer.apply(messages, stubBudget);

      const block = (fileEntries[0] as any).message.content[0];
      expect(block.thinking).toBe("my important reasoning here");
      expect(block.thinkingSignature).toBeUndefined();
      expect(block.type).toBe("thinking");
    });
  });
});
