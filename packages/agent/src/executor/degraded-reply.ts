// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply — deterministic user-facing reply builder for degraded turns.
 *
 * PURE: no LLM, no I/O, no globals — same input → same output always.
 * Keyed on the named degraded endReason (output_starved / context_exhausted).
 * Fail-closed: always returns a non-empty honest line even when partial text is empty.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// output_starved — APPEND to the truncated partial text.
//
// Design §4 Fix 5.4 anchor phrasing (vocabulary aligned with obs-explain-heuristics.ts:256-264):
//   "output starved — the final response was truncated at the model's max output tokens"
// User-facing register: first-person, references "output limit" / "cut off".
// ---------------------------------------------------------------------------
const OUTPUT_STARVED_ANNOTATION =
  "\n\n⚠️ My answer was cut off at the model's output limit — too many tools are " +
  "loaded for this model's context window. Narrow the ask or raise the model's context size.";

// ---------------------------------------------------------------------------
// context_exhausted — REPLACE result.response (the model never ran;
//   prior content is either the Phase-166 "too large" canned message or
//   the operator-facing "[Stopped: context_exhausted]" redirect).
//
// Vocabulary aligned with obs-explain-heuristics.ts:237-244:
//   "context exhausted — the context-window guard aborted the run before the model
//    could generate a response"
// User-facing register: first-person, references "context window".
// Must NOT contain "[Stopped:", "too large", or "session reset".
// ---------------------------------------------------------------------------
const CONTEXT_EXHAUSTED_REPLY =
  "I was unable to process your request — the context window was exhausted " +
  "before the model could run. Try raising the agent's context engine settings " +
  "or narrowing the ask.";

/**
 * Returns the annotation string to APPEND for an output_starved turn.
 * Starts with "\n\n⚠️ " so appending to partial text is visually separated.
 */
export function buildOutputStarvedAnnotation(): string {
  return OUTPUT_STARVED_ANNOTATION;
}

/**
 * Returns the synthesized honest reply to REPLACE result.response for a
 * context_exhausted turn (the model never ran; the prior content was either
 * the Phase-166 canned message or the operator-facing redirect).
 */
export function buildContextExhaustedReply(): string {
  return CONTEXT_EXHAUSTED_REPLY;
}

/**
 * Top-level dispatcher: returns the annotation (output_starved) or synthesized
 * reply (context_exhausted). Returns undefined for any other endReason so that
 * healthy turns are strict no-ops.
 */
export function buildDegradedReply(endReason: string): string | undefined {
  if (endReason === "output_starved") return buildOutputStarvedAnnotation();
  if (endReason === "context_exhausted") return buildContextExhaustedReply();
  return undefined;
}
