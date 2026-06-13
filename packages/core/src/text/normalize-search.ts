// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE search-text normalizer (FTS-02 / I7).
 *
 * Stub — RED state for plan 180-01 Task 1. The real pipeline (NFKC →
 * full-Unicode lowercase → per-script fold table) lands in Task 2. The frozen
 * signature is the contract every downstream consumer builds against (twin
 * inserts, the MATCH builder, the scan floor, the doctor backfill — index side
 * = query side by this shared import).
 * @module
 */

/**
 * The ONE search-text normalizer (I7): twin inserts, MATCH builder, scan floor,
 * and doctor backfill all import THIS symbol. Pure (I9): no I/O/clock/env.
 */
export function normalizeForSearch(_text: string): string {
  throw new Error("normalizeForSearch not implemented (180-01 Task 1 RED stub)");
}
