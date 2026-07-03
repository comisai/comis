// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure recall-trace analyzer.
 *
 * TIER: default CI / fast unit tier (no model, no store, no live recall). The
 * analyzer is `analyzeRecallTrace(jsonlContent: string)` — a pure fold over the
 * recall-trace JSONL the CLI table view DISCARDED (it kept only
 * traceId/sessionKey/finalCount/ts; memory.ts:276-285). The hand-authored
 * fixture is read here with `readFileSync` (fs reads are fine in `.test.ts`);
 * the analyzer itself takes a STRING so it stays trivially testable and pure.
 *
 * Robustness (Test 5, the eval-integrity / DoS control): the fixture contains a
 * malformed (non-JSON) line AND a foreign/sentinel line (valid JSON that fails
 * the strict RecallTraceEventSchema) — both are SKIPPED, never thrown, never
 * folded (the daemon precedent at memory-handlers.ts:560-567).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { analyzeRecallTrace, argsortDiffers } from "./recall-trace-analyzer.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./__fixtures__/recall-trace-sample.jsonl", import.meta.url)),
  "utf-8",
);

describe("analyzeRecallTrace (rerank-outcome counts)", () => {
  it("folds the three rerank outcomes into per-outcome counters", () => {
    const view = analyzeRecallTrace(FIXTURE);
    expect(view.recalls).toBe(4);
    expect(view.rerankRan).toBe(2);
    expect(view.rerankFellBack).toBe(1);
    expect(view.rerankTimedOut).toBe(1);
  });
});

