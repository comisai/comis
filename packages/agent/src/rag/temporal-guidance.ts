// SPDX-License-Identifier: Apache-2.0
/**
 * Read-time contradiction guidance. A PURE formatter
 * over {@link MemorySearchResult}[] that returns the contradiction-guidance block — a FIXED
 * constant string — iff >=2 memories are surfaced for a query, else `undefined`.
 *
 * The block is INJECTED TEXT that tells the agent HOW to resolve a surfaced contradiction
 * TRUST-FIRST, recency-SECOND: when two memories conflict, the higher-TRUST
 * memory wins EVEN WHEN it is older (system > learned > external); recency only breaks ties
 * among EQUAL-trust memories; never average/sum; order a timeline by when events OCCURRED.
 * It does NOT mutate memories and it does NOT resolve the contradiction in code — resolution
 * is the LLM's job, guided by this text (non-destructive).
 *
 * Imports ONLY @comis/core types — the agent-package production source must not import the
 * memory package (architecture.test.ts "agent -> memory cut"). Mirrors score.ts: a pure
 * ranking/format function (the sanctioned Result carve-out, AGENTS.md §2.1) — no I/O, no
 * clock, no globals, no Result wrapper.
 *
 * Wiring: this block is appended at the prompt-assembly recall consumption site (after the
 * hybrid injector split), NOT inside createMemoryRecall — `recall()` returns
 * MemorySearchResult[] (DATA) and is reused by the text-free eval harness (recall-eval.ts).
 *
 * Prompt-injection safety: the block is a STATIC constant; it NEVER interpolates
 * `entry.content`, so untrusted memory bodies cannot cross into the guidance text. Memory
 * CONTENT lines remain sanitizeToolOutput + wrapExternalContent-wrapped at the injector
 * (unchanged). It reads only `results.length` (the conflict gate).
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";

/**
 * The read-time temporal contradiction guidance block (TRUST-FIRST,
 * recency-SECOND), VERBATIM. A fixed constant — references memory METADATA semantics
 * (recorded time, occurred time, trust tier) in prose; it does NOT echo or interpolate
 * any memory CONTENT (prompt-injection safe). The FIRST conflict bullet asserts
 * trust-primacy (the higher-trust memory wins a conflict even if older); recency appears
 * only as a tie-break among EQUAL-trust memories. The conflict bullet frames the
 * demotion as an answer-time PREFERENCE — both memories are RETAINED ("keep BOTH in mind …
 * not a deletion"), never "superseded"/dropped — keeping the prose the LLM reads aligned
 * with the NON-DESTRUCTIVE contract (resolution is answering guidance, not a store delete).
 *
 * The FINAL bullet is the read-side current-truth/as-of hint: it tells the
 * LLM how to read the trust-first bi-temporal knowledge graph — the current believed value of
 * a contested fact is the higher-trust one, while older superseded values still EXIST as history
 * (the value believed true as of a past time, reachable by an explicit as-of) and are NOT the
 * current answer. Like every other bullet it is FIXED prose over memory METADATA semantics — it
 * interpolates NO memory body / no untrusted content (prompt-injection safe).
 */
const TEMPORAL_GUIDANCE = `## Using these memories over time
- Each memory shows when it was recorded, when the event occurred (if known), and its trust tier ([system] > [learned] > [external]).
- If two conflict about the same thing, the higher-TRUST memory wins even if older — a [system] memory outranks a [learned] or [external] one even if older; answer from the higher-trust memory and treat the lower-trust statement as outdated for this answer, but keep BOTH in mind — this is a preference for answering, not a deletion; do NOT average or sum.
- Only break ties between equal-trust memories by recency: among equal-trust memories, the most recently RECORDED one wins.
- For a timeline, order by when events OCCURRED, not when they were recorded.
- If still disagreeing at equal trust and equal recency, say so rather than guess.
- The current believed value of a contested fact is the higher-trust one; an older superseded value is not deleted — it still exists as history (the value that was believed true as of a past time) but it is not the current answer.`;

/**
 * The baseline topic gate: the co-retrieved recall set
 * IS the "same topic" signal — all results were surfaced for the same query, so >=2 of them
 * means there is a contradiction worth guiding the LLM about. A later iteration TIGHTENS this seam
 * with resolved-entity overlap (two memories that share a resolved entity), once the entity
 * lane ships. Leave this seam; do NOT inline entity logic here.
 */
function sharesTopic(results: MemorySearchResult[]): boolean {
  return results.length >= 2;
}

/**
 * Build the read-time contradiction guidance block. Returns the FIXED block string when
 * `sharesTopic(results)` holds (>=2 surfaced memories, the conflict gate), else
 * `undefined` (no block — nothing to disambiguate). Pure and non-mutating: it reads only
 * `results.length` and never touches the entries (no content echo).
 */
export function buildTemporalGuidanceBlock(
  results: MemorySearchResult[],
): string | undefined {
  return sharesTopic(results) ? TEMPORAL_GUIDANCE : undefined;
}
