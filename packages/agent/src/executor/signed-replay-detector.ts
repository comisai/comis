// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-agnostic signed-replay error detector.
 *
 * Detects provider rejections of stored signed thinking / reasoning state on
 * the latest assistant message during replay. Triggered by a real production
 * incident on `srv1593437` 2026-04-24T20:07:34Z (trace
 * `93ba66cf-4283-4ed4-92bd-73d00b4eeb76`, request_id
 * `req_011CaPCYYKfJRpuG3w2y5s52`) where Anthropic returned
 * `400 invalid_request_error: messages.5.content.17: 'thinking' or
 * 'redacted_thinking' blocks in the latest assistant message cannot be
 * modified` after a 74-min idle gap with multiple daemon restarts.
 *
 * Provider coverage:
 * - Anthropic: `messages.N.content.M ... thinking|redacted_thinking ... cannot be modified`
 *   (also via the JSON-path fast-path).
 * - Bedrock-Claude: same wire shape as Anthropic over Bedrock.
 * - Google Gemini / Vertex / Gemini-CLI: `thought_signature` mismatch /
 *   verification failed / not found.
 * - OpenAI Responses (o-series): `reasoning_item` not found / invalid /
 *   expired / mismatch.
 * - OpenAI Completions reasoning: `reasoning_id` not found / expired.
 * - Mistral: `encrypted_content` mismatch / verification failed / tampered.
 *
 * Pure function — no I/O, no logger. The classifier in `error-classifier.ts`
 * uses this as a `RegExp | { test(s: string): boolean }`-shaped pattern. The
 * runner in `executor-prompt-runner.ts` uses the resulting category to drive
 * the scrub-and-retry self-heal path.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Patterns (case-insensitive)
// ---------------------------------------------------------------------------

/**
 * Signature-noun regex: matches the provider-specific name for "the signed
 * piece of state attached to the assistant turn". Covers all seven targeted
 * providers without leaking unrelated false positives.
 */
const SIGNATURE_NOUN =
  /thinking|redacted_thinking|reasoning_item|encrypted_content|thought_signature|reasoning_id/i;

/**
 * Rejection-verb regex: matches any of the verbs providers use to reject
 * tampered / stale / mismatched signed state. Pairing this with a signature
 * noun avoids matching unrelated `invalid` / `not found` errors (e.g. model
 * not found).
 */
const REJECTION_VERB =
  /cannot be modified|not found|invalid|mismatch|verification failed|expired|tampered|stale/i;

/**
 * Anthropic JSON-path fast-path: matches the canonical Anthropic 400 error
 * shape `messages.N.content.M: ...thinking|redacted_thinking...`. This shape
 * always indicates signed-replay rejection regardless of which verb appears
 * in the surrounding text.
 */
const ANTHROPIC_JSON_PATH =
  /messages\.\d+\.content\.\d+:.*(?:thinking|redacted_thinking)/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the given error message indicates a provider has
 * rejected stored signed thinking / reasoning state on the latest assistant
 * turn during replay, across the seven targeted providers.
 *
 * Match logic: either (signature noun + rejection verb both fire) OR the
 * Anthropic JSON-path fast-path fires.
 */
export function isSignedReplayError(message: string): boolean {
  if (!message) return false;
  if (ANTHROPIC_JSON_PATH.test(message)) return true;
  return SIGNATURE_NOUN.test(message) && REJECTION_VERB.test(message);
}