describe("analyzeRecallTrace (rerank-lift-realized)", () => {
  it("counts a ran recall whose post-order reorders pre-order, not one that preserves it", () => {
    const view = analyzeRecallTrace(FIXTURE);
    // Line 1: pre [0.9,0.1] -> post [0.1,0.9] reorders (lift realized).
    // Line 2: pre [0.9,0.5] -> post [0.8,0.4] preserves order (no lift).
    // rerankLiftRealized = liftRealizedCount / rerankRan = 1 / 2.
    expect(view.rerankLiftRealized).toBeCloseTo(0.5, 10);
  });

  it("yields 0 (never NaN) for rerankLiftRealized when no recall ran", () => {
    const onlyFellBack = JSON.stringify({
      traceSchema: "comis-recall-trace",
      schemaVersion: 1,
      ts: "2026-05-31T00:00:00.000Z",
      seq: 0,
      agentId: "bench",
      sessionId: "s",
      traceId: "t",
      queryDigest: "d",
      lanes: { fts: 1, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: true,
      fusedOrder: ["m1"],
      rerank: { outcome: "fell_back", candidateCount: 0 },
      ranked: [{ id: "m1", reason: "included" }],
      durationMs: 1,
    });
    const view = analyzeRecallTrace(onlyFellBack);
    expect(view.rerankRan).toBe(0);
    expect(view.rerankLiftRealized).toBe(0);
    expect(Number.isNaN(view.rerankLiftRealized)).toBe(false);
  });

  it("does NOT count a ran recall with unequal pre/post score lengths as realized lift", () => {
    // preScores/postScores are independently optional with NO cross-field
    // length invariant in the schema. A malformed producer emitting mismatched
    // lengths must NOT inflate rerankLiftRealized — a length mismatch is
    // malformed input, not an observed reordering. If argsortDiffers returned
    // true on a length mismatch, the "ran" path would count it as lift.
    const mismatched = JSON.stringify({
      traceSchema: "comis-recall-trace",
      schemaVersion: 1,
      ts: "2026-05-31T00:00:00.000Z",
      seq: 0,
      agentId: "bench",
      sessionId: "s",
      traceId: "t",
      queryDigest: "d",
      lanes: { fts: 2, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: true,
      fusedOrder: ["m1", "m2"],
      rerank: { outcome: "ran", candidateCount: 2, preScores: [0.9], postScores: [0.9, 0.1] },
      ranked: [{ id: "m1", reason: "included" }],
      durationMs: 1,
    });
    const view = analyzeRecallTrace(mismatched);
    expect(view.rerankRan).toBe(1);
    // 1 ran recall, 0 realized lift (the mismatch is excluded from the numerator).
    expect(view.rerankLiftRealized).toBe(0);
  });

  it("does NOT count a ran recall with an empty pre/post score pair as realized lift", () => {
    // Equal-length but empty arrays reorder nothing observable — excluded too.
    const emptyScores = JSON.stringify({
      traceSchema: "comis-recall-trace",
      schemaVersion: 1,
      ts: "2026-05-31T00:00:00.000Z",
      seq: 0,
      agentId: "bench",
      sessionId: "s",
      traceId: "t",
      queryDigest: "d",
      lanes: { fts: 1, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: true,
      fusedOrder: ["m1"],
      rerank: { outcome: "ran", candidateCount: 0, preScores: [], postScores: [] },
      ranked: [{ id: "m1", reason: "included" }],
      durationMs: 1,
    });
    const view = analyzeRecallTrace(emptyScores);
    expect(view.rerankRan).toBe(1);
    expect(view.rerankLiftRealized).toBe(0);
  });
});

describe("analyzeRecallTrace (trust-filtered + deduped rates)", () => {
  it("computes per-recall-mean trust-filtered and deduped rates from ranked reasons", () => {
    const view = analyzeRecallTrace(FIXTURE);
    // trust_filtered per recall: 1/4, 0/1, 0/2, 1/1 -> mean = 1.25/4 = 0.3125
    expect(view.trustFilteredRate).toBeCloseTo(0.3125, 10);
    // deduped per recall:        1/4, 0/1, 1/2, 0/1 -> mean = 0.75/4 = 0.1875
    expect(view.dedupedRate).toBeCloseTo(0.1875, 10);
  });

  it("treats a recall with zero ranked entries as 0, never NaN", () => {
    const emptyRanked = JSON.stringify({
      traceSchema: "comis-recall-trace",
      schemaVersion: 1,
      ts: "2026-05-31T00:00:00.000Z",
      seq: 0,
      agentId: "bench",
      sessionId: "s",
      traceId: "t",
      queryDigest: "d",
      lanes: { fts: 0, vector: 0, entity: 0, temporal: 0 },
      vectorLaneActive: true,
      fusedOrder: [],
      rerank: { outcome: "fell_back", candidateCount: 0 },
      ranked: [],
      durationMs: 1,
    });
    const view = analyzeRecallTrace(emptyRanked);
    expect(view.trustFilteredRate).toBe(0);
    expect(view.dedupedRate).toBe(0);
    expect(Number.isNaN(view.trustFilteredRate)).toBe(false);
    expect(Number.isNaN(view.dedupedRate)).toBe(false);
  });
});

describe("analyzeRecallTrace (score-factor distributions)", () => {
  it("gathers per-factor values from every included ranked entry that carries a breakdown", () => {
    const view = analyzeRecallTrace(FIXTURE);
    // included-with-breakdown entries: m2,m1 (line1), m5 (line2), m6 (line3) = 4.
    expect(view.scoreFactorDist.recency).toHaveLength(4);
    expect(view.scoreFactorDist.temporal).toHaveLength(4);
    expect(view.scoreFactorDist.proof).toHaveLength(4);
    expect(view.scoreFactorDist.trust).toHaveLength(4);
    // recency factors in document/entry order: 1.1, 0.9, 1.05, 1.2.
    expect(view.scoreFactorDist.recency).toEqual([1.1, 0.9, 1.05, 1.2]);
    expect(view.scoreFactorDist.trust).toEqual([1.2, 1.1, 1.0, 1.0]);
  });

  it("does not gather factors from trust_filtered/deduped entries or entries without a breakdown", () => {
    // m3 (trust_filtered), m4/m7 (deduped), m8 (trust_filtered, no breakdown)
    // contribute nothing — proven by the length being 4, not 8.
    const view = analyzeRecallTrace(FIXTURE);
    expect(view.scoreFactorDist.recency).not.toContain(undefined);
    expect(view.scoreFactorDist.proof.every((n) => typeof n === "number")).toBe(true);
  });
});

describe("analyzeRecallTrace (robustness: malformed + foreign/sentinel lines)", () => {
  it("skips a malformed non-JSON line and a sentinel line, folding only valid recalls", () => {
    // The fixture has `not-json{` (malformed) and
    // `{"recallTrace":"recall_trace.write_failures","count":1}` (valid JSON,
    // fails RecallTraceEventSchema). Neither inflates the recall count.
    expect(FIXTURE).toContain("not-json{");
    expect(FIXTURE).toContain("recall_trace.write_failures");
    const view = analyzeRecallTrace(FIXTURE);
    expect(view.recalls).toBe(4); // 6 non-empty lines, 2 skipped.
  });

  it("returns a zeroed view (never throws, never NaN) for all-garbage input", () => {
    const view = analyzeRecallTrace('not-json{\n{"foreign":true}\n\n');
    expect(view.recalls).toBe(0);
    expect(view.rerankLiftRealized).toBe(0);
    expect(view.trustFilteredRate).toBe(0);
    expect(view.dedupedRate).toBe(0);
    expect(view.scoreFactorDist.recency).toEqual([]);
    expect(view.degradationCounts).toEqual({});
  });
});

describe("analyzeRecallTrace (lanes + degradations)", () => {
  it("sums per-lane candidate totals and counts vector-lane-inactive recalls", () => {
    const view = analyzeRecallTrace(FIXTURE);
    // fts: 3+2+1+1=7, vector: 2+0+1+0=3, entity: 1+0+0+0=1, temporal: 1+0+2+0=3, causal: 0
    // (the fixtures omit the append-only causal field → coalesced to 0).
    expect(view.laneTotals).toEqual({ fts: 7, vector: 3, entity: 1, temporal: 3, causal: 0 });
    // vectorLaneActive=false on line2 + line4.
    expect(view.vectorLaneInactiveCount).toBe(2);
  });

  it("tallies degradation kinds present across recalls", () => {
    const view = analyzeRecallTrace(FIXTURE);
    expect(view.degradationCounts).toEqual({
      reranker_unavailable: 1,
      rerank_timeout: 1,
    });
  });
});

describe("argsortDiffers (pure descending-order permutation comparison)", () => {
  it("returns true when the descending-score order differs", () => {
    expect(argsortDiffers([0.9, 0.1], [0.1, 0.9])).toBe(true);
  });

  it("returns false when the descending-score order is identical (despite different values)", () => {
    expect(argsortDiffers([0.9, 0.5], [0.8, 0.4])).toBe(false);
  });

  it("breaks ties by original index so equal scores never spuriously register as differing", () => {
    // Equal scores in both arrays: the index-ascending tie-break keeps the
    // relative order identical, so no reorder is reported.
    expect(argsortDiffers([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBe(false);
    // A genuine reorder of a set with ties is still detected.
    expect(argsortDiffers([0.5, 0.5, 0.9], [0.9, 0.5, 0.5])).toBe(true);
  });

  it("returns false for two empty arrays", () => {
    expect(argsortDiffers([], [])).toBe(false);
  });

  it("returns true for unequal lengths (documented total-function choice)", () => {
    expect(argsortDiffers([0.9], [0.9, 0.1])).toBe(true);
  });
});
