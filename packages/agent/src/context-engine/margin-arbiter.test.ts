// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure tiered margin arbiter.
 *
 * The arbiter is the relevance-first sibling of evictHistoryUnderBudget: it consumes
 * the discretionary pool the pre-flight already validated
 * (budget.availableHistoryTokens) and allocates it across the history tiers (T0/T1/T2)
 * AND the cross-session LTM/KG candidate tiers (T3/T4) by FUSED RANK (RRF via the
 * shared scorer / fuse), with the T0 fresh-tail + security-pinned floors UNCONDITIONAL.
 *
 * Invariants pinned here:
 *  - Test 1: no over-allocate — sum(kept tokens) ≤ poolTokens (never reclaim).
 *  - Test 2: T0 fresh-tail floor is unconditional (kept regardless of fused rank).
 *  - Test 3: security-pinned floor is unconditional (kept, never a relevance candidate).
 *  - Test 4: per-tier minimum slots are represented (LTM + recent-history).
 *  - Test 5: allocation is by FUSED RANK, never raw score.
 *  - Test 6: purity — the input arrays are not mutated.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemorySearchResult, MemoryEntry } from "@comis/core";
import { marginArbitrate, type ArbiterFloors } from "./margin-arbiter.js";
import type { BudgetItem } from "./lcd-budget-eviction.js";
import { scoreRelevance, buildRelevanceQuery } from "../rag/relevance-scorer.js";
import type { FusionLane } from "../rag/fuse.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal AgentMessage/BudgetItem + MemorySearchResult builders
// ---------------------------------------------------------------------------

/** A minimal user-role message carrying an identifying text (for ordering assertions). */
function msg(text: string, role: "user" | "assistant" = "user"): AgentMessage {
  return { role, content: text } as unknown as AgentMessage;
}

/** A history BudgetItem: a message + its supplied token count. */
function item(text: string, tokens: number, role: "user" | "assistant" = "user"): BudgetItem {
  return { msg: msg(text, role), tokens };
}

/** A MemorySearchResult keyed by id with an explicit raw score. */
function result(id: string, score: number, content = `mem-${id}`): MemorySearchResult {
  const entry = {
    id,
    content,
    trustLevel: "learned",
    createdAt: 1000,
  } as unknown as MemoryEntry;
  return { entry, score };
}

/** A `toolResult`-role BudgetItem: the inseparable result tail of an assistant `tool_use`.
 *  The step grouper (lcd-budget-eviction.groupIntoSteps) binds a trailing toolResult to the
 *  preceding non-toolResult message, so an assistant tool_use + its toolResult form ONE step. */
function toolResultItem(text: string, tokens: number): BudgetItem {
  return { msg: { role: "toolResult", content: text } as unknown as AgentMessage, tokens };
}

/** Read a message's identifying text back (the builder stores it on `content`). */
function textOf(m: AgentMessage): string {
  return (m as unknown as { content: string }).content;
}

/** Sum the tokens of the kept NON-floor (middle-band) items, by membership — the TRUE
 *  discretionary consumption the `poolTokensUsed` accounting must match. */
function trueKeptMiddleTokens(kept: AgentMessage[], band: BudgetItem[], floorTexts: Set<string>): number {
  const keptTexts = new Set(kept.map(textOf));
  return band
    .filter((b) => keptTexts.has(textOf(b.msg)) && !floorTexts.has(textOf(b.msg)))
    .reduce((s, b) => s + b.tokens, 0);
}

const NO_FLOORS: ArbiterFloors = { freshTailItems: [], pinnedItems: [] };

// A non-degraded relevance query so scoreRelevance runs the RRF path (≥2 terms).
const HEALTHY_QUERY = buildRelevanceQuery(["deploy the trading bot config"]);

