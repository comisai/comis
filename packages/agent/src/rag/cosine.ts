// SPDX-License-Identifier: Apache-2.0
/**
 * Cosine similarity — a pure, no-NaN vector-proximity util on the recall HOT PATH
 * (`rag/mmr.ts` → `rag/memory-recall.ts`).
 *
 * Relocated here in v2.31 Phase 225 (FOLD/D-04): it formerly lived in
 * `memory-consolidation-clustering.ts` and was the sole survivor of that file
 * once the standalone consolidation/reasoning jobs were deleted. Keeping it as a
 * `rag/`-local pure util removes the cross-file dependency the deleted jobs no
 * longer justify, while preserving the byte-identical behaviour `mmr.ts` relies on.
 *
 * @module
 */

/**
 * Cosine similarity of two vectors. Pure dot / (‖a‖·‖b‖). A zero-norm vector
 * (or a length mismatch) yields 0 — no neighbour, never a NaN.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
