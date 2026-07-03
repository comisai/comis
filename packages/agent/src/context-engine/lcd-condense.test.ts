// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD condensation summarizer.
 *
 * Drives the two pure-ish responsibilities of `lcd-condense.ts`, the
 * sibling of `lcd-leaf-summarizer.ts` whose input is CHILD-SUMMARY content
 * strings (not reconstructed messages):
 *
 *   1. {@link selectCondensableTier} — given per-depth CONTIGUOUS summary-ref
 *      runs, pick the DEEPEST depth whose run length ≥ the effective fanout.
 *      A run split by a message-ref is TWO separate runs: only a
 *      single contiguous run of length ≥ fanout qualifies.
 *   2. {@link summarizeCondensedChunk} — the SAME 3-level escalation as
 *      `summarizeLeafChunk`, but the before-size is `Σ children.tokenCount`
 *      (the STORED counts — never a re-estimate) and the
 *      summarizer input is the child `content` strings. The produced summary's
 *      `tokenCount` is ALWAYS < `Σ children.tokenCount` (oversized stub →
 *      deterministic Level-3 floor; throwing stub → Level-3, never throws out).
 *
 * NO REAL LLM: the summarizer is a plain stub function; the test
 * imports no provider and makes no network call. The agent↛memory cut: this
 * file imports ONLY agent-side modules (no `@comis/memory`).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, it, expect, vi } from "vitest";

// Mock the SDK generateSummary so the test can read the
// `model` argument buildCondenseSummarizeFn passes it. Hoisted above the SUT
// import, exactly as lcd-leaf-summarizer.test.ts does for buildLeafSummarizeFn.
// The existing summarizeCondensedChunk tests inject a stub `summarize` and never
// reach buildCondenseSummarizeFn → generateSummary, so this mock does not affect them.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  generateSummary: vi.fn(async () => "summary"),
}));
import { generateSummary } from "@earendil-works/pi-coding-agent";

import {
  buildCondenseSummarizeFn,
  selectCondensableTier,
  summarizeCondensedChunk,
  type CondenseChildSummary,
  type SummaryRefRun,
  type CondenseSummarizer,
} from "./lcd-condense.js";
import { CONDENSED_FALLBACK_SUMMARY_MARKER } from "./constants.js";
import type { LeafSummarizerDeps } from "./lcd-leaf-summarizer.js";
import {
  estimateMessageChars,
  CHARS_PER_TOKEN,
} from "../safety/token-estimator.js";
import type { Message } from "@earendil-works/pi-ai";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a CondenseChildSummary (a selectable depth-d summary unit). */
function child(
  summaryId: string,
  ordinal: number,
  opts: Partial<Omit<CondenseChildSummary, "summaryId" | "ordinal">> = {},
): CondenseChildSummary {
  return {
    summaryId,
    ordinal,
    depth: opts.depth ?? 0,
    content: opts.content ?? `summary-${summaryId} content`,
    tokenCount: opts.tokenCount ?? 100,
    taint: opts.taint ?? false,
  };
}

/** Build a contiguous same-depth run from children (start/end = first/last ordinal). */
function run(depth: number, children: CondenseChildSummary[]): SummaryRefRun {
  return {
    depth,
    children,
    startOrdinal: children[0]!.ordinal,
    endOrdinal: children[children.length - 1]!.ordinal,
  };
}

// --- Injected summarizer stubs (NO network, NO real LLM) ---

/** Level-1 success: a fixed SHORT string regardless of input (always reduces). */
function shortSummarizer(text = "CONDENSED: prior summaries merged (short)."): CondenseSummarizer {
  return vi.fn(async () => text);
}

/** An OVERSIZED stub: returns a fixed string far larger than the run's STORED Σ
 *  child tokenCount → forces the ladder past Levels 1+2 to the deterministic
 *  Level-3 floor. Sized in CHARS independent of the (tiny) content so it always
 *  exceeds the stored before-size (the condense before-size is the stored Σ, NOT
 *  the content length). 40_000 chars ≈ 10_000 tokens ≫ any test Σ.
 *  No network. */
function oversizedSummarizer(): CondenseSummarizer {
  return vi.fn(async () => "BLOAT ".repeat(8_000));
}

