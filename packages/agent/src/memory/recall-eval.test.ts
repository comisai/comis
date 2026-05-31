// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the LongMemEval-style recall eval harness (EVAL-01).
 *
 * TIER SPLIT (resolves RESEARCH Open Question 4):
 * - UNGATED: the deterministic scorer math (recallAtK / meanReciprocalRank /
 *   scoreRanking / compareRankings) is pure and belongs in the default CI tier.
 *   It imports BOTH recall-eval.ts AND the fixtures so neither file is
 *   0%-coverage under the all:true agent floor.
 * - GATED: the real-model recall-LIFT measurement is gated behind
 *   LLAMA_RERANKER_MODEL_PATH (describe.skipIf) — it loads a ~606MB GGUF and is
 *   skipped in the default `pnpm test` run. No LLM judge in CI (non-deterministic).
 *
 * ARCHITECTURE: this *.test.ts MAY import createLocalRerankerProvider from
 * @comis/memory (devDependency; the agent->memory architecture cut excludes
 * .test.ts via findForbiddenImports' suffix filter). The production
 * recall-eval.ts imports ONLY @comis/core types + ../rag/fuse.js.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { MemorySearchResult, UsefulnessSignal } from "@comis/core";
import {
  recallAtK,
  meanReciprocalRank,
  scoreRanking,
  compareRankings,
} from "./recall-eval.js";
import {
  RECALL_EVAL_FIXTURES,
  TEMPORAL_EVAL_FIXTURES,
  TEMPORAL_TRUST_EVAL_FIXTURES,
  ENTITY_EVAL_FIXTURES,
  FEEDBACK_EVAL_FIXTURES,
  PROOF_EVAL_FIXTURES,
  LANES_EVAL_FIXTURES,
  entityLane,
  ftsLane,
  vectorLane,
  preFusedOrder,
  usefulnessByIdFor,
  EVAL_NOW,
  type EvalQuery,
} from "./__fixtures__/recall-eval-fixtures.js";
import { fuse } from "../rag/fuse.js";
import { score } from "../rag/score.js";
// GATED import (test-only; agent->memory cut excludes *.test.ts).
import { createLocalRerankerProvider } from "@comis/memory";

const RERANKER_MODEL = process.env.LLAMA_RERANKER_MODEL_PATH;

/** Build a bare MemorySearchResult with just the id populated (scorer only reads entry.id). */
function res(id: string): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "user_a",
      content: id,
      trustLevel: "learned",
      source: { who: "user_a" },
      tags: [],
      createdAt: 1_700_000_000_000,
    },
  };
}

describe("recallAtK (deterministic recall@k)", () => {
  it("returns 0.5 when half the relevant ids fall inside the top-k window", () => {
    // relevant={a,b}, ranked=[c,a,d,b]; top-2=[c,a] -> intersect {a} -> 1/2.
    expect(recallAtK(["c", "a", "d", "b"], ["a", "b"], 2)).toBe(0.5);
  });

  it("returns 1.0 when the top-k window contains every relevant id", () => {
    // top-4=[c,a,d,b] -> intersect {a,b} -> 2/2.
    expect(recallAtK(["c", "a", "d", "b"], ["a", "b"], 4)).toBe(1);
  });

  it("returns 0 when no relevant id appears in the top-k window", () => {
    // relevant={a}, ranked=[b,c] -> intersect {} -> 0/1.
    expect(recallAtK(["b", "c"], ["a"], 2)).toBe(0);
  });

  it("counts each relevant id at most once and ignores duplicate ranked ids", () => {
    // relevant={a}, ranked=[a,a,a]; intersection size is 1, not 3 -> 1/1.
    expect(recallAtK(["a", "a", "a"], ["a"], 3)).toBe(1);
  });

  it("returns 0 for an empty relevant set (no ground truth to recall)", () => {
    expect(recallAtK(["a", "b"], [], 2)).toBe(0);
  });
});

describe("meanReciprocalRank (deterministic MRR)", () => {
  it("yields RR 1.0 when the first relevant id is at rank 1", () => {
    expect(meanReciprocalRank([["a", "b", "c"]], [["a"]])).toBe(1);
  });

  it("yields RR 1/3 when the first relevant id is at rank 3", () => {
    expect(meanReciprocalRank([["x", "y", "a"]], [["a"]])).toBeCloseTo(1 / 3, 10);
  });

  it("yields RR 0 when no relevant id is present in the ranked list", () => {
    expect(meanReciprocalRank([["x", "y", "z"]], [["a"]])).toBe(0);
  });

  it("macro-averages reciprocal rank across multiple queries", () => {
    // Q1 first relevant @1 -> 1.0; Q2 first relevant @3 -> 1/3; mean = (1 + 1/3)/2.
    expect(
      meanReciprocalRank(
        [
          ["a", "b", "c"],
          ["x", "y", "b"],
        ],
        [["a"], ["b"]],
      ),
    ).toBeCloseTo((1 + 1 / 3) / 2, 10);
  });
});

