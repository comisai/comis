// SPDX-License-Identifier: Apache-2.0
import type { MemorySearchResult } from "@comis/core";
import { cosine } from "./cosine.js"; // reuse — pure, no-NaN (relocated rag-local util, v2.31 D-04)

/**
 * Greedy Maximal Marginal Relevance (MMR) re-rank. Diversifies a relevance-ranked
 * candidate list by trading relevance against similarity-to-already-selected:
 *
 *   select_i = argmax_i [ λ · rel(i) − (1 − λ) · max_{j ∈ selected} cos(e_i, e_j) ]
 *
 * `rel(i)` is the candidate's final boosted relevance (`d.score ?? 0`); `e_i` is its embedding
 * from `embeddingsById` (id → vector; an id ABSENT from the map has no embedding and contributes
 * cosine 0 against everything — treated as maximally diverse via {@link cosine}'s no-NaN guard,
 * mirroring surprisal()'s "no neighbour → 0" discipline). Raw `rel` + raw `cos` are used directly
 * (both ≈ [0,1]) — NO min-max normalization (start raw; the λ-sweep validates).
 *
 * Neutral / off guarantees (byte-identity — the same array reference is returned, no copy):
 *   - `lambda >= 1` → pure relevance → returns `ranked` UNCHANGED.
 *   - fewer than 2 candidates carry an embedding → no diversity signal → returns `ranked`
 *     UNCHANGED (the FTS-only / no-vec path).
 *
 * Deterministic tiebreak: MMR score DESC, then `entry.id` ASC (ids are unique → a strict total
 * order, reproducible run-to-run — matching fuse()'s order tiebreak). Re-ORDERS the FULL set —
 * it NEVER truncates (the budget cap is applied downstream).
 *
 * Pure: no `Result` wrapper, no I/O, no clock, no RNG (the rag/score.ts pure-ranking carve-out).
 * The input array and its result objects are never mutated.
 */
export function mmrRerank(
  ranked: MemorySearchResult[],
  embeddingsById: ReadonlyMap<string, number[]>,
  lambda: number,
): MemorySearchResult[] {
  if (lambda >= 1 || ranked.length < 2) return ranked;
  const embedded = ranked.filter((r) => embeddingsById.has(r.entry.id));
  if (embedded.length < 2) return ranked; // no diversity signal → byte-identity
  const selected: MemorySearchResult[] = [];
  const remaining = [...ranked];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = remaining[i];
      const rel = d.score ?? 0;
      const de = embeddingsById.get(d.entry.id);
      let maxSim = 0;
      if (de) {
        for (const s of selected) {
          const se = embeddingsById.get(s.entry.id);
          if (se) maxSim = Math.max(maxSim, cosine(de, se));
        }
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      // Strictly-greater wins; an EXACT tie resolves by entry.id ascending (deterministic).
      // CONTRACT (do NOT relax without revisiting the tiebreak): `rel` and `cos` are used RAW
      // (≈[0,1], NO min-max normalization — starts raw). Under raw scores the
      // `mmr === bestScore` exact-float compare engages ONLY on bit-identical MMR — i.e. genuine
      // duplicates (equal `rel` + both unembedded → maxSim 0 for each) — so the id tiebreak is a
      // determinism backstop, not a frequent path. IF a future change introduces score
      // normalization, this exact `===` MUST be revisited (replace with an
      // epsilon band, advancing `bestIdx` but NOT `bestScore` on the tie) or genuine near-ties
      // will silently fall to scan order instead of id order and be mis-ordered.
      if (mmr > bestScore || (mmr === bestScore && d.entry.id < remaining[bestIdx].entry.id)) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}