/** Non-fatal: throws on every call (Levels 1+2 both fail → deterministic L3). */
function throwingSummarizer(): CondenseSummarizer {
  return vi.fn(async () => {
    throw new Error("condense summarizer boom");
  });
}

/**
 * A SPY-with-PROPORTIONAL-OUTPUT condense summarizer — models a
 * real model writing TO its token target. Records every `reserveTokens` it is
 * handed and returns a string of `reserveTokens * k * CHARS_PER_TOKEN` chars
 * (measured tokens ≈ `reserveTokens * k`). The SAME stub FLOORS when handed the
 * unbounded target (it sees the full 2000 → its output exceeds the run's
 * rendered-4:1 ceiling → escalate → Level-3) and REDUCES when handed the bounded
 * effective target (its output is below the ceiling → accepted at Level 1). `k = 1`.
 */
function proportionalSpySummarizer(k = 1): {
  fn: CondenseSummarizer;
  seenReserveTokens: () => number[];
} {
  const seen: number[] = [];
  const fn: CondenseSummarizer = vi.fn(async (_messages, opts) => {
    seen.push(opts.reserveTokens);
    return "x".repeat(Math.max(0, Math.round(opts.reserveTokens * k * CHARS_PER_TOKEN)));
  });
  return { fn, seenReserveTokens: () => seen };
}

function makeDeps(summarize: CondenseSummarizer): LeafSummarizerDeps {
  return {
    logger: createMockLogger() as unknown as LeafSummarizerDeps["logger"],
    summarize,
    getModel: () => ({ provider: "anthropic", contextWindow: 200_000, reasoning: true }),
    getApiKey: async () => "test-key",
  };
}

// ===========================================================================
// selectCondensableTier — deepest contiguous run ≥ fanout
// ===========================================================================

