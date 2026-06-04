// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD leaf summarization unit (Plan 129-03, C1).
 *
 * RED-first. Drives the two C1 obligations:
 *  1. `selectLeafChunk` picks the OLDEST contiguous chunk OUTSIDE the fresh tail,
 *     capped at `leafChunkTokens`, extended forward to a STEP boundary (never
 *     ending on an assistant `tool_use` without its trailing `toolResult`s).
 *  2. `summarizeLeafChunk` runs the mandatory 3-level escalation
 *     (normal → aggressive → deterministic truncation) that ALWAYS reduces
 *     tokens or falls back deterministically — the binding C1 invariant.
 *
 * The summarizer is INJECTED as ONE function (no network, no real LLM — Pitfall 6;
 * Phase 132 swaps it for the spend-governed `generateSummary` wrapper). Three
 * stubs exercise the ladder deterministically:
 *  - a SHORT-returning stub (Level-1 success),
 *  - an OVERSIZED-returning stub (output ≥ chunk → forces escalation → Level 3),
 *  - a THROWING stub (non-fatal fall-through → Level 3).
 *
 * The headline assertion across ALL three stubs: the returned summary's token
 * count is STRICTLY LESS than the chunk's token count (the "always reduces or
 * falls back" invariant), and the deterministic Level-3 output carries the
 * marker + is bounded by LEAF_FALLBACK_TARGET_TOKENS.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, it, expect, vi } from "vitest";
import {
  selectLeafChunk,
  summarizeLeafChunk,
  type LeafChunkItem,
  type LeafSummarizer,
  type LeafSummarizerDeps,
} from "./lcd-leaf-summarizer.js";
import {
  LEAF_FALLBACK_SUMMARY_MARKER,
  LEAF_FALLBACK_TARGET_TOKENS,
  COMPACTION_MAX_RETRIES,
} from "./constants.js";
import { estimateMessageTokens } from "../safety/token-estimator.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures (mirror lcd-assembler.test.ts)
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: 1000 } as Message;
}

function assistantText(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "stop",
    timestamp: 1000,
  } as unknown as Message;
}

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "anthropic.messages",
    provider: "anthropic",
    model: "claude-test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "toolUse",
    timestamp: 1000,
  } as unknown as Message;
}

function toolResult(id: string, name: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1000,
  } as unknown as Message;
}

/** Build a chunk item carrying its per-message token count + createdAt + id. */
function item(id: string, msg: Message, tokens: number, createdAt: number): LeafChunkItem {
  return { id, msg: msg as unknown as AgentMessage, tokens, createdAt };
}

/** A simple synthetic history of N user/assistant text turns (each ~tokens each). */
function textHistory(count: number, tokensEach: number, startAt = 100): LeafChunkItem[] {
  const items: LeafChunkItem[] = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? userMsg(`u${i}`) : assistantText(`a${i}`);
    items.push(item(`m${i}`, role, tokensEach, startAt + i));
  }
  return items;
}

// --- Injected summarizer stubs (NO network, NO real LLM) ---

/** Level-1 success: returns a fixed SHORT string regardless of input. */
function shortSummarizer(text = "SHORT-LEAF-SUMMARY"): LeafSummarizer {
  return vi.fn(async () => text);
}

/** Forces escalation: returns a string FAR LARGER than any realistic chunk. */
function oversizedSummarizer(): LeafSummarizer {
  return vi.fn(async () => "X".repeat(500_000));
}

/** Non-fatal: throws on every call (Levels 1+2 both fail). */
function throwingSummarizer(): LeafSummarizer {
  return vi.fn(async () => {
    throw new Error("summarizer boom");
  });
}

function makeDeps(summarize: LeafSummarizer): {
  deps: LeafSummarizerDeps;
  logger: ReturnType<typeof createMockLogger>;
} {
  const logger = createMockLogger();
  const deps: LeafSummarizerDeps = {
    logger: logger as unknown as LeafSummarizerDeps["logger"],
    summarize,
    getModel: () => ({ provider: "anthropic", contextWindow: 200_000, reasoning: true }),
    getApiKey: async () => "test-key",
  };
  return { deps, logger };
}

/** Sum the per-item tokens for a selected chunk. */
function chunkTokens(items: LeafChunkItem[]): number {
  return items.reduce((acc, it) => acc + it.tokens, 0);
}

/** Token count of a leaf summary string as a plain user-role message. */
function summaryTokens(content: string): number {
  return estimateMessageTokens({ role: "user", content } as Message);
}

// ===========================================================================
// selectLeafChunk — chunk selection
// ===========================================================================

