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
import type { MemorySearchResult } from "@comis/core";
import {
  recallAtK,
  meanReciprocalRank,
  scoreRanking,
  compareRankings,
} from "./recall-eval.js";
import {
  RECALL_EVAL_FIXTURES,
  TEMPORAL_EVAL_FIXTURES,
  ENTITY_EVAL_FIXTURES,
  entityLane,
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
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0.5, proofAlpha: 0, trustAlpha: 0 }, EVAL_NOW);
  // NEUTRAL guard ranker: same score() path but temporalAlpha 0 → temporalFactor ≡ 1.0,
  // so the boosted order collapses back to the base (= fusion) order.
  const neutralFn = (q: EvalQuery): MemorySearchResult[] =>
    score(q.candidates, { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 }, EVAL_NOW);

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
