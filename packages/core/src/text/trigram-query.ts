// SPDX-License-Identifier: Apache-2.0
/**
 * Script-routed FTS5 trigram query construction (FTS-01).
 *
 * Stub — RED state for plan 180-01 Task 1. The real router + MATCH builder
 * land in Task 3. Frozen signatures are the contract the LCD lane (180-05) and
 * the LTM lane (180-06) build against. Pure (I9): no I/O/clock/env.
 * @module
 */

/** The lane a query is routed to. */
export type SearchLane = "word" | "tri" | "scan";

export interface TrigramRoute {
  lane: SearchLane;
  /** Defined iff lane === "tri" — the complete FTS5 MATCH string. */
  match?: string;
  /** Defined iff lane === "scan" — normalized non-operator tokens for the
   *  bounded floor (includes the <3-codepoint tokens that forced the scan). */
  scanTokens?: string[];
}

/**
 * Route a query to the word / trigram / scan lane and, for the trigram lane,
 * build the FTS5 MATCH string.
 *
 * join: "and" = space-joined terms (LCD implicit-AND semantics);
 * join: "or"  = OR-joined terms (LTM buildFtsQuery parity).
 */
export function routeSearchQuery(_query: string, _opts: { join: "and" | "or" }): TrigramRoute {
  throw new Error("routeSearchQuery not implemented (180-01 Task 1 RED stub)");
}