describe("selectLeafChunk picks the oldest out-of-tail chunk capped + pair-safe", () => {
  it("selects the oldest contiguous prefix outside the fresh tail capped at leafChunkTokens", () => {
    // 10 text turns @ 100 tokens; fresh tail keeps the last 2 STEPS (assistants).
    const history = textHistory(10, 100);
    const chunk = selectLeafChunk(history, /*freshTailSteps*/ 2, /*leafChunkTokens*/ 350);
    expect(chunk).toBeDefined();
    // Cap 350 @ 100/msg => at most 3 messages, all from the OLDEST end.
    expect(chunk!.startIndex).toBe(0);
    expect(chunk!.tokens).toBeLessThanOrEqual(350);
    expect(chunk!.messages.length).toBeGreaterThanOrEqual(1);
    expect(chunk!.messages.length).toBeLessThanOrEqual(3);
    // descendantCount = number of covered messages; ids cover the chunk.
    expect(chunk!.descendantCount).toBe(chunk!.messages.length);
    expect(chunk!.messageIds.length).toBe(chunk!.messages.length);
    // earliest/latest createdAt = min/max over the chunk.
    expect(chunk!.earliestAt).toBe(history[0]!.createdAt);
    expect(chunk!.latestAt).toBe(history[chunk!.endIndex - 1]!.createdAt);
  });

  it("never ends the chunk mid tool-pair — extends past an assistant tool_use to its toolResults", () => {
    // Layout (createdAt ascending): u0, a1(text), assistantToolCall@idx2, toolResult@idx3, toolResult@idx4, then 4 more turns.
    const history: LeafChunkItem[] = [
      item("m0", userMsg("u0"), 100, 100),
      item("m1", assistantText("a1"), 100, 101),
      item("m2", assistantToolCall("t1", "read", { p: "f" }), 100, 102),
      item("m3", toolResult("t1", "read", "r1"), 100, 103),
      item("m4", toolResult("t1", "read", "r2"), 100, 104),
      item("m5", userMsg("u5"), 100, 105),
      item("m6", assistantText("a6"), 100, 106),
      item("m7", userMsg("u7"), 100, 107),
      item("m8", assistantText("a8"), 100, 108),
    ];
    // Cap 300 would naturally stop at index 3 (u0,a1,toolCall) — mid-pair (toolResults at 3,4 orphaned).
    // The pass MUST extend forward past the assistant tool_use to include both toolResults.
    const chunk = selectLeafChunk(history, /*freshTailSteps*/ 2, /*leafChunkTokens*/ 300);
    expect(chunk).toBeDefined();
    // The last included message must NOT be an assistant carrying a tool_use without its results:
    // boundary extends to index 5 (exclusive) so toolResults at 3 and 4 are included.
    expect(chunk!.endIndex).toBeGreaterThanOrEqual(5);
    const last = chunk!.messages[chunk!.messages.length - 1]! as unknown as { role: string };
    expect(last.role).toBe("toolResult");
  });

  it("returns undefined when no evictable history exists outside the fresh tail (no-op)", () => {
    // Only 2 assistant steps total, fresh tail keeps 8 steps => nothing is out-of-tail.
    const history = textHistory(4, 100);
    const chunk = selectLeafChunk(history, /*freshTailSteps*/ 8, /*leafChunkTokens*/ 10_000);
    expect(chunk).toBeUndefined();
  });

  it("returns undefined for an empty history", () => {
    expect(selectLeafChunk([], 8, 20_000)).toBeUndefined();
  });

  it("does not treat an assistant with non-array (string) content as a tool_use at the boundary", () => {
    // An assistant whose content is a bare string (no tool_use blocks) sits at the
    // chunk boundary — the pair-safety walk must NOT try to pull trailing results.
    const stringAssistant = { role: "assistant", content: "plain text reply", timestamp: 1000 } as unknown as Message;
    const history: LeafChunkItem[] = [
      item("m0", userMsg("u0"), 100, 100),
      item("m1", stringAssistant, 100, 101),
      item("m2", userMsg("u2"), 100, 102),
      item("m3", assistantText("a3"), 100, 103),
      item("m4", userMsg("u4"), 100, 104),
      item("m5", assistantText("a5"), 100, 105),
    ];
    // Cap 200 stops after 2 messages (u0 + the string assistant). The string
    // assistant has no tool_use, so the boundary stays at index 2 (no extension).
    const chunk = selectLeafChunk(history, /*freshTailSteps*/ 2, /*leafChunkTokens*/ 200);
    expect(chunk).toBeDefined();
    expect(chunk!.endIndex).toBe(2);
  });
});

// ===========================================================================
// summarizeLeafChunk — the 3-level escalation invariant
// ===========================================================================

