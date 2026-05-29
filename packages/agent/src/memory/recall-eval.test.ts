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
  type EvalQuery,
} from "./__fixtures__/recall-eval-fixtures.js";
import { fuse } from "../rag/fuse.js";
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