describe("selectCondensableTier — picks the DEEPEST contiguous run at/over the effective fanout", () => {
  it("returns undefined when no depth has a contiguous run reaching the soft fanout (no pressure)", () => {
    const runs: SummaryRefRun[] = [
      run(0, [child("s0", 0), child("s1", 1), child("s2", 2)]),
    ];
    expect(selectCondensableTier(runs, 4, 2, false)).toBeUndefined();
  });

  it("selects the run whose contiguous length reaches the soft fanout (exact boundary)", () => {
    const d0 = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    const picked = selectCondensableTier([d0], 4, 2, false);
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(0);
    expect(picked!.children.map((c) => c.summaryId)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(picked!.startOrdinal).toBe(0);
    expect(picked!.endOrdinal).toBe(3);
  });

  it("prefers the DEEPEST depth when multiple depths each reach fanout, so depth-1→depth-2 can fire", () => {
    // A depth-1 run that reaches fanout must be condensed (→ depth-2)
    // rather than always re-folding the shallowest depth-0 run. Selecting shallowest
    // would leave depth-1→depth-2 unreachable — max depth stuck at 1.
    const d1 = run(1, [child("c0", 10, { depth: 1 }), child("c1", 11, { depth: 1 }), child("c2", 12, { depth: 1 }), child("c3", 13, { depth: 1 })]);
    const d0 = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    // Pass the shallow run FIRST to prove the selection is by depth, not order.
    const picked = selectCondensableTier([d0, d1], 4, 2, false);
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(1);
    expect(picked!.children[0]!.summaryId).toBe("c0");
  });

  it("falls back to the shallower tier when only it reaches fanout (deeper tier below fanout)", () => {
    // depth-1 has only 2 (< soft 4) → not selectable at soft; depth-0 has 4 → it is
    // the deepest QUALIFYING run. So depth-0 keeps folding until depth-1 accumulates
    // enough, at which point depth-1 becomes deepest-qualifying (previous test).
    const d1 = run(1, [child("c0", 10, { depth: 1 }), child("c1", 11, { depth: 1 })]);
    const d0 = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    const picked = selectCondensableTier([d0, d1], 4, 2, false);
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(0);
  });

  it("breaks ties at the same (deepest) depth by the OLDEST run (lowest startOrdinal)", () => {
    const older = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    const newer = run(0, [child("s5", 5), child("s6", 6), child("s7", 7), child("s8", 8)]);
    const picked = selectCondensableTier([newer, older], 4, 2, false);
    expect(picked).toBeDefined();
    expect(picked!.startOrdinal).toBe(0);
    expect(picked!.children[0]!.summaryId).toBe("s0");
  });

  it("never selects across a non-contiguous boundary — only a single run of length >= fanout qualifies", () => {
    const lead = run(0, [child("s0", 0)]);
    const trail = run(0, [child("s2", 2), child("s3", 3), child("s4", 4)]);
    expect(selectCondensableTier([lead, trail], 4, 2, false)).toBeUndefined();
    // …but the SAME trailing run reaches fanout 3 → it (and ONLY it) is selected.
    const picked = selectCondensableTier([lead, trail], 3, 2, false);
    expect(picked).toBeDefined();
    expect(picked!.children.map((c) => c.summaryId)).toEqual(["s2", "s3", "s4"]);
    expect(picked!.startOrdinal).toBe(2);
  });

  it("under HIGH pressure drops to the HARD fanout, condensing a run the soft fanout would skip (condensedMinFanoutHard)", () => {
    // A depth-0 run of 2 summaries: below the SOFT fanout (4) but at/over the HARD
    // lower bound (2). With pressure HIGH the hard bound forces a condense so the
    // tier still drains; with pressure LOW it stays a no-op (soft governs).
    const d0 = run(0, [child("s0", 0), child("s1", 1)]);
    expect(selectCondensableTier([d0], 4, 2, false)).toBeUndefined(); // soft → skip
    const picked = selectCondensableTier([d0], 4, 2, true); // hard under pressure → condense
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(0);
    expect(picked!.children.map((c) => c.summaryId)).toEqual(["s0", "s1"]);
  });

  it("still selects the deepest qualifying run when pressure is high (hard fanout applied per tier)", () => {
    // depth-1 has 2 (≥ hard 2), depth-0 has 3 (≥ hard 2): under pressure BOTH qualify
    // at the hard bound, so the DEEPEST (depth-1) is condensed → depth-2.
    const d1 = run(1, [child("c0", 10, { depth: 1 }), child("c1", 11, { depth: 1 })]);
    const d0 = run(0, [child("s0", 0), child("s1", 1), child("s2", 2)]);
    const picked = selectCondensableTier([d0, d1], 4, 2, true);
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(1);
  });
});

// ===========================================================================
// summarizeCondensedChunk — escalation ALWAYS reduces below Σ child tokenCount
// ===========================================================================

describe("summarizeCondensedChunk — 3-level escalation, before-size is Σ child tokenCount", () => {
  const children = [
    child("s0", 0, { tokenCount: 500, content: "alpha decision X; ran tool read; ok" }),
    child("s1", 1, { tokenCount: 500, content: "beta decision Y; ran tool write; failed" }),
    child("s2", 2, { tokenCount: 500, content: "gamma open question Z" }),
  ];
  const beforeTokens = 1_500;

  it("accepts a Level-1 short summary that is strictly smaller than the summed child tokenCount", async () => {
    const summarize = shortSummarizer();
    const result = await summarizeCondensedChunk(children, makeDeps(summarize), {
      reserveTokens: 2_000,
    });
    expect(result.level).toBe(1);
    expect(result.fallback).toBe(false);
    expect(result.tokenCount).toBeLessThan(beforeTokens);
    expect(result.tokenCount).toBeGreaterThan(0);
    // The summarizer was called with ONE pseudo-message carrying the child content.
    expect(summarize).toHaveBeenCalled();
    const firstCallMessages = (summarize as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AgentMessage[];
    expect(Array.isArray(firstCallMessages)).toBe(true);
    expect(firstCallMessages.length).toBe(1);
  });

  it("falls to the deterministic Level-3 floor when the LLM never reduces (oversized stub) — tokenCount < Σ, fallback=true, marker present", async () => {
    const result = await summarizeCondensedChunk(children, makeDeps(oversizedSummarizer()), {
      reserveTokens: 2_000,
    });
    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.tokenCount).toBeLessThan(beforeTokens);
    expect(result.content.startsWith(CONDENSED_FALLBACK_SUMMARY_MARKER)).toBe(true);
  });

  it("falls to the deterministic Level-3 floor when the summarizer THROWS — never throws out of the pass", async () => {
    const summarize = throwingSummarizer();
    const result = await summarizeCondensedChunk(children, makeDeps(summarize), {
      reserveTokens: 2_000,
    });
    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.tokenCount).toBeLessThan(beforeTokens);
    expect(result.content.startsWith(CONDENSED_FALLBACK_SUMMARY_MARKER)).toBe(true);
    // The throwing summarizer was actually exercised (Levels 1+2 attempts).
    expect(summarize).toHaveBeenCalled();
  });

  it("uses the STORED Σ child tokenCount as the before-size, NOT a re-estimate of the concatenation", async () => {
    // Children whose STORED tokenCount (300 each = 900) is far larger than their
    // rendered content measure: a Level-1 stub returning a ~5-token string must be
    // accepted (5 < both the rendered shrink ceiling AND the stored 900), proving
    // the before-size / budget authority is the summed STORED counts (900), not a
    // re-estimate that would understate the chunk.
    //
    // The ACCEPT ceiling is the rendered 4:1 measure (the
    // candidate is judged like-for-like) — so the content here is realistic prose
    // (a degenerate 1-char content would make the self-consistent ceiling tiny,
    // which is a correctly-rejected case, not the intended scenario). The
    // STORED Σ (900) remains the floor/budget authority; the L1 acceptance still
    // proves the comparison is not driven by a tiny re-estimated concatenation.
    const tinyContentBigCount = [
      child("a", 0, { tokenCount: 300, content: "decision A: selected the postgres backend after benchmarking three options" }),
      child("b", 1, { tokenCount: 300, content: "decision B: the cache write failed under load and was rolled back for retry" }),
      child("c", 2, { tokenCount: 300, content: "open question C: whether to pre-shard the events table prior to the launch" }),
    ];
    const result = await summarizeCondensedChunk(tinyContentBigCount, makeDeps(shortSummarizer("merged ok summary")), {
      reserveTokens: 2_000,
    });
    expect(result.level).toBe(1);
    expect(result.tokenCount).toBeLessThan(900);
  });
});

