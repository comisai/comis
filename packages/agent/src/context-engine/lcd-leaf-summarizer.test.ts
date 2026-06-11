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

// B-5 (260605-m82): mock the SDK generateSummary so the test can read the
// `model` argument buildLeafSummarizeFn passes it. Hoisted above the SUT import.
// The existing summarizeLeafChunk tests inject a stub `summarize` and never
// reach buildLeafSummarizeFn → generateSummary, so this mock does not affect them.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  generateSummary: vi.fn(async () => "summary"),
}));
import { generateSummary } from "@earendil-works/pi-coding-agent";

import {
  buildLeafSummarizeFn,
  resolveSummarizerWindowTokens,
  selectLeafChunk,
  summarizeLeafChunk,
  wrapSummarizerWithFailover,
  type LeafChunkItem,
  type LeafSummarizer,
  type LeafSummarizerDeps,
} from "./lcd-leaf-summarizer.js";
import {
  LEAF_FALLBACK_SUMMARY_MARKER,
  LEAF_FALLBACK_TARGET_TOKENS,
  COMPACTION_MAX_RETRIES,
} from "./constants.js";
import {
  estimateMessageChars,
  estimateMessageTokens,
  CHARS_PER_TOKEN,
} from "../safety/token-estimator.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createSummarizerSpendBreaker } from "../safety/summarizer-spend-breaker.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

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

/**
 * A simple synthetic history of N user/assistant text turns (each ~`tokensEach`
 * stored tokens). The content is padded to ≈ `tokensEach * CHARS_PER_TOKEN` chars
 * so the RENDERED 4:1 measure is consistent with the claimed stored token count
 * (B-4 260605-ney: the shrink-CHECK now compares the candidate against the
 * rendered ceiling, so a fixture's content length must match its token claim —
 * a 2-char "u0" body claiming 200 tokens is dishonest and would falsely floor).
 */