describe("scoreRanking (macro-averaged recall@1/3/5 + MRR over fixtures)", () => {
  it("computes perfect metrics when the rankFn surfaces every relevant id at rank 1", () => {
    const perfect = (q: EvalQuery): MemorySearchResult[] =>
      // put the relevant id first, distractors after.
      [
        ...q.relevantIds.map(res),
        ...q.candidates.filter((c) => !q.relevantIds.includes(c.entry.id)),
      ];
    const m = scoreRanking(RECALL_EVAL_FIXTURES, perfect);
    expect(m.recallAt1).toBe(1);
    expect(m.recallAt3).toBe(1);
    expect(m.recallAt5).toBe(1);
    expect(m.mrr).toBe(1);
  });

  it("reflects a partial recall@1 when the rankFn preserves the (mis-ranked) candidate order", () => {
    // Identity rankFn = the candidate (fusion) order as authored.
    const identity = (q: EvalQuery): MemorySearchResult[] => q.candidates;
    const m = scoreRanking(RECALL_EVAL_FIXTURES, identity);
    // Two of three fixtures mis-rank the relevant id below rank 1 by design.
    expect(m.recallAt1).toBeCloseTo(1 / 3, 10);
    // All relevant ids sit within the top-3 candidate pool -> recall@3 = 1.0.
    expect(m.recallAt3).toBe(1);
  });
});

describe("scoreRanking over the FUSION-ONLY baseline (lift headroom)", () => {
  it("leaves recall@1 below 1.0, proving the fixtures contain a fusion mis-rank to rescue", () => {
    const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
      fuse([{ results: q.candidates, weight: 1 }]);
    const m = scoreRanking(RECALL_EVAL_FIXTURES, fusionFn);
    // If fusion already nailed recall@1 there would be no lift to measure.
    expect(m.recallAt1).toBeLessThan(1);
    // Specifically 1/3: only the already-ordered Q3 is correct @1.
    expect(m.recallAt1).toBeCloseTo(1 / 3, 10);
  });
});

describe("compareRankings (reranked vs fusion lift report)", () => {
  it("reports a strictly positive recall@1 lift when reranking rescues fusion mis-ranks", () => {
    const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
      fuse([{ results: q.candidates, weight: 1 }]);
    // Oracle "reranker": surfaces the relevant id first (what a perfect CE would do).
    const oracleFn = (q: EvalQuery): MemorySearchResult[] => [
      ...q.relevantIds.map(res),
      ...q.candidates.filter((c) => !q.relevantIds.includes(c.entry.id)),
    ];
    const report = compareRankings(RECALL_EVAL_FIXTURES, fusionFn, oracleFn);
    expect(report.baseline.recallAt1).toBeCloseTo(1 / 3, 10);
    expect(report.reranked.recallAt1).toBe(1);
    expect(report.recallAt1Lift).toBeGreaterThan(0);
    expect(report.recallAt1Lift).toBeCloseTo(1 - 1 / 3, 10);
    expect(report.mrrLift).toBeGreaterThan(0);
  });

  it("reports zero lift (no regression) when reranked order equals fusion order", () => {
    const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
      fuse([{ results: q.candidates, weight: 1 }]);
    const report = compareRankings(RECALL_EVAL_FIXTURES, fusionFn, fusionFn);
    expect(report.recallAt1Lift).toBe(0);
    expect(report.mrrLift).toBe(0);
  });
});

