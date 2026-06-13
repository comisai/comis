// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply — deterministic user-facing reply builder for degraded turns.
 *
 * PURE: no LLM, no I/O, no globals — same input → same output always.
 * Keyed on the named degraded endReason (output_starved / context_exhausted /
 * loop_detected).
 * Fail-closed: always returns a non-empty honest line even when partial text is empty.
 *
 * GEN-02 (Phase 181-03): each builder takes an optional resolved `language` tag
 * (en|he|ar|ru, DET-02) and DELEGATES the actual string selection to
 * `degraded-reply-i18n.ts` — the single source of the phrase strings. With no
 * `language` (or "en") the historical English reply is returned byte-identical
 * (I1): the i18n `en` row IS today's literals, so there is no duplicate and no
 * drift. The knob path, the `(0 = uncapped)` hint, the incident ref, and the
 * warning marker stay verbatim across languages (I5).
 *
 * @module
 */

import type { ContextExhaustionCause } from "../context-engine/errors.js";
import {
  selectOutputStarvedAnnotation,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
} from "./degraded-reply-i18n.js";

// CAP_KNOB_BY_CLASS now lives in degraded-reply-i18n.ts (the single home — it is
// interpolated into every language's advice). Re-exported here for the historical
// import path; no copy, no alias (no-BC §2.9).
export { CAP_KNOB_BY_CLASS } from "./degraded-reply-i18n.js";

/** Optional context for the synthesized context-exhausted reply (W4). */
export interface ContextExhaustedReplyOpts {
  /** The model's capabilityClass — "small"/"nano" name the exact cap knob to raise. */
  capabilityClass?: string;
  /** The turn's traceId — appended as an incident ref so the operator (or an LLM
   *  agent) can run `comis explain <traceId>` directly from the chat message. */
  traceId?: string;
  /** Issue-6: why the fit failed — branches the advice so it names the remedy
   *  that actually applies. Omitted/aggregate → the historical reply. */
  cause?: ContextExhaustionCause;
  /** GEN-02 (DET-02): the resolved reply language (en|he|ar|ru). Omitted/"en"
   *  → the historical English reply byte-identical. */
  language?: string;
}

/**
 * Returns the annotation string to APPEND for an output_starved turn.
 * Starts with "\n\n⚠️ " so appending to partial text is visually separated.
 * GEN-02: localized when `language` is a he/ar/ru tag; en byte-identical otherwise.
 */
export function buildOutputStarvedAnnotation(language?: string): string {
  return selectOutputStarvedAnnotation(language ?? "en");
}

/**
 * Returns the synthesized honest reply to REPLACE result.response for a
 * context_exhausted turn (the model never ran; the prior content was either
 * the Phase-166 canned message or the operator-facing redirect). Still PURE —
 * same opts → same string. With no opts the historical English reply is
 * returned byte-identical.
 */
export function buildContextExhaustedReply(opts?: ContextExhaustedReplyOpts): string {
  return selectContextExhaustedReply(opts?.language ?? "en", {
    capabilityClass: opts?.capabilityClass,
    traceId: opts?.traceId,
    cause: opts?.cause,
  });
}

/**
 * Top-level dispatcher: returns the annotation (output_starved) or synthesized
 * reply (context_exhausted / loop_detected). Returns undefined for any other
 * endReason so that healthy turns are strict no-ops. Forwards the resolved
 * `language` tag (GEN-02) to each builder.
 */
export function buildDegradedReply(
  endReason: string,
  opts?: ContextExhaustedReplyOpts,
): string | undefined {
  if (endReason === "output_starved") return buildOutputStarvedAnnotation(opts?.language);
  if (endReason === "context_exhausted") return buildContextExhaustedReply(opts);
  if (endReason === "loop_detected") return buildLoopDetectedReply(opts);
  return undefined;
}

/**
 * Honest reply for a turn the loop-guard stopped (F-15): the model kept repeating
 * an action that made no progress (most often a tool that kept failing or was
 * blocked) and was halted before it could run to the makespan ceiling. Used as an
 * APPEND when partial text exists, or a REPLACE when the turn produced no usable
 * text (a pure tool-loop). PURE: same opts → same string.
 */
export function buildLoopDetectedReply(opts?: ContextExhaustedReplyOpts): string {
  return selectLoopDetectedReply(opts?.language ?? "en", {
    traceId: opts?.traceId,
  });
}