function textHistory(count: number, tokensEach: number, startAt = 100): LeafChunkItem[] {
  const items: LeafChunkItem[] = [];
  // Pad to roughly tokensEach*4 chars so estimateMessageChars(msg)/4 ≈ tokensEach.
  const pad = (label: string): string => label.padEnd(Math.max(label.length, tokensEach * 4), " word");
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? userMsg(pad(`u${i}`)) : assistantText(pad(`a${i}`));
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

/**
 * B-4 (260605-ney): a SPY-with-PROPORTIONAL-OUTPUT summarizer — models a real
 * model writing TO its token target. It records every `reserveTokens` it is
 * handed (`seenReserveTokens`) and returns a string of `reserveTokens * k *
 * CHARS_PER_TOKEN` chars, so its measured summary tokens ≈ `reserveTokens * k`
 * (estimateMessageTokens of a user string is `ceil(len / 4)`). With the chunk
 * sized so the rendered-4:1 shrink ceiling sits BELOW the full configured target
 * (1200/2000) but ABOVE the bounded effective target (≈ floor(ceiling * 0.5)),
 * the SAME stub FLOORS pre-patch (it sees the full target → its output exceeds
 * the chunk → escalate → Level-3) and REDUCES post-patch (it sees the bounded
 * target → its output is below the ceiling → accepted at Level 1). `k = 1`.
 */
function proportionalSpySummarizer(k = 1): {
  fn: LeafSummarizer;
  seenReserveTokens: () => number[];
} {
  const seen: number[] = [];
  const fn: LeafSummarizer = vi.fn(async (_messages, opts) => {
    seen.push(opts.reserveTokens);
    return "x".repeat(Math.max(0, Math.round(opts.reserveTokens * k * CHARS_PER_TOKEN)));
  });
  return { fn, seenReserveTokens: () => seen };
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

  it("R1: an OVER-CAP per-tenant gate degrades the leaf pass to the deterministic floor (truncation-only, no throw to the turn)", async () => {
    // Build the REAL 132-02 gate with a 1-token hourly cap → ANY real chunk is
    // over-cap → the gate throws "degraded" WITHOUT calling inner. The ladder
    // catches that throw and floors to Level-3 (fallback:true) — exactly the R1
    // degrade-to-truncation-only path, with NO error propagating to the turn.
    const inner = shortSummarizer(); // would succeed at Level 1 if ever called
    const spendBreaker = createSummarizerSpendBreaker({
      breakerConfig: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
      spendConfig: { maxTokensPerTenantPerHour: 1, maxTokensPerTenantPerDay: 1 },
      clock: createFakeClock(1_000),
      estimateInputTokens: () => 10_000, // far above the 1-token cap → over-cap refuse
      estimateOutputTokens: () => 0,
    });
    const gated = spendBreaker.gate("tenant-a", inner);
    const { deps } = makeDeps(gated);

    const result = await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });

    // Degraded to the deterministic floor — no turn failure.
    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER)).toBe(true);
    // The inner summarizer was BYPASSED (the gate refused before calling it).
    expect(inner).not.toHaveBeenCalled();
    // Strictly smaller than the chunk (the C1 invariant still holds under degrade).
    expect(summaryTokens(result.content)).toBeLessThan(totalChunkTokens);
  });

  it("R1: an OPEN-breaker per-tenant gate degrades the leaf pass to the floor after repeated summarizer failures", async () => {
    // failureThreshold:1 → the FIRST inner throw opens the breaker; the SECOND
    // call is bypassed (breaker open) and floors. Proves the breaker (not just the
    // spend cap) drives the degrade. Generous spend caps so only the breaker fires.
    const inner = throwingSummarizer(); // every inner call throws → records a failure
    const spendBreaker = createSummarizerSpendBreaker({
      breakerConfig: { failureThreshold: 1, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
      spendConfig: { maxTokensPerTenantPerHour: 0, maxTokensPerTenantPerDay: 0 }, // 0 = disabled
      clock: createFakeClock(1_000),
      estimateInputTokens: () => 1,
      estimateOutputTokens: () => 0,
    });
    const gated = spendBreaker.gate("tenant-a", inner);
    const { deps } = makeDeps(gated);

    // First pass: inner throws (caught by the ladder) → breaker opens → Level-3 floor.
    const first = await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
    expect(first.fallback).toBe(true);

    // Second pass: breaker is OPEN → the gate bypasses inner entirely → floor again.
    const innerCallsAfterOpen = (inner as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await summarizeLeafChunk(chunkItems, deps, { reserveTokens: 1_200 });
    expect(second.level).toBe(3);
    expect(second.fallback).toBe(true);
    // inner was NOT called again on the second pass (breaker-open bypass).
    expect((inner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(innerCallsAfterOpen);
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

// ===========================================================================
// WR-01 — the deterministic Level-3 floor must shrink even a TINY chunk
// ===========================================================================
//
// The C1 "always strictly smaller" invariant must hold for the smallest
// reachable chunk too: `selectLeafChunk` always includes at least one message,
// so a single tiny out-of-tail message on a small-window model can be a
// sub-5-token chunk. The pre-fix `Math.max(MARKER.length, …)` floor pins the
// Level-3 output at the 19-char marker (≈5 tokens at the estimator's 4:1),
// LARGER than a 2–3-token chunk — the opposite of compaction. The bound must be
// the estimator itself (truncate until estimateMessageTokens < chunkTokens),
// not a hand-derived 3.5-chars-per-token ceiling (which also drops IN-03's
// 3.5-vs-4 mismatch).

describe("summarizeLeafChunk Level-3 floor shrinks even a tiny chunk (WR-01)", () => {
  for (const chunkTok of [3, 2]) {
    it(`a ${chunkTok}-token chunk + oversized stub yields a Level-3 summary strictly smaller than the chunk`, async () => {
      // One tiny message carrying exactly `chunkTok` stored tokens.
      const tiny: LeafChunkItem[] = [item("tiny", userMsg("hi"), chunkTok, 100)];
      const before = chunkTokens(tiny);
      expect(before).toBe(chunkTok);
      const { deps } = makeDeps(oversizedSummarizer());
      const result = await summarizeLeafChunk(tiny, deps, { reserveTokens: 1_200 });
      // It lands on the deterministic floor (both LLM levels fail to reduce a
      // tiny chunk), and that floor MUST be strictly smaller than the chunk.
      expect(result.level).toBe(3);
      expect(result.fallback).toBe(true);
      expect(summaryTokens(result.content)).toBeLessThan(before);
      // And still bounded by the fallback target.
      expect(summaryTokens(result.content)).toBeLessThanOrEqual(LEAF_FALLBACK_TARGET_TOKENS);
    });
  }

  it("a THROWING stub on a tiny chunk also yields a strictly-smaller Level-3 summary", async () => {
    const tiny: LeafChunkItem[] = [item("tiny", userMsg("x"), 3, 100)];
    const before = chunkTokens(tiny);
    const { deps } = makeDeps(throwingSummarizer());
    const result = await summarizeLeafChunk(tiny, deps, { reserveTokens: 1_200 });
    expect(result.level).toBe(3);
    expect(summaryTokens(result.content)).toBeLessThan(before);
  });

  it("a normal-size chunk still carries the identifiable fallback marker at the head", async () => {
    // The marker semantics are preserved for normal-size chunks (only a tiny
    // chunk may truncate the marker). A 5-message @ 200-tok chunk has ample room.
    const normal = textHistory(5, 200);
    const { deps } = makeDeps(oversizedSummarizer());
    const result = await summarizeLeafChunk(normal, deps, { reserveTokens: 1_200 });
    expect(result.level).toBe(3);
    expect(result.content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER)).toBe(true);
  });
});

// ===========================================================================
// WR-03 — an all-oversized chunk must still attempt Level 2 (aggressive)
// ===========================================================================
//
// `previousSummary` continuity is documented as threaded at Levels 1 and 2. The
// pre-fix Level-2 path filters out every message above
// OVERSIZED_MESSAGE_CHARS_THRESHOLD; when EVERY message is oversized the filtered
// set is empty and Level 2 is skipped entirely — the ladder jumps straight to the
// count-only floor, dropping the chance an aggressive LLM summary of the full set
// would have reduced. When the filter empties the set, one aggressive attempt on
// the FULL (unfiltered) set must be made before the deterministic floor.

describe("summarizeLeafChunk attempts aggressive Level 2 on an all-oversized chunk (WR-03)", () => {
  function allOversized(): LeafChunkItem[] {
    // Three messages, each well above OVERSIZED_MESSAGE_CHARS_THRESHOLD (50_000).
    return [
      item("o0", userMsg("A".repeat(60_000)), 20_000, 100),
      item("o1", userMsg("B".repeat(60_000)), 20_000, 101),
      item("o2", userMsg("C".repeat(60_000)), 20_000, 102),
    ];
  }

  it("invokes the summarizer with aggressive=true (on the full set) before falling to Level 3", async () => {
    let aggressiveCallSeen = false;
    let aggressiveMsgCount = 0;
    // Always returns oversized so Levels 1+2 never ACCEPT — but we assert the
    // aggressive Level-2 ATTEMPT is made (the summarizer is invoked aggressive).
    const summarize: LeafSummarizer = vi.fn(async (messages, opts) => {
      if (opts.aggressive === true) {
        aggressiveCallSeen = true;
        aggressiveMsgCount = messages.length;
      }
      return "X".repeat(500_000);
    });
    const { deps } = makeDeps(summarize);
    const chunk = allOversized();
    const result = await summarizeLeafChunk(chunk, deps, { reserveTokens: 1_200 });

    // A Level-2 aggressive attempt was made on the FULL (unfiltered) set ...
    expect(aggressiveCallSeen).toBe(true);
    expect(aggressiveMsgCount).toBe(chunk.length);
    // ... and only THEN did it fall through to the deterministic floor.
    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(summaryTokens(result.content)).toBeLessThan(chunkTokens(chunk));
  });

  it("accepts a Level-2 aggressive summary of an all-oversized chunk when it reduces (continuity forwarded)", async () => {
    const chunk = allOversized();
    const before = chunkTokens(chunk);
    // The aggressive pass returns a short summary → accepted at Level 2 even
    // though every message is oversized (the full set IS summarized aggressively).
    const summarize: LeafSummarizer = vi.fn(async (_messages, opts) =>
      opts.aggressive === true ? "AGG-SHORT" : "X".repeat(500_000),
    );
    const { deps } = makeDeps(summarize);
    const result = await summarizeLeafChunk(chunk, deps, {
      reserveTokens: 1_200,
      previousSummary: "PRIOR",
    });
    expect(result.level).toBe(2);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe("AGG-SHORT");
    expect(summaryTokens(result.content)).toBeLessThan(before);
    expect(result.descendantCount).toBe(chunk.length);
    // Continuity is still forwarded on the aggressive full-set attempt.
    const aggCall = (summarize as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as { aggressive?: boolean }).aggressive === true,
    );
    expect(aggCall).toBeDefined();
    expect((aggCall![1] as { previousSummary?: string }).previousSummary).toBe("PRIOR");
  });
});

// ===========================================================================
// B-5 (260605-m82): buildLeafSummarizeFn must pass a REAL pi-ai Model<any> to
// generateSummary on the PRIMARY path — NOT the 4-field CompactionModelSnapshot.
// The snapshot lacks the provider-client runtime the SDK invokes, so handing it
// to generateSummary throws every compaction LLM call (always floors → breaker
// opens). The real Model is the executor-resolved model threaded via deps.
// ===========================================================================
describe("buildLeafSummarizeFn passes a REAL Model to generateSummary (B-5)", () => {
  // A sentinel "real Model" — has a method/marker the 4-field snapshot lacks, so
  // the test can prove the snapshot is NOT what generateSummary received.
  const realModel = { id: "claude", provider: "anthropic", generate: () => {}, __realModel: true };
  const snapshot = { provider: "anthropic", contextWindow: 200_000, reasoning: true } as const;

  function leafMessages(): AgentMessage[] {
    return [
      { role: "user", content: "older turn" } as unknown as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "older reply" }] } as unknown as AgentMessage,
    ];
  }

  it("passes the real Model (deps.getRealModel()), not the 4-field snapshot, on the primary path (no override)", async () => {
    (generateSummary as unknown as ReturnType<typeof vi.fn>).mockClear();
    const summarize = buildLeafSummarizeFn({
      // The snapshot getter is still present (capability reads) but MUST NOT be
      // the LLM model arg.
      getModel: () => ({ ...snapshot }),
      getRealModel: () => realModel,
      getApiKey: async () => "test-key",
    });

    await summarize(leafMessages(), { reserveTokens: 1_000 });

    const call = (generateSummary as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const modelArg = call[1]; // generateSummary(messages, model, reserveTokens, apiKey, ...)
    // It is the REAL Model sentinel (carries the marker the snapshot lacks)…
    expect(modelArg).toBe(realModel);
    expect((modelArg as { __realModel?: boolean }).__realModel).toBe(true);
    // …and is NOT the 4-field snapshot.
    expect(modelArg).not.toEqual(snapshot);
    expect((modelArg as { contextWindow?: number }).contextWindow).toBeUndefined();
  });

  it("still prefers the override's real Model when overrideModel is present (precedence unchanged)", async () => {
    (generateSummary as unknown as ReturnType<typeof vi.fn>).mockClear();
    const realOverride = { id: "haiku", provider: "anthropic", generate: () => {}, __override: true };
    const summarize = buildLeafSummarizeFn({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => realModel,
      getApiKey: async () => "primary-key",
      overrideModel: { model: realOverride, getApiKey: async () => "override-key" },
    });

    await summarize(leafMessages(), { reserveTokens: 1_000 });

    const call = (generateSummary as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBe(realOverride);
  });
});

// ===========================================================================
// B-4 (260605-ney): the spurious deterministic floor on a SMALL chunk.
//
// Live real-LLM testing showed one leaf falling to `escalationLevel:3
// fallback:true` (the deterministic count-only floor) on a 3-message chunk while
// sibling leaves summarized fine at level 1. ROOT CAUSE (verified — the dominant
// lever): the summarize TARGET (`reserveTokens` = leafTargetTokens, default 1200)
// can EXCEED a small chunk, so the model is told to write up to 1200 tokens for a
// ~100-token chunk → the summary cannot be smaller → guaranteed non-reduction →
// floor. The fix BOUNDS the effective target below the chunk's rendered-4:1 shrink
// ceiling (`effectiveReserveTokens = min(reserve, floor(ceiling * 0.5))`) AND makes
// the shrink-CHECK self-consistent (the candidate and the ceiling are BOTH measured
// at 4:1 rendered prose — no 4:1-prose-vs-mixed-stored comparison). The STORED Σ
// tokenCount stays the budget/floor authority (the Level-3 floor still beats it).
//
// The SPY+proportional stub (`proportionalSpySummarizer`) is the key to a clean
// RED: it writes TO its target, so the SAME stub floors at the full 1200 target
// (pre-patch) and reduces at the bounded target (post-patch).
// ===========================================================================
describe("summarizeLeafChunk does not spuriously floor a small chunk — bounds the target + self-consistent ceiling (B-4)", () => {
  const SHRINK_TARGET_FRACTION = 0.5; // mirrors the production constant.

  /** The rendered-4:1 shrink ceiling over a chunk's messages (what the fix uses). */
  function renderedCeiling(items: LeafChunkItem[]): number {
    const renderedChars = items.reduce(
      (acc, it) => acc + estimateMessageChars(it.msg as unknown as Message),
      0,
    );
    return Math.ceil(renderedChars / CHARS_PER_TOKEN);
  }

  /** The bounded effective target the fix derives from the rendered ceiling. */
  function boundedTarget(items: LeafChunkItem[]): number {
    return Math.max(1, Math.floor(renderedCeiling(items) * SHRINK_TARGET_FRACTION));
  }

  it("(i) structured small chunk: a user prompt + tool call + tool result is accepted at level 1, not floored", async () => {
    // A realistic 3-message tool-use chunk whose Σ STORED tokenCount is modest
    // (well under leafTargetTokens 1200). Stored counts mirror the content-aware
    // estimator (3:1 for the structured toolCall/toolResult) so the fixture is honest.
    const args = { path: "/etc/app/database-config-settings.yaml", recursive: true, includeHidden: false, maxDepth: 5 };
    const trText =
      "database host is db.internal.example.com port 5432 pool size 20 ssl mode require timeout 30s schema public migrations applied";
    const chunk: LeafChunkItem[] = [
      item("u0", userMsg("please read the config file and report what you find about the database settings"), 20, 100),
      item("t1", assistantToolCall("c1", "read", args), 40, 101),
      item("r1", toolResult("c1", "read", trText), 40, 102),
    ];
    const before = chunkTokens(chunk);
    expect(before).toBeLessThan(1_200); // the target would otherwise exceed the chunk.

    const spy = proportionalSpySummarizer(1);
    const { deps } = makeDeps(spy.fn);
    const result = await summarizeLeafChunk(chunk, deps, { reserveTokens: 1_200 });

    // Post-fix: accepted at level 1 (the bounded target produces a reducing summary).
    // Pre-patch the spy sees 1200 → its proportional summary (~1200 tok) exceeds the
    // chunk → escalates to the Level-3 deterministic floor (level 3, fallback true).
    expect(result.level).toBe(1);
    expect(result.fallback).toBe(false);
    // The summarizer was handed a target BOUNDED below the chunk's rendered-4:1
    // ceiling (≤ floor(ceiling * 0.5)) — pre-patch it would be the full 1200.
    const cap = boundedTarget(chunk);
    expect(cap).toBeLessThan(1_200);
    for (const seen of spy.seenReserveTokens()) {
      expect(seen).toBeLessThanOrEqual(cap);
    }
    // The accepted summary is strictly smaller than the chunk (the C1 invariant).
    expect(summaryTokens(result.content)).toBeLessThan(before);
  });

  it("(ii) pure-text small chunk: a small all-text chunk is accepted at level 1, not floored", async () => {
    // All-text (stored 4:1 == rendered 4:1, no structured component), Σ < 1200.
    const chunk: LeafChunkItem[] = [
      item("u0", userMsg("can you summarize the meeting notes from yesterday about the launch plan"), 18, 100),
      item("a1", assistantText("the launch is scheduled for next friday with marketing and engineering aligned on the rollout"), 23, 101),
      item("u2", userMsg("great, what are the open risks we still need to track before then"), 16, 102),
    ];
    const before = chunkTokens(chunk);
    expect(before).toBeLessThan(1_200);

    const spy = proportionalSpySummarizer(1);
    const { deps } = makeDeps(spy.fn);
    const result = await summarizeLeafChunk(chunk, deps, { reserveTokens: 1_200 });

    expect(result.level).toBe(1);
    expect(result.fallback).toBe(false);
    const cap = boundedTarget(chunk);
    expect(cap).toBeLessThan(1_200);
    for (const seen of spy.seenReserveTokens()) {
      expect(seen).toBeLessThanOrEqual(cap);
    }
    expect(summaryTokens(result.content)).toBeLessThan(before);
  });

  it("(iii) invariant preserved: a truly non-reducing (oversized) summary still floors strictly below the STORED Σ", async () => {
    // The bound only caps the TARGET; an oversized summarizer ignores the target
    // and returns a fixed 500_000-char string that exceeds ANY chunk → the ladder
    // must STILL fall through to the deterministic Level-3 floor, and that floor
    // must STILL be strictly below the STORED Σ (the always-reduces-or-floors
    // terminator + the floor's stored-Σ authority are unchanged).
    const chunk: LeafChunkItem[] = [
      item("u0", userMsg("a small prompt that on its own is well under the leaf target"), 18, 100),
      item("a1", assistantText("a short reply that also stays well under the configured leaf target tokens"), 19, 101),
      item("u2", userMsg("and one more short follow-up question to round out the tiny chunk"), 16, 102),
    ];
    const before = chunkTokens(chunk);
    const { deps } = makeDeps(oversizedSummarizer());
    const result = await summarizeLeafChunk(chunk, deps, { reserveTokens: 1_200 });

    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.content.startsWith(LEAF_FALLBACK_SUMMARY_MARKER)).toBe(true);
    // Strictly below the STORED Σ (NOT the smaller rendered ceiling — the floor's
    // authority is the stored before-size) and bounded by the fallback target.
    expect(summaryTokens(result.content)).toBeLessThan(before);
    expect(summaryTokens(result.content)).toBeLessThanOrEqual(LEAF_FALLBACK_TARGET_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// SUM-03: wrapSummarizerWithFailover — provider failover (Phase 171-03)
// ---------------------------------------------------------------------------

describe("wrapSummarizerWithFailover — SUM-03", () => {
  // Minimal message fixtures for failover tests
  const msgs: AgentMessage[] = [userMsg("hello") as unknown as AgentMessage];
  const opts = { reserveTokens: 200 };

  function makeLogger() {
    return {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      fatal: vi.fn(),
    } as unknown as import("@comis/core").ComisLogger;
  }

  it("failover tries second provider when primary throws synchronous error", async () => {
    const primary: LeafSummarizer = vi.fn(async () => {
      throw new Error("primary failed");
    });
    const fallback: LeafSummarizer = vi.fn(async () => "fallback summary");
    const logger = makeLogger();

    const wrapped = wrapSummarizerWithFailover(primary, [fallback], logger);
    const result = await wrapped(msgs, opts);

    expect(result).toBe("fallback summary");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("failover tries providers in list order, not all at once", async () => {
    const primary: LeafSummarizer = vi.fn(async () => {
      throw new Error("primary failed");
    });
    const fallback1: LeafSummarizer = vi.fn(async () => {
      throw new Error("fallback1 failed");
    });
    const fallback2: LeafSummarizer = vi.fn(async () => "third summary");
    const logger = makeLogger();

    const wrapped = wrapSummarizerWithFailover(primary, [fallback1, fallback2], logger);
    const result = await wrapped(msgs, opts);

    expect(result).toBe("third summary");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback1).toHaveBeenCalledTimes(1);
    expect(fallback2).toHaveBeenCalledTimes(1);
  });

  it("all providers fail — wrapper throws the last error from exhausted list", async () => {
    const primary: LeafSummarizer = vi.fn(async () => {
      throw new Error("primary failed");
    });
    const fb1: LeafSummarizer = vi.fn(async () => {
      throw new Error("fb1 failed");
    });
    const fb2: LeafSummarizer = vi.fn(async () => {
      throw new Error("fb2 last");
    });
    const logger = makeLogger();

    const wrapped = wrapSummarizerWithFailover(primary, [fb1, fb2], logger);
    await expect(wrapped(msgs, opts)).rejects.toThrow("fb2 last");
  });

  it("WARN with errorKind dependency emitted on each failover attempt — primary fails then fallback succeeds", async () => {
    const primary: LeafSummarizer = vi.fn(async () => {
      throw new Error("primary failed");
    });
    const fallback: LeafSummarizer = vi.fn(async () => "fallback ok");
    const logger = makeLogger();

    const wrapped = wrapSummarizerWithFailover(primary, [fallback], logger);
    await wrapped(msgs, opts);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "dependency" }),
      expect.any(String),
    );
  });

  it("WARN with errorKind dependency emitted for each failing attempt before success", async () => {
    const primary: LeafSummarizer = vi.fn(async () => {
      throw new Error("p");
    });
    const fallback1: LeafSummarizer = vi.fn(async () => {
      throw new Error("f1");
    });
    const fallback2: LeafSummarizer = vi.fn(async () => "last ok");
    const logger = makeLogger();

    const wrapped = wrapSummarizerWithFailover(primary, [fallback1, fallback2], logger);
    await wrapped(msgs, opts);

    // Two failures (primary + fallback1) before fallback2 succeeds
    expect(logger.warn).toHaveBeenCalledTimes(2);
    const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    for (const [firstArg] of calls) {
      expect((firstArg as { errorKind: string }).errorKind).toBe("dependency");
    }
  });

  it("empty failover list returns primary seam unchanged with no warn emitted", async () => {
    const primary: LeafSummarizer = vi.fn(async () => "ok");
    const logger = makeLogger();

    const wrapped = wrapSummarizerWithFailover(primary, [], logger);
    const result = await wrapped(msgs, opts);

    expect(result).toBe("ok");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// SUMW-01 (Phase 178): resolveSummarizerWindowTokens — THE one resolved-
// summarizer window read. It must mirror buildLeafSummarizeFn's model
// resolution EXACTLY (`overrideModel?.model ?? getRealModel?.()`) so the span
// clamp and the LLM call can never disagree about WHICH model summarizes.
// Pitfall 2 (the override≠primary regression): `getModel()` is the session-
// PRIMARY snapshot — with an `operationModels.compaction` override the
// summarizer is a DIFFERENT model; a clamp keyed to the primary would pass a
// 131K span to an 8K summarizer (a provider overflow). Consumed by the
// pipeline clamp here (llm-compaction) and the LCD leaf/condense clamps
// (plan 178-03 — interface-first: this plan defines, 03 consumes).
// ===========================================================================
describe("resolveSummarizerWindowTokens (SUMW-01)", () => {
  const snapshot = { provider: "anthropic", contextWindow: 200_000, reasoning: true } as const;

  it("override window WINS over the primary's window (the override≠primary regression — Pitfall 2)", () => {
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      overrideModel: {
        model: { id: "small-compaction-override", provider: "ollama", contextWindow: 8_000 },
        getApiKey: async () => "k",
      },
    });
    expect(win).toBe(8_000);
  });

  it("no override → the primary REAL model's window (getRealModel, not the snapshot)", () => {
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
    });
    expect(win).toBe(131_072);
  });

  it("resolved model with a missing/non-finite/non-positive contextWindow → snapshot fallback (never silently huge)", () => {
    const badWindows: unknown[] = [
      {}, // contextWindow absent entirely
      { contextWindow: Number.NaN },
      { contextWindow: 0 },
      { contextWindow: -1 },
      { contextWindow: Infinity },
      { contextWindow: "131072" }, // wrong type — string is not a window
    ];
    for (const model of badWindows) {
      const win = resolveSummarizerWindowTokens({
        getModel: () => ({ ...snapshot }),
        getRealModel: () => model,
      });
      expect(win).toBe(200_000); // the getModel() snapshot — the documented fallback
    }
  });

  it("getRealModel() returns undefined and no override → snapshot fallback", () => {
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => undefined,
    });
    expect(win).toBe(200_000);
  });

  it("deps WITHOUT getRealModel at runtime (trigger-test deps shape) → snapshot fallback, no TypeError", () => {
    // Production always sets getRealModel (executor-context-engine-setup.ts:394),
    // but dozens of pre-existing trigger-test deps builders omit it at runtime;
    // the helper's `getRealModel?.()` optional call must route them to the
    // documented snapshot fallback instead of a TypeError cascade.
    const deps = {
      getModel: () => ({ ...snapshot }),
    } as unknown as Pick<LeafSummarizerDeps, "overrideModel" | "getRealModel" | "getModel">;
    expect(resolveSummarizerWindowTokens(deps)).toBe(200_000);
  });

  it("override present but its model lacks contextWindow → snapshot fallback (override does NOT fall through to the primary)", () => {
    // The ?? chain resolves the MODEL first (override wins), THEN reads the
    // window — an override without a window must not silently adopt the
    // primary's (possibly huge) window. It degrades to the snapshot.
    const win = resolveSummarizerWindowTokens({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => ({ id: "primary", provider: "ollama", contextWindow: 131_072 }),
      overrideModel: {
        model: { id: "windowless-override", provider: "groq" },
        getApiKey: async () => "k",
      },
    });
    expect(win).toBe(200_000);
  });
});
