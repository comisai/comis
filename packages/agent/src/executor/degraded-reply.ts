// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply — deterministic user-facing reply builder for degraded turns.
 *
 * PURE: no LLM, no I/O, no globals — same input → same output always.
 * Keyed on the named degraded endReason (output_starved / context_exhausted /
 * loop_detected).
 * Fail-closed: always returns a non-empty honest line even when partial text is empty.
 *
 * Each builder takes an optional resolved BCP-47 locale tag and delegates the
 * actual string selection to
 * `degraded-reply-i18n.ts` — the single source of the phrase strings. With no
 * `language` (or "en") the canonical English reply is returned byte-identical:
 * the i18n `en` row IS today's literals, so there is no duplicate and no
 * drift. Raw configuration paths stay internal; the incident ref and warning
 * marker stay verbatim across languages.
 *
 * @module
 */

import type { ContextExhaustionCause } from "../context-engine/errors.js";
import {
  selectOutputStarvedAnnotation,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
  type LocaleCatalog,
} from "./degraded-reply-i18n.js";

// CAP_KNOB_BY_CLASS lives in degraded-reply-i18n.ts as an internal diagnostic
// mapping. Re-exported here for callers that need to associate capability
// classes with operator settings; user-facing replies do not interpolate it.
export { CAP_KNOB_BY_CLASS } from "./degraded-reply-i18n.js";

/** Optional context for the synthesized context-exhausted reply. */
export interface ContextExhaustedReplyOpts {
  /** The model's capability class, used to select profile-aware recovery advice. */
  capabilityClass?: string;
  /** The turn's traceId — appended as an incident ref so the operator (or an LLM
   *  agent) can run `comis explain <traceId>` directly from the chat message. */
  traceId?: string;
  /** Why the fit failed — branches the advice so it names the remedy
   *  that actually applies. Omitted/aggregate → the default reply. */
  cause?: ContextExhaustionCause;
  /** The resolved response locale. Missing packs fall back to English. */
  language?: string;
  /** Application-injected deterministic locale strings. */
  localeCatalog?: LocaleCatalog;
}

/**
 * Returns the annotation string to APPEND for an output_starved turn.
 * Starts with "\n\n⚠️ " so appending to partial text is visually separated.
 * Localized when the injected catalog contains a matching locale pack.
 */
export function buildOutputStarvedAnnotation(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectOutputStarvedAnnotation(language, localeCatalog);
}

/**
 * Returns the synthesized honest reply to REPLACE result.response for a
 * context_exhausted turn (the model never ran; the prior content was either
 * a canned placeholder or the operator-facing redirect). Still PURE —
 * same opts → same string. With no opts the canonical English reply is
 * returned byte-identical.
 */
export function buildContextExhaustedReply(opts?: ContextExhaustedReplyOpts): string {
  return selectContextExhaustedReply(opts?.language, {
    capabilityClass: opts?.capabilityClass,
    traceId: opts?.traceId,
    cause: opts?.cause,
  }, opts?.localeCatalog);
}

/**
 * Top-level dispatcher: returns the annotation (output_starved) or synthesized
 * reply (context_exhausted / loop_detected). Returns undefined for any other
 * endReason so that healthy turns are strict no-ops. Forwards the resolved
 * `language` tag to each builder.
 */
export function buildDegradedReply(
  endReason: string,
  opts?: ContextExhaustedReplyOpts,
): string | undefined {
  if (endReason === "output_starved") {
    return buildOutputStarvedAnnotation(opts?.language, opts?.localeCatalog);
  }
  if (endReason === "context_exhausted") return buildContextExhaustedReply(opts);
  if (endReason === "loop_detected") return buildLoopDetectedReply(opts);
  return undefined;
}

/**
 * Honest reply for a turn the loop-guard stopped: the model kept repeating
 * an action that made no progress (most often a tool that kept failing or was
 * blocked) and was halted before it could run to the makespan ceiling. Used as an
 * APPEND when partial text exists, or a REPLACE when the turn produced no usable
 * text (a pure tool-loop). PURE: same opts → same string.
 */
export function buildLoopDetectedReply(opts?: ContextExhaustedReplyOpts): string {
  return selectLoopDetectedReply(opts?.language, {
    traceId: opts?.traceId,
  }, opts?.localeCatalog);
}