// ===========================================================================
// buildCondenseSummarizeFn must pass a REAL pi-ai
// Model<any> to generateSummary on the PRIMARY path — NOT the 4-field
// CompactionModelSnapshot. Mirrors the equivalent leaf-tier test verbatim in
// shape: the snapshot lacks the provider-client runtime the SDK invokes, so
// handing it to generateSummary throws every condense LLM call. The real Model is
// the executor-resolved model threaded via deps.getRealModel.
// ===========================================================================
describe("buildCondenseSummarizeFn passes a REAL Model to generateSummary, never the snapshot", () => {
  // A sentinel "real Model" — carries a marker the 4-field snapshot lacks, so the
  // test can prove the snapshot is NOT what generateSummary received.
  const realModel = { id: "claude", provider: "anthropic", generate: () => {}, __realModel: true };
  const snapshot = { provider: "anthropic", contextWindow: 200_000, reasoning: true } as const;

  function condenseMessages(): AgentMessage[] {
    return [
      { role: "user", content: "summary alpha\n\n---\n\nsummary beta" } as unknown as AgentMessage,
    ];
  }

  it("passes the real Model (deps.getRealModel()), not the 4-field snapshot, on the primary path (no override)", async () => {
    (generateSummary as unknown as ReturnType<typeof vi.fn>).mockClear();
    const summarize = buildCondenseSummarizeFn({
      // The snapshot getter is present (capability reads) but MUST NOT be the LLM arg.
      getModel: () => ({ ...snapshot }),
      getRealModel: () => realModel,
      getApiKey: async () => "test-key",
    });

    await summarize(condenseMessages(), { reserveTokens: 1_000 });

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
    const summarize = buildCondenseSummarizeFn({
      getModel: () => ({ ...snapshot }),
      getRealModel: () => realModel,
      getApiKey: async () => "primary-key",
      overrideModel: { model: realOverride, getApiKey: async () => "override-key" },
    });

    await summarize(condenseMessages(), { reserveTokens: 1_000 });

    const call = (generateSummary as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBe(realOverride);
  });
});

// ===========================================================================
// The spurious deterministic floor on a SMALL condense run —
// the same guard the leaf tier has, mirrored at the condense tier. The summarize
// TARGET (`reserveTokens` = condensedTargetTokens, default 2000) can EXCEED a small
// run's rendered size → the model is told to write more than it compresses →
// guaranteed non-reduction → floor. The guard BOUNDS the effective target below the
// run's rendered-4:1 shrink ceiling AND makes the shrink-CHECK self-consistent
// (candidate and ceiling both measured at 4:1 rendered prose). The STORED Σ child
// tokenCount stays the budget/floor authority (the Level-3 floor still beats it).
// ===========================================================================
describe("summarizeCondensedChunk does not spuriously floor a small run — bounds the target + self-consistent ceiling", () => {
  const SHRINK_TARGET_FRACTION = 0.5; // mirrors the production constant.

  /** The rendered-4:1 shrink ceiling over the run's ONE concatenated pseudo-message. */
  function renderedCeiling(children: CondenseChildSummary[]): number {
    const joined = children.map((c) => c.content).join("\n\n---\n\n");
    const renderedChars = estimateMessageChars({ role: "user", content: joined } as Message);
    return Math.ceil(renderedChars / CHARS_PER_TOKEN);
  }

  /** The bounded effective target derived from the rendered ceiling. */
  function boundedTarget(children: CondenseChildSummary[]): number {
    return Math.max(1, Math.floor(renderedCeiling(children) * SHRINK_TARGET_FRACTION));
  }

  it("small run: a run whose Σ child tokenCount is under condensedTargetTokens is accepted at level 1, not floored", async () => {
    // A run whose Σ STORED child tokenCount (modest) is well under condensedTargetTokens (2000).
    const children = [
      child("s0", 0, { tokenCount: 90, content: "alpha: decided to use postgres; ran read tool; succeeded; file config.yaml updated" }),
      child("s1", 1, { tokenCount: 80, content: "beta: attempted write to cache layer; failed with timeout; retry scheduled" }),
      child("s2", 2, { tokenCount: 70, content: "gamma: open question about whether to shard the events table before launch" }),
    ];
    const before = children.reduce((acc, c) => acc + c.tokenCount, 0);
    expect(before).toBeLessThan(2_000); // the target would otherwise exceed the run.

    const spy = proportionalSpySummarizer(1);
    const result = await summarizeCondensedChunk(children, makeDeps(spy.fn), { reserveTokens: 2_000 });

    // Accepted at level 1. Without the bound the spy sees 2000 → its proportional
    // summary (~2000 tok) exceeds the run's rendered ceiling → escalates to Level-3.
    expect(result.level).toBe(1);
    expect(result.fallback).toBe(false);
    // The summarizer was handed a target BOUNDED below the run's rendered-4:1 ceiling.
    const cap = boundedTarget(children);
    expect(cap).toBeLessThan(2_000);
    for (const seen of spy.seenReserveTokens()) {
      expect(seen).toBeLessThanOrEqual(cap);
    }
    // The accepted summary is strictly smaller than the STORED Σ (the escalation invariant).
    expect(result.tokenCount).toBeLessThan(before);
  });

  it("invariant preserved: a truly non-reducing (oversized) summary still floors strictly below the STORED Σ", async () => {
    // The bound only caps the TARGET; an oversized summarizer ignores it and returns
    // a fixed string exceeding ANY run → the ladder must STILL fall through to the
    // deterministic Level-3 floor, strictly below the STORED Σ child tokenCount
    // (the floor's authority is the stored before-size, not the rendered ceiling).
    const children = [
      child("s0", 0, { tokenCount: 90, content: "alpha: a short condensed child summary about the build" }),
      child("s1", 1, { tokenCount: 80, content: "beta: another short condensed child summary about the deploy" }),
      child("s2", 2, { tokenCount: 70, content: "gamma: a third short condensed child summary about the test run" }),
    ];
    const before = children.reduce((acc, c) => acc + c.tokenCount, 0);
    const result = await summarizeCondensedChunk(children, makeDeps(oversizedSummarizer()), { reserveTokens: 2_000 });

    expect(result.level).toBe(3);
    expect(result.fallback).toBe(true);
    expect(result.content.startsWith(CONDENSED_FALLBACK_SUMMARY_MARKER)).toBe(true);
    expect(result.tokenCount).toBeLessThan(before);
  });
});
