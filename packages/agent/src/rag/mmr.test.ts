// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for mmrRerank() — pure greedy embedding-MMR diversity re-rank.
 *
 * Load-bearing assertions:
 * - DETERMINISM: two calls on the same (ranked, embeddingsById, λ) return the same order.
 * - NEUTRAL λ (>= 1): returns `ranked` UNCHANGED — referential byte-identity (pure relevance).
 * - <2 EMBEDDED: fewer than 2 candidates carry an embedding → `ranked` UNCHANGED (no diversity
 *   signal — the FTS-only / no-vec byte-identity path).
 * - DIVERSITY (λ=0.5): a near-duplicate of the top result is suppressed and the orthogonal
 *   (diverse) candidate is promoted ahead of it — the ON reorder.
 * - TIEBREAK: two candidates with EQUAL MMR score resolve by entry.id ASCENDING (deterministic,
 *   matching fuse()'s order tiebreak).
 * - MISSING-EMBEDDING ROW: a candidate present in `ranked` but absent from `embeddingsById`
 *   contributes cosine 0 (maximally diverse via the no-NaN guard) and is still placed — MMR
 *   re-orders the FULL set, never truncates.
 * - rel COMPONENT: rel(d) reads `d.score ?? 0` (a candidate with no score contributes 0 relevance).
 *
 * mmrRerank is PURE — no clock, no RNG; the embeddings ride a side Map (not the result),
 * mirroring how usefulnessById is a side map in score().
 */

import type { MemorySearchResult } from "@comis/core";
import { describe, it, expect } from "vitest";
import { mmrRerank } from "./mmr.js";

/** Build a neutral-placeholder result with an explicit id + relevance score. */
function makeResult(id: string, score?: number): MemorySearchResult {
  const entry: Record<string, unknown> = {
    id,
    tenantId: "default",
    agentId: "default",
    userId: "user_a",
    content: `content for ${id}`,
    trustLevel: "learned",
    source: { who: "agent" },
    tags: [],
    createdAt: 1_700_000_000_000,
  };
  const result: MemorySearchResult = { entry: entry as unknown as MemorySearchResult["entry"] };
  if (score !== undefined) result.score = score;
  return result;
}

// Fixture vectors: a, near-dup of a, orthogonal to a.
const VEC_A = [1, 0, 0];
const VEC_A_DUP = [0.99, 0.01, 0]; // ≈ parallel to VEC_A (cosine ≈ 1)
const VEC_ORTH = [0, 1, 0]; // orthogonal to VEC_A (cosine 0)

describe("mmrRerank", () => {
  it("returns the input order UNCHANGED (referential byte-identity) when lambda >= 1", () => {
    const ranked = [makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7)];
    const embeddings = new Map<string, number[]>([
      ["a", VEC_A],
      ["b", VEC_A_DUP],
      ["c", VEC_ORTH],
    ]);
    const out = mmrRerank(ranked, embeddings, 1);
    // Pure-relevance guarantee: the SAME array reference is returned (no copy, no reorder).
    expect(out).toBe(ranked);
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the input order UNCHANGED when fewer than 2 candidates carry an embedding", () => {
    const ranked = [makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7)];
    // Only one candidate is embedded → no diversity signal → byte-identity (no-vec path).
    const embeddings = new Map<string, number[]>([["a", VEC_A]]);
    const out = mmrRerank(ranked, embeddings, 0.5);
    expect(out).toBe(ranked);
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
  });

  it("promotes the orthogonal (diverse) candidate ahead of the near-duplicate at lambda=0.5", () => {
    // b is a near-duplicate of the top result a; c is orthogonal (diverse). With pure
    // relevance b (0.8) would out-rank c (0.7), but MMR suppresses the near-dup of the
    // already-selected a, so the diverse c is promoted ahead of b.
    const ranked = [makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7)];
    const embeddings = new Map<string, number[]>([
      ["a", VEC_A],
      ["b", VEC_A_DUP],
      ["c", VEC_ORTH],
    ]);
    const out = mmrRerank(ranked, embeddings, 0.5);
    expect(out.map((r) => r.entry.id)).toEqual(["a", "c", "b"]);
  });

  it("resolves an EQUAL MMR score by entry.id ascending (deterministic tiebreak)", () => {
    // Two orthogonal candidates with identical relevance: nothing is selected yet, so each
    // has maxSim 0 and equal MMR. The tiebreak picks the lexicographically-smaller id first.
    const ranked = [makeResult("y", 0.5), makeResult("x", 0.5)];
    const embeddings = new Map<string, number[]>([
      ["x", VEC_A],
      ["y", VEC_ORTH],
    ]);
    const out = mmrRerank(ranked, embeddings, 0.5);
    expect(out.map((r) => r.entry.id)).toEqual(["x", "y"]);
  });

  it("returns an identical order on two successive calls (determinism — no RNG, no clock)", () => {
    const ranked = [makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7)];
    const embeddings = new Map<string, number[]>([
      ["a", VEC_A],
      ["b", VEC_A_DUP],
      ["c", VEC_ORTH],
    ]);
    const first = mmrRerank(ranked, embeddings, 0.5).map((r) => r.entry.id);
    const second = mmrRerank(ranked, embeddings, 0.5).map((r) => r.entry.id);
    expect(first).toEqual(second);
  });

  it("places a candidate ABSENT from embeddingsById (cosine 0 → maximally diverse) without truncating", () => {
    // d has no embedding row → cosine 0 against everything → treated as maximally diverse.
    // The full set is re-ordered and d is still present (MMR never truncates).
    const ranked = [
      makeResult("a", 0.9),
      makeResult("b", 0.85), // near-dup of a
      makeResult("d", 0.1), // no embedding row
    ];
    const embeddings = new Map<string, number[]>([
      ["a", VEC_A],
      ["b", VEC_A_DUP],
    ]);
    const out = mmrRerank(ranked, embeddings, 0.5);
    expect(out.map((r) => r.entry.id).sort()).toEqual(["a", "b", "d"]); // full set, nothing dropped
    expect(out[0]?.entry.id).toBe("a"); // highest relevance + nothing selected → a first
  });

  it("reads the relevance component as score ?? 0 (a scoreless candidate contributes 0 rel)", () => {
    // a has a high score, b/c are scoreless (rel 0). At lambda=1 (>=1) the order is byte-identical;
    // this asserts the function does not throw on a missing score and the contract holds.
    const ranked = [makeResult("a", 0.9), makeResult("b"), makeResult("c")];
    const embeddings = new Map<string, number[]>([
      ["b", VEC_A],
      ["c", VEC_ORTH],
    ]);
    const out = mmrRerank(ranked, embeddings, 1);
    expect(out).toBe(ranked);
  });
});
