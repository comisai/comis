// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-free query understanding (IQ-02 + IQ-03) — pure, deterministic helpers over the query
 * STRING. All exports are PURE (no `Result`, no throw, no I/O, no clock, no globals — the
 * rag/score.ts pure-ranking carve-out): a malformed input returns a safe value (the default
 * intent / a 1.0 multiplier / the unchanged string / `undefined`), NEVER an exception.
 *
 * NO LLM, NO network: intent is keyword/shape heuristics, synonym expansion is a bounded static
 * map, and the temporal grammar is a hand-rolled regex + epoch arithmetic (no date library —
 * `@comis/agent` has none, and adding one violates the CLAUDE.md exact-pin supply-chain invariant).
 *
 * @module
 */

/**
 * The CLOSED set of query intents. Default / unmatched = `"factual"` (a plain lookup). A new
 * member fails the build at the {@link intentMultiplier} switch's exhaustive default until it is
 * handled explicitly (the score.ts `trustWeight` closed-union precedent, AGENTS.md §2.8).
 */
export type Intent = "factual" | "temporal" | "preference" | "enumeration";

/** The CLOSED set of reweightable recall lanes (the IQ-02 reweight surface). */
export type ReweightLane = "fts" | "vector" | "entity" | "temporal" | "causal" | "graphSpread";

/**
 * RED stub (102-02 Task 2). Replaced in the GREEN commit. Returns the wrong constant so the
 * marker-family classification assertions fail on the unimplemented function.
 */
export function classifyIntent(_query: string): Intent {
  return "factual";
}

/**
 * RED stub (102-02 Task 2). Replaced in the GREEN commit. Returns 1.0 everywhere so the
 * targeted-lane >1.0 assertions fail on the unimplemented function.
 */
export function intentMultiplier(_intent: Intent, _lane: ReweightLane): number {
  return 1.0;
}