// UNGATED temporal-boost lift (EVAL-01, per-phase temporal figure). Deterministic
// pure math (score() over fixed-epoch occurredAt; no model, no LLM judge) — runs in
// the default `pnpm test`. The temporal boost (score with temporalAlpha>0, plan 02)
// must score a strictly positive recall@1 gain over the Phase-80 fusion-only baseline
// on the "temporal" group, and a NEUTRAL guard (temporalAlpha 0 → zero lift) attributes
// the gain to the temporal signal — not to score()'s other mechanics (T-81-12).
describe("temporal boost lift (recall@1 over fusion baseline)", () => {
  // Phase-80 baseline: single-lane fuse() is order-preserving → fusion order = the
  // candidates' base/score order (the stale distractor first by design).
  const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([{ results: q.candidates, weight: 1 }]);
  // Temporal boost ISOLATED: temporalAlpha>0, every other alpha 0 — so the only signal
  // moving the ranking is occurredAt proximity (plan-02 temporalProx).
  const temporalFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0.5, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 }, EVAL_NOW);
  // NEUTRAL guard ranker: same score() path but temporalAlpha 0 → temporalFactor ≡ 1.0,
  // so the boosted order collapses back to the base (= fusion) order.
  const neutralFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 }, EVAL_NOW);

  it("carries a non-empty temporal fixture group", () => {
    expect(TEMPORAL_EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(TEMPORAL_EVAL_FIXTURES.every((q) => q.group === "temporal")).toBe(true);
  });

  it("scores a strictly positive recall@1 lift over the Phase-80 fusion baseline", () => {
    const report = compareRankings(TEMPORAL_EVAL_FIXTURES, fusionFn, temporalFn);
    // Headroom: fusion mis-ranks the stale distractor to rank 1 (T-81-12 — a no-op
    // fixture that fusion already nailed would leave nothing to measure).
    expect(report.baseline.recallAt1, JSON.stringify(report)).toBeLessThan(1);
    // The EVAL-01 per-phase temporal figure: the boost is a MEASURABLE recall@1 gain.
    expect(report.recallAt1Lift, JSON.stringify(report)).toBeGreaterThan(0);
    // No regression: the boost never lowers recall@1 below fusion.
    expect(report.reranked.recallAt1, JSON.stringify(report)).toBeGreaterThanOrEqual(
      report.baseline.recallAt1,
    );
  });

  it("yields ZERO lift at temporalAlpha 0 (the gain is attributable to the temporal signal)", () => {
    // T-81-12 neutral guard: with the temporal signal off, score()'s remaining
    // mechanics produce the fusion order → no lift. So the positive lift above is the
    // temporal boost's work, not a fixture that trivially favors the relevant id.
    const report = compareRankings(TEMPORAL_EVAL_FIXTURES, fusionFn, neutralFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });
});