describe("summarizeLeafChunk always reduces tokens or falls back deterministically", () => {
  // A representative chunk: 5 text messages @ 200 tokens = 1000 chunk tokens.
  const chunkItems = textHistory(5, 200);
  const totalChunkTokens = chunkTokens(chunkItems);

  it("Level-1 success: a SHORT summary is accepted at level 1, fallback false, and reduces tokens", async () => {
    const summarize = shortSummarizer();
    const { deps } = makeDeps(summarize);
    const result = await summarizeLeafChunk(chunkItems, deps, {
      reserveTokens: 1_200,
    });
    expect(result.level).toBe(1);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe("SHORT-LEAF-SUMMARY");
    // The headline invariant: the summary is strictly smaller than the chunk.
    expect(summaryTokens(result.content)).toBeLessThan(totalChunkTokens);
    // descendantCount + time-range + ids reflect the chunk.
    expect(result.descendantCount).toBe(chunkItems.length);
    expect(result.earliestAt).toBe(chunkItems[0]!.createdAt);
    expect(result.latestAt).toBe(chunkItems[chunkItems.length - 1]!.createdAt);
    expect(result.messageIds).toEqual(chunkItems.map((c) => c.id));
    // Exactly one summarizer call (no needless escalation).
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("escalates when the Level-1 summary is NOT smaller than the chunk (oversized stub → Level 3 floor)", async () => {
    const summarize = oversizedSummarizer();
    const { deps } = makeDeps(summarize);
    const result = await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
    // It must NOT accept the oversized output at Level 1 or 2; it lands on the deterministic floor.
    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER)).toBe(true);
    // Bounded by the fallback target AND strictly smaller than the chunk.
    expect(summaryTokens(result.content)).toBeLessThanOrEqual(LEAF_FALLBACK_TARGET_TOKENS);
    expect(summaryTokens(result.content)).toBeLessThan(totalChunkTokens);
  });

  it("is non-fatal: a THROWING summarizer falls through to the deterministic Level 3 (never throws out)", async () => {
    const summarize = throwingSummarizer();
    const { deps } = makeDeps(summarize);
    const result = await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER)).toBe(true);
    expect(summaryTokens(result.content)).toBeLessThan(totalChunkTokens);
  });

  it("INVARIANT: across short, oversized, and throwing stubs the result always shrinks the chunk", async () => {
    for (const make of [shortSummarizer, oversizedSummarizer, throwingSummarizer]) {
      const { deps } = makeDeps(make());
      const result = await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
      expect(summaryTokens(result.content)).toBeLessThan(totalChunkTokens);
    }
  });

  it("forwards previousSummary to the injected summarizer for continuity (Pattern 2)", async () => {
    const summarize = shortSummarizer();
    const { deps } = makeDeps(summarize);
    await summarizeLeafChunk(chunkItems, deps, {
      reserveTokens: 1_200,
      previousSummary: "PRIOR-LEAF",
    });
    // The summarizer receives the prior summary (8th generateSummary param, surfaced on opts).
    const call = (summarize as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const opts = call[1] as { previousSummary?: string };
    expect(opts.previousSummary).toBe("PRIOR-LEAF");
  });

  it("bounds the ladder: an oversized stub is called a FINITE number of times (no infinite retry)", async () => {
    const summarize = oversizedSummarizer();
    const { deps } = makeDeps(summarize);
    await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
    // Level 1 = up to (1 + COMPACTION_MAX_RETRIES) attempts, Level 2 = 1 attempt.
    const maxCalls = 1 + COMPACTION_MAX_RETRIES + 1;
    expect((summarize as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(maxCalls);
    expect((summarize as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not log the summary content or chunk message bodies (ids/counts/level only)", async () => {
    const summarize = shortSummarizer("SECRET-SUMMARY-BODY");
    const { deps, logger } = makeDeps(summarize);
    await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
    const serialized = JSON.stringify(
      (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .concat((logger.debug as ReturnType<typeof vi.fn>).mock.calls)
        .concat((logger.warn as ReturnType<typeof vi.fn>).mock.calls),
    );
    expect(serialized).not.toContain("SECRET-SUMMARY-BODY");
  });

  it("accepts a Level-2 (aggressive) summary when filtering oversized messages enables reduction", async () => {
    // One genuinely oversized message (> OVERSIZED_MESSAGE_CHARS_THRESHOLD = 50_000 chars)
    // plus four normal ones. The stub returns an OVERSIZED string while the huge
    // message is present (Level 1 fails to reduce), but a SHORT string once the
    // Level-2 filter has dropped it — so the pass accepts at Level 2.
    const huge = item("big", userMsg("Z".repeat(60_000)), 20_000, 100);
    const normal = textHistory(4, 100, 101);
    const withOversized = [huge, ...normal];
    const before = chunkTokens(withOversized);
    // Size-aware stub: reduces only when the oversized message has been filtered out.
    const summarize: LeafSummarizer = vi.fn(async (messages) => {
      const hasHuge = messages.some(
        (m) => JSON.stringify((m as unknown as { content?: unknown }).content ?? "").length > 50_000,
      );
      return hasHuge ? "X".repeat(500_000) : "SHORT-L2";
    });
    const { deps } = makeDeps(summarize);
    const result = await summarizeLeafChunk(withOversized, deps, { reserveTokens: 1_200 });
    expect(result.level).toBe(2);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe("SHORT-L2");
    expect(summaryTokens(result.content)).toBeLessThan(before);
    // descendantCount still reflects the WHOLE chunk (the leaf covers every message),
    // even though Level 2 summarized only the filtered subset.
    expect(result.descendantCount).toBe(withOversized.length);
  });
});
