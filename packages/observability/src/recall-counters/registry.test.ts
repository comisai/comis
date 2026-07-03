// SPDX-License-Identifier: Apache-2.0
/**
 * createRecallCounters tests — in-process counter registry.
 *
 * A process-lifetime gauge (resets on restart, NOT a durable
 * table). Each createRecallCounters() owns its own closed-over numeric
 * accumulators; two registries must be independent (no module-global leak).
 * Pure — no clock, no I/O, no globals.
 *
 * @module
 */
import { describe, it, expect } from "vitest";

import { createRecallCounters } from "./registry.js";

describe("createRecallCounters -- fresh registry", () => {
  it("a fresh registry snapshot() reports all-zero counters", () => {
    const counters = createRecallCounters();
    const snap = counters.snapshot();
    expect(snap).toEqual({
      laneUsage: { fts: 0, vector: 0, entity: 0 },
      rerankRuns: 0,
      rerankFallbacks: 0,
      consolidationClusters: 0,
      observationsCreated: 0,
      recalls: 0,
      recallsWithHits: 0,
    });
  });
});

describe("createRecallCounters -- onRecalled", () => {
  it("onRecalled adds per-lane candidate counts, increments recalls, and recallsWithHits when finalCount > 0", () => {
    const counters = createRecallCounters();
    counters.onRecalled({
      lanes: { fts: 5, vector: 3, entity: 2 },
      finalCount: 4,
      rerankerAvailable: true,
    });
    const snap = counters.snapshot();
    expect(snap.laneUsage).toEqual({ fts: 5, vector: 3, entity: 2 });
    expect(snap.recalls).toBe(1);
    expect(snap.recallsWithHits).toBe(1);
  });

  it("onRecalled with finalCount 0 increments recalls but NOT recallsWithHits", () => {
    const counters = createRecallCounters();
    counters.onRecalled({
      lanes: { fts: 1, vector: 0, entity: 0 },
      finalCount: 0,
      rerankerAvailable: false,
    });
    const snap = counters.snapshot();
    expect(snap.recalls).toBe(1);
    expect(snap.recallsWithHits).toBe(0);
    // hit-rate denominator advances, numerator does not.
    expect(snap.laneUsage.fts).toBe(1);
  });
});

describe("createRecallCounters -- onReranked", () => {
  it("onReranked without fallback/timeout increments rerankRuns only", () => {
    const counters = createRecallCounters();
    counters.onReranked({ fellBack: false, timedOut: false });
    const snap = counters.snapshot();
    expect(snap.rerankRuns).toBe(1);
    expect(snap.rerankFallbacks).toBe(0);
  });

  it("onReranked with fellBack increments BOTH rerankRuns and rerankFallbacks (fallback-rate = fallbacks/runs)", () => {
    const counters = createRecallCounters();
    counters.onReranked({ fellBack: true, timedOut: false });
    const snap = counters.snapshot();
    expect(snap.rerankRuns).toBe(1);
    expect(snap.rerankFallbacks).toBe(1);
  });

  it("onReranked with timedOut counts as a fallback (degradation → fusion order)", () => {
    const counters = createRecallCounters();
    counters.onReranked({ fellBack: false, timedOut: true });
    const snap = counters.snapshot();
    expect(snap.rerankRuns).toBe(1);
    expect(snap.rerankFallbacks).toBe(1);
  });
});

describe("createRecallCounters -- onConsolidated", () => {
  it("onConsolidated adds to consolidationClusters + observationsCreated (throughput)", () => {
    const counters = createRecallCounters();
    counters.onConsolidated({ clustersProcessed: 3, observationsCreated: 2 });
    counters.onConsolidated({ clustersProcessed: 1, observationsCreated: 5 });
    const snap = counters.snapshot();
    expect(snap.consolidationClusters).toBe(4);
    expect(snap.observationsCreated).toBe(7);
  });
});

describe("createRecallCounters -- isolation + defensive copy", () => {
  it("two independent registries do not share state (no module-global accumulator leak)", () => {
    const a = createRecallCounters();
    const b = createRecallCounters();
    a.onRecalled({ lanes: { fts: 9, vector: 9, entity: 9 }, finalCount: 9, rerankerAvailable: true });
    const snapB = b.snapshot();
    expect(snapB.recalls).toBe(0);
    expect(snapB.laneUsage).toEqual({ fts: 0, vector: 0, entity: 0 });
  });

  it("snapshot() returns a defensive copy — mutating it does not corrupt internal state", () => {
    const counters = createRecallCounters();
    counters.onRecalled({ lanes: { fts: 2, vector: 1, entity: 0 }, finalCount: 1, rerankerAvailable: true });
    const snap1 = counters.snapshot();
    snap1.recalls = 999;
    snap1.laneUsage.fts = 999;
    const snap2 = counters.snapshot();
    expect(snap2.recalls).toBe(1);
    expect(snap2.laneUsage.fts).toBe(2);
  });
});
