// SPDX-License-Identifier: Apache-2.0
import type { MemorySearchResult } from "@comis/core";

/**
 * RED stub (102-02 Task 1). Replaced by the greedy MMR implementation in the
 * GREEN commit. Throws so the RED test's diversity + tiebreak + determinism
 * assertions fail on the unimplemented function.
 */
export function mmrRerank(
  _ranked: MemorySearchResult[],
  _embeddingsById: ReadonlyMap<string, number[]>,
  _lambda: number,
): MemorySearchResult[] {
  throw new Error("not implemented");
}
