// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LCD condensation summarizer (Phase 130, C2 — Plan 02 Task 1).
 *
 * RED-first. Drives the two pure-ish responsibilities of `lcd-condense.ts`, the
 * sibling of `lcd-leaf-summarizer.ts` whose input is CHILD-SUMMARY content
 * strings (not reconstructed messages):
 *
 *   1. {@link selectCondensableTier} — given per-depth CONTIGUOUS summary-ref
 *      runs, pick the SHALLOWEST depth whose run length ≥ `condensedMinFanout`.
 *      A run split by a message-ref is TWO separate runs (Pitfall 3): only a
 *      single contiguous run of length ≥ fanout qualifies.
 *   2. {@link summarizeCondensedChunk} — the SAME 3-level escalation as
 *      `summarizeLeafChunk`, but the before-size is `Σ children.tokenCount`
 *      (the STORED counts — never a re-estimate, Pitfall 2/5) and the
 *      summarizer input is the child `content` strings. The produced summary's
 *      `tokenCount` is ALWAYS < `Σ children.tokenCount` (oversized stub →
 *      deterministic Level-3 floor; throwing stub → Level-3, never throws out).
 *
 * NO REAL LLM (Pitfall 6): the summarizer is a plain stub function; the test
 * imports no provider and makes no network call. The agent↛memory cut: this
 * file imports ONLY agent-side modules (no `@comis/memory`).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, it, expect, vi } from "vitest";

// B-5 twin (260605-ney): mock the SDK generateSummary so the test can read the
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
 *  the content length — Pitfall 2/5). 40_000 chars ≈ 10_000 tokens ≫ any test Σ.
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

function makeDeps(summarize: CondenseSummarizer): LeafSummarizerDeps {
  return {
    logger: createMockLogger() as unknown as LeafSummarizerDeps["logger"],
    summarize,
    getModel: () => ({ provider: "anthropic", contextWindow: 200_000, reasoning: true }),
    getApiKey: async () => "test-key",
  };
}

// ===========================================================================
// selectCondensableTier — shallowest contiguous run ≥ fanout
// ===========================================================================

describe("selectCondensableTier — picks the shallowest contiguous run at/over fanout", () => {
  it("returns undefined when no depth has a contiguous run reaching condensedMinFanout", () => {
    const runs: SummaryRefRun[] = [
      run(0, [child("s0", 0), child("s1", 1), child("s2", 2)]),
    ];
    expect(selectCondensableTier(runs, 4)).toBeUndefined();
  });

  it("selects the run whose contiguous length reaches condensedMinFanout (exact boundary)", () => {
    const d0 = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    const picked = selectCondensableTier([d0], 4);
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(0);
    expect(picked!.children.map((c) => c.summaryId)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(picked!.startOrdinal).toBe(0);
    expect(picked!.endOrdinal).toBe(3);
  });

  it("prefers the SHALLOWEST depth when multiple depths each reach fanout", () => {
    const d1 = run(1, [child("c0", 10, { depth: 1 }), child("c1", 11, { depth: 1 }), child("c2", 12, { depth: 1 }), child("c3", 13, { depth: 1 })]);
    const d0 = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    // Pass the deeper run FIRST to prove the selection is by depth, not order.
    const picked = selectCondensableTier([d1, d0], 4);
    expect(picked).toBeDefined();
    expect(picked!.depth).toBe(0);
    expect(picked!.children[0]!.summaryId).toBe("s0");
  });

  it("breaks ties at the same depth by the OLDEST run (lowest startOrdinal)", () => {
    // Two separate contiguous depth-0 runs (Pitfall-3 layout: split by a
    // message-ref between them), both at fanout — the older (lower startOrdinal)
    // is condensed first.
    const older = run(0, [child("s0", 0), child("s1", 1), child("s2", 2), child("s3", 3)]);
    const newer = run(0, [child("s5", 5), child("s6", 6), child("s7", 7), child("s8", 8)]);
    const picked = selectCondensableTier([newer, older], 4);
    expect(picked).toBeDefined();
    expect(picked!.startOrdinal).toBe(0);
    expect(picked!.children[0]!.summaryId).toBe("s0");
  });

  it("never selects across a non-contiguous boundary — only a single run of length >= fanout qualifies (Pitfall 3)", () => {
    // Layout [s0(d0) | m1 | s2 s3 s4 (d0)] with fanout=4: the leading singleton
    // run {s0} has length 1; the trailing run {s2,s3,s4} has length 3. NEITHER
    // reaches fanout 4, so nothing is selectable — proving s0 is NEVER merged
    // with s2,s3,s4 across the surviving message-ref.
    const lead = run(0, [child("s0", 0)]);
    const trail = run(0, [child("s2", 2), child("s3", 3), child("s4", 4)]);
    expect(selectCondensableTier([lead, trail], 4)).toBeUndefined();
    // …but the SAME trailing run reaches fanout 3 → it (and ONLY it) is selected.
    const picked = selectCondensableTier([lead, trail], 3);
    expect(picked).toBeDefined();
    expect(picked!.children.map((c) => c.summaryId)).toEqual(["s2", "s3", "s4"]);
    expect(picked!.startOrdinal).toBe(2);
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

  it("uses the STORED Σ child tokenCount as the before-size, NOT a re-estimate of the concatenation (Pitfall 5)", async () => {
    // Children whose CONTENT is tiny but whose STORED tokenCount is large: a
    // Level-1 stub returning a ~6-token string must be accepted (6 < 900),
    // proving the before-size is the summed STORED counts (900), not the
    // re-estimated concatenation (which would be a handful of tokens and could
    // make the comparison spuriously fail/pass).
    const tinyContentBigCount = [
      child("a", 0, { tokenCount: 300, content: "a" }),
      child("b", 1, { tokenCount: 300, content: "b" }),
      child("c", 2, { tokenCount: 300, content: "c" }),
    ];
    const result = await summarizeCondensedChunk(tinyContentBigCount, makeDeps(shortSummarizer("merged ok summary")), {
      reserveTokens: 2_000,
    });
    expect(result.level).toBe(1);
    expect(result.tokenCount).toBeLessThan(900);
  });
});

// ===========================================================================
// B-5 twin (260605-ney): buildCondenseSummarizeFn must pass a REAL pi-ai
// Model<any> to generateSummary on the PRIMARY path — NOT the 4-field
// CompactionModelSnapshot. Mirrors the leaf B-5 test (cf781ac7) verbatim in
// shape: the snapshot lacks the provider-client runtime the SDK invokes, so
// handing it to generateSummary throws every condense LLM call. The real Model is
// the executor-resolved model threaded via deps.getRealModel.
// ===========================================================================
describe("buildCondenseSummarizeFn passes a REAL Model to generateSummary (B-5 twin)", () => {
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