describe("marginArbitrate — pure tiered allocator", () => {
  it("Test 1: never over-allocates — the kept token sum is ≤ the discretionary pool", () => {
    // Pool is 100 tokens; candidates total 250. The arbiter must allocate ≤ 100.
    const history: BudgetItem[] = [
      item("h1", 40),
      item("h2", 40),
      item("h3", 40),
      item("h4", 40),
      item("h5", 40),
      item("h6", 50),
    ];
    const out = marginArbitrate({
      historyItems: history,
      ltmCandidates: [],
      kgCandidates: [],
      floors: NO_FLOORS,
      poolTokens: 100,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    // Sum the kept history tokens by matching back to the input token counts.
    const keptTokens = out.kept.reduce((sum, m) => {
      const src = history.find((h) => textOf(h.msg) === textOf(m));
      return sum + (src?.tokens ?? 0);
    }, 0);
    expect(keptTokens).toBeLessThanOrEqual(100);
    expect(out.poolTokensUsed).toBeLessThanOrEqual(100);
    expect(out.poolTokensUsed).toBe(keptTokens);
  });

  it("Test 2: the T0 fresh-tail floor is unconditional — kept even when the pool is tiny", () => {
    // Pool 1 token (smaller than any item). The two T0 fresh-tail items must STILL be kept.
    const t0a = item("t0a", 30);
    const t0b = item("t0b", 30);
    const middle = item("m1", 30);
    const out = marginArbitrate({
      historyItems: [middle, t0a, t0b], // floors are a subset of historyItems
      ltmCandidates: [],
      kgCandidates: [],
      floors: { freshTailItems: [t0a, t0b], pinnedItems: [] },
      poolTokens: 1,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    const keptTexts = out.kept.map(textOf);
    expect(keptTexts).toContain("t0a");
    expect(keptTexts).toContain("t0b");
    // The non-floor middle item cannot fit the 1-token pool → dropped.
    expect(keptTexts).not.toContain("m1");
  });

  it("Test 3: the security-pinned floor is unconditional — kept regardless of fused rank, never a relevance candidate", () => {
    // A security-pinned history item with NO relevance signal whatsoever; pool is tiny.
    const pinned = item("CANARY-pinned", 80);
    const ordinary = item("ordinary", 20);
    const out = marginArbitrate({
      historyItems: [pinned, ordinary],
      ltmCandidates: [],
      kgCandidates: [],
      floors: { freshTailItems: [], pinnedItems: [pinned] },
      poolTokens: 5, // far too small for the 80-token pinned item
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    const keptTexts = out.kept.map(textOf);
    // The pinned item survives unconditionally even though it dwarfs the pool.
    expect(keptTexts).toContain("CANARY-pinned");
  });

  it("Test 4: per-tier minimum slots are represented — an LTM-fact slot AND a recent-history slot", () => {
    // Both a recent-history item and an LTM candidate are present; with budget after
    // floors, each tier's minimum slot must be represented (at least one of each).
    const recent = item("recent-history", 20);
    const ltmLane: FusionLane = { results: [result("ltm1", 0.9)], weight: 1.0 };
    const out = marginArbitrate({
      historyItems: [recent],
      ltmCandidates: [ltmLane],
      kgCandidates: [],
      floors: NO_FLOORS,
      poolTokens: 10_000, // ample
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    // The recent-history slot is represented.
    expect(out.kept.map(textOf)).toContain("recent-history");
    expect(out.perTierKept.history).toBeGreaterThanOrEqual(1);
    // The LTM-fact slot is represented (counted in perTierKept).
    expect(out.perTierKept.ltm).toBeGreaterThanOrEqual(1);
  });

  it("Test 5: contended tokens go to the higher FUSED-rank candidate, NOT the higher raw score", () => {
    // Construct two LTM candidates across two lanes where the raw-score order
    // (c wins on a single huge cosine) is INVERTED by the fused rank (b appears
    // high in BOTH lanes → higher RRF). The arbiter must allocate by fused rank.
    //
    // FTS lane order:    [a(0.50), b(0.49), c(0.10)]
    // Vector lane order: [a(0.51), b(0.50), c(0.99)]   ← c has the top RAW score
    // RRF (k=60): a appears rank-1/rank-1, b rank-2/rank-2, c rank-3/rank-3.
    //   → fused order is [a, b, c]; b OUTRANKS c despite c's 0.99 raw score.
    const ftsLane: FusionLane = {
      results: [result("a", 0.5), result("b", 0.49), result("c", 0.1)],
      weight: 1.0,
    };
    const vecLane: FusionLane = {
      results: [result("a", 0.51), result("b", 0.5), result("c", 0.99)],
      weight: 1.0,
    };
    // Pool fits only ONE LTM candidate (each 50 tokens; pool 60 leaves room for one
    // after the per-tier accounting). Assert the fused-rank leader (a) is allocated
    // and the raw-score leader (c) is NOT.
    const out = marginArbitrate({
      historyItems: [],
      ltmCandidates: [ftsLane, vecLane],
      kgCandidates: [],
      floors: NO_FLOORS,
      poolTokens: 60,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
      // 50 tokens per LTM candidate (so only one fits in the 60 pool).
      ltmTokensPerCandidate: 50,
    });
    const keptIds = out.keptLtmIds ?? [];
    expect(keptIds).toContain("a"); // fused-rank leader allocated
    expect(keptIds).not.toContain("c"); // raw-score leader (0.99) NOT allocated
  });

  it("Test 6: purity — the input arrays and their items are NOT mutated", () => {
    const history: BudgetItem[] = [item("h1", 40), item("h2", 40)];
    const lane: FusionLane = { results: [result("ltm1", 0.9)], weight: 1.0 };
    const historySnapshot = JSON.parse(JSON.stringify(history.map((h) => ({ t: textOf(h.msg), tk: h.tokens }))));
    const laneSnapshot = JSON.parse(JSON.stringify(lane.results.map((r) => ({ id: r.entry.id, s: r.score }))));

    marginArbitrate({
      historyItems: history,
      ltmCandidates: [lane],
      kgCandidates: [],
      floors: NO_FLOORS,
      poolTokens: 30,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });

    expect(history.map((h) => ({ t: textOf(h.msg), tk: h.tokens }))).toEqual(historySnapshot);
    expect(lane.results.map((r) => ({ id: r.entry.id, s: r.score }))).toEqual(laneSnapshot);
  });

  it("Test 7: an empty pool keeps only the unconditional floors (no discretionary fill)", () => {
    const pinned = item("CANARY", 10);
    const middle = item("m1", 10);
    const out = marginArbitrate({
      historyItems: [pinned, middle],
      ltmCandidates: [{ results: [result("ltm1", 0.9)], weight: 1.0 }],
      kgCandidates: [],
      floors: { freshTailItems: [], pinnedItems: [pinned] },
      poolTokens: 0,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    const keptTexts = out.kept.map(textOf);
    expect(keptTexts).toContain("CANARY"); // floor survives a 0 pool
    expect(keptTexts).not.toContain("m1"); // nothing discretionary fits
    expect(out.perTierKept.ltm).toBe(0); // no LTM allocated with a 0 pool
  });

  it("a pinned tool_use mid-step keeps its trailing toolResult whole AND bills poolTokensUsed exactly", () => {
    // The accounting/atomicity gap: with security pins filtered at MESSAGE granularity, a
    // pinned assistant `tool_use` whose `toolResult` is NOT itself pinned orphans a
    // half-step — the toolResult is left in the relevance-evictable middle band, where
    // the step grouper mis-binds it to the OLDER message and either drops it (splitting a
    // pinned pair) or mis-counts the kept tail, so `poolTokensUsed` is off.
    //
    // History (oldest → newest):
    //   h_old(50)                — an ordinary, evictable middle-band message
    //   assistant tool_use(10)   — SECURITY-PINNED (a floor)
    //   tr1(50)                  — its toolResult (NOT separately pinned)
    // Pool = 50.
    //
    // STEP-correct behavior: the pinned tool_use's STEP is [tool_use, tr1] → the WHOLE
    // step is a floor (both kept unconditionally, neither a relevance candidate). The
    // middle band is just [h_old]; the 50-token pool keeps it. So poolTokensUsed = 50
    // (h_old only — floors ride on top) and tr1 SURVIVES with its pinned tool_use.
    //
    // Under message-granularity pinning: pinnedItems=[tool_use] only;
    // middleBand=[h_old, tr1]; groupIntoSteps mis-binds tr1 to h_old → one 100-token step
    // that does NOT fit the 50 pool → keptMiddle=[] → poolTokensUsed=0 and tr1 is DROPPED
    // (the pinned tool_use's result orphaned). Both assertions below would fail.
    const hOld = item("h_old", 50);
    const pinnedToolUse = item("PINNED-tool-use", 10, "assistant");
    const tr1 = toolResultItem("tr1-result", 50);
    const history: BudgetItem[] = [hOld, pinnedToolUse, tr1];
    const out = marginArbitrate({
      historyItems: history,
      ltmCandidates: [],
      kgCandidates: [],
      floors: { freshTailItems: [], pinnedItems: [pinnedToolUse] }, // ONLY the tool_use is flagged
      poolTokens: 50,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    const keptTexts = out.kept.map(textOf);
    // The pinned tool_use's toolResult must survive WITH it (step kept whole — no orphan).
    expect(keptTexts).toContain("PINNED-tool-use");
    expect(keptTexts).toContain("tr1-result");
    // h_old fits the 50-token middle-band pool.
    expect(keptTexts).toContain("h_old");
    // poolTokensUsed counts the discretionary (non-floor) tokens EXACTLY: h_old = 50.
    // The pinned step (tool_use + tr1) is a floor and rides on top (not billed).
    const floorTexts = new Set(["PINNED-tool-use", "tr1-result"]);
    const expectedUsed = trueKeptMiddleTokens(out.kept, history, floorTexts);
    expect(expectedUsed).toBe(50); // sanity: the true middle-band consumption
    expect(out.poolTokensUsed).toBe(expectedUsed);
  });

  it("poolTokensUsed never exceeds the pool even with a mid-step pin (no over-billing)", () => {
    // A complementary invariant: whatever the step boundaries, the discretionary
    // accounting stays bounded by the pool (the arbiter's budget bound).
    const pinnedToolUse = item("PIN-tu", 10, "assistant");
    const tr = toolResultItem("tr", 30);
    const h1 = item("h1", 40);
    const h2 = item("h2", 40);
    const history: BudgetItem[] = [h1, pinnedToolUse, tr, h2];
    const out = marginArbitrate({
      historyItems: history,
      ltmCandidates: [],
      kgCandidates: [],
      floors: { freshTailItems: [], pinnedItems: [pinnedToolUse] },
      poolTokens: 60,
      scorer: scoreRelevance,
      query: HEALTHY_QUERY,
    });
    expect(out.poolTokensUsed).toBeLessThanOrEqual(60);
    // And it equals the true kept non-floor (membership) sum — the exact-accounting claim.
    const floorTexts = new Set(["PIN-tu", "tr"]);
    expect(out.poolTokensUsed).toBe(trueKeptMiddleTokens(out.kept, history, floorTexts));
  });
});
