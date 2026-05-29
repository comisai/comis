// SPDX-License-Identifier: Apache-2.0
/**
 * Read-time contradiction guidance (TEMP-02/03/04/05, design §7.3). A PURE formatter
 * over {@link MemorySearchResult}[] that returns the design-§7.3 guidance block — a FIXED
 * constant string — iff >=2 memories are surfaced for a query, else `undefined`.
 *
 * The block is INJECTED TEXT that tells the agent HOW to resolve a surfaced contradiction
 * (the most recently RECORDED memory is authoritative; never average/sum; at equal recency
 * the higher-TRUST memory wins; order a timeline by when events OCCURRED). It does NOT
 * mutate memories and it does NOT resolve the contradiction in code — resolution is the
 * LLM's job, guided by this text (non-destructive, TEMP-03).
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
 * Prompt-injection safety (T-81-08): the block is a STATIC constant; it NEVER interpolates
 * `entry.content`, so untrusted memory bodies cannot cross into the guidance text. Memory
 * CONTENT lines remain sanitizeToolOutput + wrapExternalContent-wrapped at the injector
 * (unchanged). It reads only `results.length` (the conflict gate).
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";

/**
 * The design-§7.3 read-time temporal contradiction guidance block, VERBATIM. A fixed
 * constant — references memory METADATA semantics (recorded time, occurred time, trust)
 * in prose; it does NOT echo or interpolate any memory CONTENT (prompt-injection safe).
 * The final bullet states the equal-recency trust tie-break (TEMP-04).
 */
const TEMPORAL_GUIDANCE = `## Using these memories over time
- Each memory shows when it was recorded and (if known) when the event occurred.
- If two conflict about the same thing, the most recently RECORDED one is authoritative; treat older
  conflicting statements as superseded — do NOT average or sum.
- For a timeline, order by when events OCCURRED, not when they were recorded.
- If equally recent and still disagreeing, say so rather than guess.
- Tie-break by trust: a [system] memory outranks a [learned] one of equal recency.`;

/**
 * Phase-81 baseline (Option A, RESEARCH.md Open Q5 RESOLVED): the co-retrieved recall set
 * IS the "same topic" signal — all results were surfaced for the same query, so >=2 of them
 * means there is a contradiction worth guiding the LLM about. Phase 83 TIGHTENS this seam
 * with resolved-entity overlap (two memories that share a resolved entity), once the entity
 * lane ships. Leave this seam; do NOT inline entity logic here.
 */
function sharesTopic(results: MemorySearchResult[]): boolean {
  return results.length >= 2;
}

/**
 * Build the read-time §7.3 contradiction guidance block. Returns the FIXED block string when
 * `sharesTopic(results)` holds (>=2 surfaced memories, the Phase-81 conflict gate), else
 * `undefined` (no block — nothing to disambiguate). Pure and non-mutating: it reads only
 * `results.length` and never touches the entries (TEMP-03; no content echo, T-81-08).
 */
export function buildTemporalGuidanceBlock(
  results: MemorySearchResult[],
): string | undefined {
  return sharesTopic(results) ? TEMPORAL_GUIDANCE : undefined;
}