// UNGATED entity-association lift (EVAL-01, the per-phase entity figure / criterion 5).
// Deterministic pure fusion math — NO live DB, NO associativeLane port, NO model. The
// entity lane is MODELED here as a 2nd fuse() lane built from the fixtures (the
// shared-entity neighbour subset surfaced first via `entityLane(q)`), so the lift is
// reproducible from the fixtures alone. The entity lane (added as a 2nd fusion lane)
// must score a strictly positive recall@1 gain over the prior (fusion-only) baseline on
// the "entity" group, and a NEUTRAL guard (an EMPTY 2nd lane → RRF unchanged → zero
// lift) attributes the gain to the entity lane — not to fuse()'s rank rebasing alone
// (mirrors the Phase-81 temporalAlpha=0 guard; T-83-19).
describe("entity-association lift (recall@1 over fusion baseline)", () => {
  // Prior-phase baseline: single-lane fuse() is order-preserving → fusion order = the
  // candidates' base/score order (the lexical distractor first by design).
  const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([{ results: q.candidates, weight: 1 }]);
  // Entity lane MODELED as a 2nd fusion lane: the shared-entity neighbour subset for
  // this query, relevant-first. RRF sums the relevant id's two lane terms over the
  // distractor's single term → the relevant memory is lifted to rank 1.
  const withLaneFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([
      { results: q.candidates, weight: 1 },
      { results: entityLane(q), weight: 1 },
    ]);
  // NEUTRAL guard ranker: the same two-lane shape but the entity lane is EMPTY, so RRF
  // sees only the candidates lane and the fused order collapses back to fusion order.
  const neutralFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([
      { results: q.candidates, weight: 1 },
      { results: [], weight: 1 },
    ]);

  it("carries a non-empty entity fixture group", () => {
    expect(ENTITY_EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(ENTITY_EVAL_FIXTURES.every((q) => q.group === "entity")).toBe(true);
  });

  it("scores a strictly positive recall@1 lift over the fusion-only baseline", () => {
    const report = compareRankings(ENTITY_EVAL_FIXTURES, fusionFn, withLaneFn);
    // Headroom: fusion mis-ranks the lexical distractor to rank 1 (T-83-19 — a no-op
    // fixture that fusion already nailed would leave nothing to measure).
    expect(report.baseline.recallAt1, JSON.stringify(report)).toBeLessThan(1);
    // The EVAL-01 per-phase entity figure (criterion 5): the entity lane is a
    // MEASURABLE recall@1 gain over the prior fusion-only baseline.
    expect(report.recallAt1Lift, JSON.stringify(report)).toBeGreaterThan(0);
    // No regression: the entity lane never lowers recall@1 below fusion.
    expect(report.reranked.recallAt1, JSON.stringify(report)).toBeGreaterThanOrEqual(
      report.baseline.recallAt1,
    );
  });

  it("yields ZERO lift with an EMPTY entity lane (the gain is attributable to the entity lane)", () => {
    // T-83-19 neutral guard: with the entity lane empty, RRF over the lone candidates
    // lane reproduces the fusion order → no lift. So the positive lift above is the
    // entity lane's work, not fuse()'s rank rebasing on a fixture that already favored
    // the relevant id.
    const report = compareRankings(ENTITY_EVAL_FIXTURES, fusionFn, neutralFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });
});

// UNGATED trust-first contradiction lift (CONTRA-02, the per-phase trust figure). The
// `temporal` group's TRUST case: a NEWER LOW-trust claim carries the HIGHER fusion score
// (it would win on recency/lexical alone) and an OLDER HIGHER-trust fact carries the LOWER
// fusion score. Ranked through the EXISTING score() trust lever (trustAlpha>0, every other
// alpha 0; score.ts UNCHANGED — trustWeight system 1.0 / learned 0.5 / external 0.0), the
// higher-trust fact must be lifted to rank 1 — a newer low-trust claim does NOT supersede an
// older higher-trust fact (the Hindsight latest-mentioned-wins anti-pattern). A NEUTRAL guard
// (trustAlpha 0 → trustFactor ≡ 1.0) attributes the gain to TRUST, and a dedicated
// zero-regression assertion proves trust-first does NOT disturb the existing recency-only
// T1/T2 cases (all `learned` → uniform trust boost → no reorder). Deterministic pure math
// (fixed-epoch EVAL_NOW; no model, no LLM judge) — runs in the default `pnpm test`.
describe("trust-first contradiction lift (recall@1 over fusion baseline)", () => {
  // Phase-80 baseline: single-lane fuse() is order-preserving → fusion order = the
  // candidates' base/score order (the newer LOW-trust claim first by design).
  const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([{ results: q.candidates, weight: 1 }]);
  // Trust boost ISOLATED: trustAlpha>0, every other alpha 0 — so the only signal moving the
  // ranking is the trust tier (system > learned > external via score.ts trustWeight).
  const trustFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0.5, usefulnessAlpha: 0 }, EVAL_NOW);
  // NEUTRAL guard ranker: same score() path but trustAlpha 0 → trustFactor ≡ 1.0, so the
  // boosted order collapses back to the base (= fusion) order.
  const neutralFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 }, EVAL_NOW);

  it("carries a non-empty trust fixture group (all group 'temporal')", () => {
    expect(TEMPORAL_TRUST_EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(TEMPORAL_TRUST_EVAL_FIXTURES.every((q) => q.group === "temporal")).toBe(true);
  });

  it("ranks the older higher-trust fact above the newer lower-trust claim at recall@1", () => {
    const report = compareRankings(TEMPORAL_TRUST_EVAL_FIXTURES, fusionFn, trustFn);
    // Headroom: fusion ranks the newer LOW-trust claim @1 (Pitfall 2 — a no-op fixture that
    // fusion already nailed would leave nothing to measure).
    expect(report.baseline.recallAt1, JSON.stringify(report)).toBeLessThan(1);
    // The CONTRA-02 trust figure: trust rescues the higher-trust fact to rank 1.
    expect(report.recallAt1Lift, JSON.stringify(report)).toBeGreaterThan(0);
    // No regression: the trust boost never lowers recall@1 below fusion.
    expect(report.reranked.recallAt1, JSON.stringify(report)).toBeGreaterThanOrEqual(
      report.baseline.recallAt1,
    );
  });

  it("yields ZERO lift at trustAlpha 0 (the gain is attributable to trust)", () => {
    // Neutral guard: with the trust signal off, score()'s remaining mechanics produce the
    // fusion order → no lift. So the positive lift above is the trust boost's work.
    const report = compareRankings(TEMPORAL_TRUST_EVAL_FIXTURES, fusionFn, neutralFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });

  it("does NOT disturb the existing recency-only temporal cases (zero regression)", () => {
    // The existing T1/T2 cases are all `learned` → a uniform trust boost factor → no reorder.
    // Trust-first must leave the pure recency cases byte-stable in ranking (success criterion 2).
    const report = compareRankings(TEMPORAL_EVAL_FIXTURES, fusionFn, trustFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    // Mirror the sibling lift tests' dual guard (WR-01): recallAt1Lift === 0 alone equals full
    // rank-1 invariance only while each T1/T2 fixture has 2 candidates; the MRR guard pins
    // no-reorder BELOW rank 1 too, so a future 3+-candidate sub-rank-1 reorder still trips it.
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });
});

// UNGATED recall-utility feedback lift (FEED-04, the per-phase feedback figure). The
// repeat-query scenario: a memory the agent USED at turn 1 (usedCount >= 1, ignoredCount 0)
// is offered again at a turn-2 repeat query carrying the LOWER fusion score (a distractor with
// no/negative usefulness carries the HIGHER fusion score). Ranked through the LIVE score()
// usefulness lever (usefulnessAlpha>0, every other alpha 0; the FEED-03 fifth factor), the
// proven-useful memory must be lifted to rank 1 — the recall layer LEARNS from outcomes (the
// leapfrog vs Hindsight's dead access_count). Three guards prove the gain is attributable to
// feedback, not to the fixture or the map's mere presence:
//   - usefulnessAlpha:0 (signal supplied, weight 0) → usefulnessFactor ≡ 1.0 → ZERO lift.
//   - NO usefulnessById arg (the default-off / absent-signal path) → usefulnessNorm(undefined)
//     0.5 → factor exactly 1.0 even at a HIGH alpha → ZERO lift (the score.ts #1 byte-identity
//     guard, exercised end-to-end through the eval).
//   - the feedback ranker over an EXISTING group (no usefulness map) → ZERO lift / no regression.
// Deterministic pure math (fixed-epoch EVAL_NOW; no model, no LLM judge) — runs in default
// `pnpm test`. Mirrors the CONTRA-02 trust dual-guard (recall-eval.test.ts trustAlpha:0 above).
describe("recall-utility feedback lift (recall@1 over fusion baseline)", () => {
  // Phase-80 baseline: single-lane fuse() is order-preserving → fusion order = the
  // candidates' base/score order (the distractor with the HIGHER base first by design).
  const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([{ results: q.candidates, weight: 1 }]);
  // Usefulness boost ISOLATED: usefulnessAlpha>0, every other alpha 0 — the only signal moving
  // the ranking is the per-memory used-rate, supplied via the usefulnessById map handed to
  // score() (NOT a new EvalQuery field — the cut stays clean).
  const feedbackFn = (q: EvalQuery): MemorySearchResult[] =>
    score(
      q.candidates,
      { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0.5 },
      EVAL_NOW,
      usefulnessByIdFor(q),
    );
  // NEUTRAL guard: same map supplied, but usefulnessAlpha 0 → usefulnessFactor ≡ 1.0, so the
  // boosted order collapses back to the base (= fusion) order. The gain is the WEIGHT's work.
  const feedbackNeutralFn = (q: EvalQuery): MemorySearchResult[] =>
    score(
      q.candidates,
      { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
      EVAL_NOW,
      usefulnessByIdFor(q),
    );
  // DEFAULT-OFF / absent-signal guard: a HIGH usefulnessAlpha but NO usefulnessById arg (4th arg
  // omitted) → every usefulnessNorm(undefined) is 0.5 → usefulnessFactor exactly 1.0 → ZERO lift.
  // This is the score.ts #1 byte-identity guard proven end-to-end through the eval.
  const feedbackNoSignalFn = (q: EvalQuery): MemorySearchResult[] =>
    score(
      q.candidates,
      { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0.5 },
      EVAL_NOW,
    );

  it("carries a non-empty feedback fixture group (all group 'feedback')", () => {
    expect(FEEDBACK_EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(FEEDBACK_EVAL_FIXTURES.every((q) => q.group === "feedback")).toBe(true);
  });

  it("lifts a turn-1-used memory to recall@1 over the fusion baseline (the repeat-query gain)", () => {
    const report = compareRankings(FEEDBACK_EVAL_FIXTURES, fusionFn, feedbackFn);
    // Headroom: fusion ranks the higher-base distractor @1 (a no-op fixture that fusion already
    // nailed would leave nothing to measure).
    expect(report.baseline.recallAt1, JSON.stringify(report)).toBeLessThan(1);
    // The FEED-04 figure: the proven-useful memory is rescued to rank 1 on the repeat query.
    expect(report.recallAt1Lift, JSON.stringify(report)).toBeGreaterThan(0);
    // No regression: the usefulness boost never lowers recall@1 below fusion.
    expect(report.reranked.recallAt1, JSON.stringify(report)).toBeGreaterThanOrEqual(
      report.baseline.recallAt1,
    );
  });

  it("yields ZERO lift at usefulnessAlpha 0 (the gain is attributable to feedback)", () => {
    // Signal supplied but weighted 0 → factor 1.0 → fusion order. So the positive lift above is
    // the usefulness boost's work, not a fixture that trivially favors the relevant id.
    const report = compareRankings(FEEDBACK_EVAL_FIXTURES, fusionFn, feedbackNeutralFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });

  it("yields ZERO lift with NO usefulness signal even at a high alpha (default-off byte-identity)", () => {
    // The score.ts #1 guard end-to-end: an absent usefulnessById → usefulnessNorm(undefined) 0.5
    // → usefulnessFactor exactly 1.0 at ANY alpha → no reorder. This is the default-off path
    // (feedback.enabled=false → recall never reads the signal → usefulnessById undefined).
    const report = compareRankings(FEEDBACK_EVAL_FIXTURES, fusionFn, feedbackNoSignalFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });

  it("does NOT disturb the existing reranking group (zero regression)", () => {
    // The existing RECALL_EVAL_FIXTURES carry no usefulness map → usefulnessByIdFor returns an
    // empty map → every factor 1.0 → no reorder. Feedback must leave the prior groups byte-stable.
    const report = compareRankings(RECALL_EVAL_FIXTURES, fusionFn, feedbackFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });
});

// UNGATED proof-accrual lift (FOLD-03, the per-phase proof figure). The cross-run
// corroboration scenario: a fact corroborated across MULTIPLE consolidation runs (a high
// proofCount, freshly re-corroborated → recent occurredAt, confidence 1) is offered against a
// ONE-OFF mention (a raw with no proofCount → neutral) carrying the HIGHER fusion score. Ranked
// through the LIVE score() proof lever (proofAlpha>0, every other alpha 0; the CONS-08 proof log
// curve × confidence half-life — score.ts UNCHANGED), the corroborated observation must be lifted
// to rank 1 — accrued proof OUT-RANKS a one-off mention (HINDSIGHT_VS_COMIS.md N2 PARITY: the
// fold path grows proof_count, and this proves the read side rewards it). Three guards prove the
// gain is attributable to proofAlpha, not to the fixture:
//   - proofAlpha:0 (proofCount present, weight 0) → proofFactor ≡ 1.0 → ZERO lift (the dual guard).
//   - equal-proof — covered by the neutral guard: with the weight off the higher-base one-off stays
//     at rank 1, so the lift is the proof boost's work, not a fixture that trivially favors the id.
//   - the proof ranker over the EXISTING reranking group (no proofCount → proofNorm 0.5 → factor
//     1.0) → ZERO lift / no regression.
// Deterministic pure math (fixed-epoch EVAL_NOW; no model, no LLM judge) — runs in default
// `pnpm test`. Mirrors the CONTRA-02 trust + FEED-04 feedback dual-guards above.
describe("proof-accrual lift (recall@1 over fusion baseline)", () => {
  // Phase-80 baseline: single-lane fuse() is order-preserving → fusion order = the
  // candidates' base/score order (the higher-base one-off mention first by design).
  const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([{ results: q.candidates, weight: 1 }]);
  // Proof boost ISOLATED: proofAlpha>0, every other alpha 0 — the only signal moving the ranking
  // is the per-observation decayedProof (proofNorm log curve × confidence half-life over occurredAt,
  // score.ts:166-198). The corroboration signal rides each candidate's entry (proofCount/confidence/
  // occurredAt) — NOT a side map (unlike feedback) and NOT a new EvalQuery field (the cut stays clean).
  const proofFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0.5, trustAlpha: 0, usefulnessAlpha: 0 }, EVAL_NOW);
  // NEUTRAL guard: same score() path but proofAlpha 0 → proofFactor ≡ 1.0, so the boosted order
  // collapses back to the base (= fusion) order. The gain is the WEIGHT's work, not the fixture's.
  const neutralFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 }, EVAL_NOW);

  it("carries a non-empty proof fixture group (all group 'proof')", () => {
    expect(PROOF_EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(PROOF_EVAL_FIXTURES.every((q) => q.group === "proof")).toBe(true);
  });

  it("lifts a cross-run-corroborated observation to recall@1 over the fusion baseline (proof out-ranks a one-off)", () => {
    const report = compareRankings(PROOF_EVAL_FIXTURES, fusionFn, proofFn);
    // Headroom: fusion ranks the higher-base one-off mention @1 (a no-op fixture that fusion already
    // nailed would leave nothing to measure).
    expect(report.baseline.recallAt1, JSON.stringify(report)).toBeLessThan(1);
    // The FOLD-03 figure: the corroborated observation is rescued to rank 1 — accrued proof wins.
    expect(report.recallAt1Lift, JSON.stringify(report)).toBeGreaterThan(0);
    // No regression: the proof boost never lowers recall@1 below fusion.
    expect(report.reranked.recallAt1, JSON.stringify(report)).toBeGreaterThanOrEqual(
      report.baseline.recallAt1,
    );
  });

  it("yields ZERO lift at proofAlpha 0 (the gain is attributable to proof)", () => {
    // The dual guard: with the proof signal off, score()'s remaining mechanics produce the fusion
    // order → no lift. So the positive lift above is the proof boost's work, not a fixture that
    // trivially favors the relevant id.
    const report = compareRankings(PROOF_EVAL_FIXTURES, fusionFn, neutralFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });

  it("does NOT disturb the existing reranking group (zero regression)", () => {
    // The existing RECALL_EVAL_FIXTURES carry no proofCount → proofNorm 0.5 → every proof factor 1.0
    // → no reorder. Proof-accrual must leave the prior groups byte-stable in ranking.
    const report = compareRankings(RECALL_EVAL_FIXTURES, fusionFn, proofFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });
});

// CONSOLIDATED default-off byte-identity (FEED-04 seam c, Pitfall 6). The recall-utility
// feedback loop is opt-in (rag.feedback.enabled default false, Plan 93-04 schema). When OFF the
// path is byte-behavior-identical to v2.6 via FOUR flag-gated guards, each pinned by a
// characterization in the plan it shipped in:
//   #1 score.ts — usefulnessNorm(undefined) === 0.5 → usefulnessFactor exactly 1.0 at any alpha
//      (93-03 score.test.ts; re-proven end-to-end by feedbackNoSignalFn above).
//   #2 memory-recall.ts — flag-off OR no store OR empty ranked → the readUsefulness call is
//      SKIPPED → usefulnessById stays undefined → neutral factor (93-03 memory-recall.test.ts).
//   #3 executor-post-execution.ts — flag-off → turn-end attribution + memory:recall_used emit
//      are SKIPPED → no event (93-02 executor-post-execution.test.ts).
//   #4 setup-memory-usefulness-wiring.ts — feedbackEnabled() false → the subscriber no-ops →
//      no recordUsage write (93-02 setup-memory-usefulness-wiring.test.ts).
// The test below NAMES the byte-identity contract over the feedback fixtures; the four guards
// above pin each gate at its site.
describe("default-off feedback recall is byte-identical to the pre-feedback fusion path", () => {
  const fusionFn = (q: EvalQuery): MemorySearchResult[] =>
    fuse([{ results: q.candidates, weight: 1 }]);
  // The DEFAULT config path: feedback.enabled=false → memory-recall.ts skips the readUsefulness
  // call → usefulnessById is undefined at the scoring pass. Model that here as score() with NO
  // 4th arg (even at a high alpha, to prove the neutrality is the absent signal's, not a 0 alpha).
  const defaultOffFn = (q: EvalQuery): MemorySearchResult[] =>
    score(
      q.candidates,
      { recencyAlpha: 0.2, temporalAlpha: 0.2, proofAlpha: 0.1, trustAlpha: 0.1, usefulnessAlpha: 0.5 },
      EVAL_NOW,
    );

  it("ranks identically to fusion over the feedback fixtures (no read → neutral factor)", () => {
    // With feedback off the usefulness signal is never read; over these all-`learned`,
    // same-createdAt fixtures the remaining factors are uniform → the order is the fusion order.
    const report = compareRankings(FEEDBACK_EVAL_FIXTURES, fusionFn, defaultOffFn);
    expect(report.recallAt1Lift, JSON.stringify(report)).toBe(0);
    expect(report.mrrLift, JSON.stringify(report)).toBe(0);
  });
});

// GATED real-model lift test — skipped in the default `pnpm test` (no env var).
// Runs only when LLAMA_RERANKER_MODEL_PATH points to a GGUF cross-encoder.
describe.skipIf(!RERANKER_MODEL)("recall lift (real model)", () => {
  // The cross-encoder is async; scoreRanking's rankFn is sync. Pre-compute the
  // reranked order per query in beforeAll, then read the memoized order in a
  // sync closure (pattern (a) from the plan).
  const rerankedOrder = new Map<string, MemorySearchResult[]>();
  const rerankingFixtures = RECALL_EVAL_FIXTURES.filter((q) => q.group === "reranking");

  beforeAll(async () => {
    const built = await createLocalRerankerProvider({
      modelUri: RERANKER_MODEL!,
      modelsDir: "/tmp/comis-test-models",
      threads: 8,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reranker = built.value;

    for (const q of rerankingFixtures) {
      const docs = q.candidates.map((c) => c.entry.content);
      const scored = await reranker.rank(q.query, docs);
      expect(scored.ok).toBe(true);
      if (!scored.ok) continue;
      // CE score primary: re-sort candidates by the returned [0,1] scores.
      const order = q.candidates
        .map((c, i) => ({ ...c, score: scored.value[i] ?? 0 }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      rerankedOrder.set(q.query, order);
    }

    await reranker.dispose?.();
  }, 120_000);

  it("delivers a strictly positive recall@1 lift over the fusion-only baseline", () => {
    const baselineFn = (q: EvalQuery): MemorySearchResult[] =>
      fuse([{ results: q.candidates, weight: 1 }]);
    const rerankedFn = (q: EvalQuery): MemorySearchResult[] =>
      rerankedOrder.get(q.query) ?? q.candidates;

    const report = compareRankings(rerankingFixtures, baselineFn, rerankedFn);

    // No regression: reranking must never lower recall@1 vs fusion.
    expect(report.recallAt1Lift, JSON.stringify(report)).toBeGreaterThanOrEqual(0);
    // Measurable EVAL-01 gain: the labeled fusion mis-ranks are rescued.
    expect(
      report.reranked.recallAt1,
      JSON.stringify(report),
    ).toBeGreaterThan(report.baseline.recallAt1);
  });
});

// LANES-01 lane-split PARITY (the load-bearing regression guard). Today the memory
// adapter pre-fuses fts+vector via computeRRF(fts,vec,1.0,1.5) (k=60). After the unfuse,
// the agent builds two lanes and routes them through fuse() (k=60, same formula). The
// guard: with DEFAULT weights {fts:1.0, vector:1.5}, the 2-lane fused order is BYTE-FOR-BYTE
// identical to today's pre-fused order; a TUNED vector weight reorders (the weights are live).
describe("lane-split parity (default weights reproduce today's pre-fused order)", () => {
  it("carries a non-empty lanes fixture group with disagreeing lane orders", () => {
    expect(LANES_EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(LANES_EVAL_FIXTURES.every((q) => q.group === "lanes")).toBe(true);
    // The two lanes must DISAGREE on at least one fixture (else fusion is trivial).
    expect(LANES_EVAL_FIXTURES.some((q) => q.fts[0] !== q.vector[0])).toBe(true);
  });

  it("default-weight {fts:1.0, vector:1.5} fuse() == today's computeRRF pre-fused order BYTE-FOR-BYTE", () => {
    for (const q of LANES_EVAL_FIXTURES) {
      const fused = fuse([
        { results: ftsLane(q), weight: 1.0 },
        { results: vectorLane(q), weight: 1.5 },
      ]).map((r) => r.entry.id);
      const expected = preFusedOrder(q, 1.0, 1.5);
      expect(fused, `${q.query}: fuse() must reproduce computeRRF order`).toEqual(expected);
    }
  });

  it("a TUNED weight produces a DIFFERENT order on at least one fixture (weights are live)", () => {
    // The parity defaults {1.0,1.5} already let the vector lane's rank-1 (L2) lead LQ1
    // (vector weight 1.5 > fts 1.0). Tuning FTS to DOMINATE flips the leader to the FTS
    // lane's rank-1 (L1) — a DIFFERENT order, proving the weights are live (not cosmetic).
    const lq1 = LANES_EVAL_FIXTURES.find((q) => q.query === "deploy runbook")!;
    const parity = fuse([
      { results: ftsLane(lq1), weight: 1.0 },
      { results: vectorLane(lq1), weight: 1.5 },
    ]).map((r) => r.entry.id);
    expect(parity[0]).toBe("L2"); // vector dominates at the parity defaults
    const tuned = fuse([
      { results: ftsLane(lq1), weight: 5.0 },
      { results: vectorLane(lq1), weight: 0.1 },
    ]).map((r) => r.entry.id);
    expect(tuned).not.toEqual(parity);
    // With FTS dominating, the FTS lane's rank-1 (L1) leads the tuned order.
    expect(tuned[0]).toBe("L1");
  });

  it("an EMPTY vector lane dropped before fuse() preserves the FTS order (single-lane identity)", () => {
    // FTS-only degrade: a lone non-empty FTS lane must hit fuse()'s single-lane pass-through
    // (order + score preserved), NOT the multi-lane rank-ramp. The recall layer DROPS empty
    // lanes; here we model that by passing only the non-empty lane.
    const q = LANES_EVAL_FIXTURES[0]!;
    const ftsOnly = fuse([{ results: ftsLane(q), weight: 1.0 }]).map((r) => r.entry.id);
    expect(ftsOnly).toEqual(q.fts); // exact FTS order, no rebasing
  });
});
