// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for fuse() — N-lane Reciprocal Rank Fusion over MemorySearchResult lanes.
 *
 * Pins the load-bearing properties from the plan:
 * - empty input → []
 * - single-lane identity (the DEFAULT recall path, rerank OFF, does not reorder)
 * - two-lane membership boost (a doc in two lanes outranks a doc in one)
 * - per-lane weights honored (heavier lane's rank-1 outranks lighter lane's rank-1)
 * - normalization to (0,1] (rank-1-in-all-lanes ≈ 1.0)
 * - dedup by entry.id (same entry from two lanes appears once with summed RRF)
 * - permutation stability (lane order swap → same final ranking)
 *
 * fuse() ports the k=60 RRF math from hybrid-search.ts computeRRF; it does NOT
 * import that symbol (agent→memory production import is forbidden).
 */

import type { MemorySearchResult } from "@comis/core";
import { describe, it, expect } from "vitest";
import { fuse, type FusionLane } from "./fuse.js";

/** Build a neutral-placeholder MemorySearchResult keyed by id. */
function makeResult(
  id: string,
  overrides: Partial<MemorySearchResult["entry"]> = {},
  score?: number,
): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "user_a",
      content: `content for ${id}`,
      trustLevel: "learned",
      source: { who: "agent" },
      tags: [],
      createdAt: 1_700_000_000_000,
      ...overrides,
    },
    score,
  };
}

/** Convenience: a lane from an ordered list of ids (rank 1 = first). */
function laneOf(ids: string[], weight: number): FusionLane {
  return { results: ids.map((id) => makeResult(id)), weight };
}

describe("fuse — N-lane Reciprocal Rank Fusion", () => {
  it("returns an empty array when given no lanes", () => {
    expect(fuse([])).toEqual([]);
  });

  it("returns an empty array when every lane is empty", () => {
    expect(fuse([{ results: [], weight: 1 }, { results: [], weight: 1.5 }])).toEqual([]);
  });

  it("preserves the input order for a single lane (identity — the default recall path)", () => {
    const lane = laneOf(["a", "b", "c", "d"], 1.0);
    const fused = fuse([lane]);
    expect(fused.map((r) => r.entry.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("ranks a document appearing in two lanes above one appearing in only one", () => {
    // "shared" is rank-1 in both lanes; "onlyA"/"onlyB" appear in a single lane each.
    const laneA = laneOf(["shared", "onlyA"], 1.0);
    const laneB = laneOf(["shared", "onlyB"], 1.0);
    const fused = fuse([laneA, laneB]);
    expect(fused[0]?.entry.id).toBe("shared");
  });

  it("honors per-lane weights: the heavier (1.5) lane's rank-1 outranks the lighter (1.0) lane's rank-1", () => {
    // Two disjoint rank-1 hits; only the lane weight differentiates them.
    const lightLane: FusionLane = { results: [makeResult("light")], weight: 1.0 };
    const heavyLane: FusionLane = { results: [makeResult("heavy")], weight: 1.5 };
    const fused = fuse([lightLane, heavyLane]);
    expect(fused[0]?.entry.id).toBe("heavy");
    expect(fused[1]?.entry.id).toBe("light");
  });

  it("normalizes fused scores to (0,1] with a rank-1-in-all-lanes doc at ≈1.0", () => {
    const laneA = laneOf(["top", "x"], 1.0);
    const laneB = laneOf(["top", "y"], 1.5);
    const fused = fuse([laneA, laneB]);
    const top = fused.find((r) => r.entry.id === "top");
    expect(top?.score).toBeCloseTo(1.0, 10);
    for (const r of fused) {
      expect(r.score ?? 0).toBeGreaterThan(0);
      expect(r.score ?? 0).toBeLessThanOrEqual(1.0);
    }
  });

  it("deduplicates by entry.id: a doc in two lanes appears once with the summed RRF score", () => {
    const laneA = laneOf(["shared", "a2"], 1.0);
    const laneB = laneOf(["shared", "b2"], 1.0);
    const fused = fuse([laneA, laneB]);
    const sharedCount = fused.filter((r) => r.entry.id === "shared").length;
    expect(sharedCount).toBe(1);
    expect(fused).toHaveLength(3); // shared, a2, b2 — exactly once each
  });

  it("is permutation-stable: swapping lane order yields the same final ranking", () => {
    const laneA = laneOf(["a", "b", "c"], 1.0);
    const laneB = laneOf(["b", "c", "d"], 1.5);
    const forward = fuse([laneA, laneB]).map((r) => r.entry.id);
    const reversed = fuse([laneB, laneA]).map((r) => r.entry.id);
    expect(reversed).toEqual(forward);
  });

  it("assigns the normalized fused score onto result.score", () => {
    const fused = fuse([laneOf(["a", "b"], 1.0)]);
    expect(typeof fused[0]?.score).toBe("number");
  });
});
