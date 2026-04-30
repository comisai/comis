// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the signature-surrogate-guard context engine layer.
 *
 * Verifies surrogate detection (lone high, lone low, valid pair),
 * signature stripping behavior, redacted-block skipping, missing-signature
 * skipping, immutability, and that cacheFenceIndex is IGNORED
 * (260430-anthropic-400-thinking-block).
 */

import { describe, it, expect, vi } from "vitest";
import { createSignatureSurrogateGuard } from "./signature-surrogate-guard.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeThinkingBlock(text: string, signature?: string) {
  return {
    type: "thinking" as const,
    thinking: text,
    ...(signature !== undefined ? { thinkingSignature: signature } : {}),
  };
}
function makeRedactedThinkingBlock(signature: string) {
  return {
    type: "thinking" as const,
    thinking: "",
    redacted: true,
    thinkingSignature: signature,
  };
}
function makeTextBlock(text: string) {
  return { type: "text" as const, text };
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

// Bare lone high surrogate (U+D83D) without following low surrogate.
const TAINTED_TEXT_HIGH = "hello \uD83D world";
// Bare lone low surrogate (U+DC00) without preceding high surrogate.
const TAINTED_TEXT_LOW = "hello \uDC00 world";
// Valid surrogate pair forming "😀" (U+1F600 = U+D83D + U+DE00).
const VALID_PAIR_TEXT = "valid pair: 😀";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSignatureSurrogateGuard", () => {
  it("layer name is 'signature-surrogate-guard'", () => {
    const layer = createSignatureSurrogateGuard();
    expect(layer.name).toBe("signature-surrogate-guard");
  });

  // -------------------------------------------------------------------------
  // No-op cases
  // -------------------------------------------------------------------------

  it("empty messages array returns same reference", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  it("user-only history returns same reference, no scrub", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [makeUserMsg("u1"), makeUserMsg("u2")];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  it("plain ASCII thinking text + signature: no scrub, returns same reference", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        makeThinkingBlock("plain ascii reasoning", "sig-A"),
        makeTextBlock("answer"),
      ]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  it("valid surrogate pair (no taint) + signature: no scrub", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        makeThinkingBlock(VALID_PAIR_TEXT, "sig-V"),
        makeTextBlock("answer"),
      ]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  // -------------------------------------------------------------------------
  // Scrub fires
  // -------------------------------------------------------------------------

  it("lone high surrogate + signature: signature stripped to '', text untouched", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-tainted"),
        makeTextBlock("answer"),
      ]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).not.toBe(messages);
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content).toHaveLength(2);
    // Thinking block: signature stripped to "", thinking text preserved.
    expect(m0.content[0]).toMatchObject({
      type: "thinking",
      thinking: TAINTED_TEXT_HIGH,
      thinkingSignature: "",
    });
    // Text block untouched
    expect(m0.content[1]).toEqual(makeTextBlock("answer"));
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 1 });
  });

  it("lone low surrogate + signature: signature stripped to ''", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_LOW, "sig-low")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "",
    });
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 1 });
  });

  // -------------------------------------------------------------------------
  // Redacted blocks: never scrubbed
  // -------------------------------------------------------------------------

  it("redacted: true thinking block is never scrubbed", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    // Even though `thinking: ""` is benign, this test asserts the redacted
    // skip path explicitly so a future refactor doesn't accidentally start
    // scrubbing redacted signatures (which would break API continuity).
    const block = makeRedactedThinkingBlock("sig-redacted");
    const messages: AgentMessage[] = [makeAssistantMsg([block])];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  // -------------------------------------------------------------------------
  // Missing or empty signature: nothing to strip
  // -------------------------------------------------------------------------

  it("tainted text but empty thinkingSignature: no scrub", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([
        { type: "thinking", thinking: TAINTED_TEXT_HIGH, thinkingSignature: "" },
      ]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  it("tainted text but undefined thinkingSignature: no scrub", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([{ type: "thinking", thinking: TAINTED_TEXT_HIGH }]),
    ];
    const result = await layer.apply(messages, stubBudget);
    expect(result).toBe(messages);
    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 0 });
  });

  // -------------------------------------------------------------------------
  // Cache fence is IGNORED (260430-anthropic-400-thinking-block)
  //
  // The guard must scrub uniformly across the array, regardless of
  // budget.cacheFenceIndex. Stripping is pure/deterministic so the same
  // input produces the same scrubbed output every time, which is what
  // Anthropic's prompt-cache validator requires.
  // -------------------------------------------------------------------------

  it("260430-anthropic-400-thinking-block: cacheFenceIndex is ignored — fence-protected tainted blocks are still scrubbed", async () => {
    const onGuarded = vi.fn();
    const layer = createSignatureSurrogateGuard({ onGuarded });
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-0")]), // index 0 — would-be fenced
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-1")]), // index 1 — would-be fenced
      makeAssistantMsg([makeThinkingBlock("plain", "sig-2")]),           // index 2 — modifiable, no taint
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-3")]), // index 3 — modifiable, tainted
    ];
    const fencedBudget: TokenBudget = { ...stubBudget, cacheFenceIndex: 1 };
    const result = await layer.apply(messages, fencedBudget);

    // ALL 3 tainted thinking blocks (indices 0, 1, 3) get their signatures
    // stripped — the fence is no longer a gate. Verifies the fix for the
    // "blocks cannot be modified" 400 error class.
    expect(result).not.toBe(messages);
    for (const idx of [0, 1, 3]) {
      const m = result[idx] as { content: Array<Record<string, unknown>> };
      expect(m.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "" });
    }
    // Plain text at index 2: no taint → no scrub → same reference preserved.
    expect(result[2]).toBe(messages[2]);

    expect(onGuarded).toHaveBeenCalledWith({ signaturesStripped: 3 });
  });

  it("260430-anthropic-400-thinking-block: deterministic across cacheFenceIndex variations", async () => {
    // Pin the prefix-stability invariant: the bug was that fence=-1 produced
    // one prefix and fence>0 produced a different prefix for the SAME on-disk
    // messages. The fix makes the output independent of cacheFenceIndex.
    const layer = createSignatureSurrogateGuard();

    const buildMessages = (): AgentMessage[] => [
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-0")]),
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_LOW, "sig-1")]),
      makeAssistantMsg([makeThinkingBlock("plain", "sig-2")]),
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-3")]),
    ];

    const resultFenceMinus1 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: -1 });
    const resultFence0 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 0 });
    const resultFence2 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 2 });
    const resultFence3 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 3 });
    const resultFence99 = await layer.apply(buildMessages(), { ...stubBudget, cacheFenceIndex: 99 });

    const ref = JSON.stringify(resultFenceMinus1);
    expect(JSON.stringify(resultFence0)).toBe(ref);
    expect(JSON.stringify(resultFence2)).toBe(ref);
    expect(JSON.stringify(resultFence3)).toBe(ref);
    expect(JSON.stringify(resultFence99)).toBe(ref);
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it("does not mutate the original block when scrubbing fires", async () => {
    const layer = createSignatureSurrogateGuard();
    const taintedBlock = makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-orig");
    const messages: AgentMessage[] = [makeAssistantMsg([taintedBlock])];

    // Deep-freeze the original input so mutation would throw
    Object.freeze(taintedBlock);
    Object.freeze((messages[0] as { content: unknown[] }).content);
    Object.freeze(messages[0]);
    Object.freeze(messages);

    const result = await layer.apply(messages, stubBudget);
    expect(result).not.toBe(messages);
    // Original block still has its sig
    expect(taintedBlock.thinkingSignature).toBe("sig-orig");
    // Result has the stripped sig
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content[0]).toMatchObject({ thinkingSignature: "" });
  });

  // -------------------------------------------------------------------------
  // No deps argument
  // -------------------------------------------------------------------------

  it("works without deps argument (no callback registered)", async () => {
    const layer = createSignatureSurrogateGuard();
    const messages: AgentMessage[] = [
      makeAssistantMsg([makeThinkingBlock(TAINTED_TEXT_HIGH, "sig-X")]),
    ];
    const result = await layer.apply(messages, stubBudget);
    const m0 = result[0] as { content: Array<Record<string, unknown>> };
    expect(m0.content[0]).toMatchObject({ thinkingSignature: "" });
  });
});
