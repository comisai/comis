// SPDX-License-Identifier: Apache-2.0
/**
 * Cosine similarity — a pure, no-NaN vector-proximity util on the recall HOT PATH
 * (`rag/mmr.ts` → `rag/memory-recall.ts`). Kept as a `rag/`-local pure util so
 * the hot path carries no cross-file dependency.
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
