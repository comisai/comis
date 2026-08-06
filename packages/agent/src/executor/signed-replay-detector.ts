// SPDX-License-Identifier: Apache-2.0
/**
 * Provider-agnostic signed-replay error detector.
 *
 * Detects provider rejections of stored signed thinking / reasoning state on
 * the latest assistant message during replay. Motivated by a real production
 * incident where Anthropic returned
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
 *   expired / mismatch, or spaced `encrypted content` verification failures.
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
  /thinking|redacted_thinking|reasoning_item|encrypted[_ ]content|thought_signature|reasoning_id/i;

/**
 * Rejection-verb regex: matches any of the verbs providers use to reject
 * tampered / stale / mismatched signed state. Pairing this with a signature
 * noun avoids matching unrelated `invalid` / `not found` errors (e.g. model
 * not found).
 */
const REJECTION_VERB =
  /cannot be modified|not found|invalid|mismatch|verification failed|could not be (?:verified|decrypted|parsed)|expired|tampered|stale/i;

/**
 * Anthropic JSON-path fast-path: matches the canonical Anthropic 400 error
 * shape `messages.N.content.M: ...thinking|redacted_thinking...`. This shape
 * always indicates signed-replay rejection regardless of which verb appears
 * in the surrounding text.
 */
const ANTHROPIC_JSON_PATH =
  /messages\.\d+\.content\.\d+:.*(?:thinking|redacted_thinking)/i;

/**
 * Generic error-envelope tokens that name the error TYPE rather than describe
 * the signed state. Anthropic wraps EVERY 400 in `invalid_request_error`, so
 * leaving these in the verb-matching text let the bare `invalid` verb fire for
 * any rejection whose body merely mentions a signature noun -- the envelope
 * alone must never constitute evidence of a replay rejection.
 */
const ERROR_ENVELOPE_TOKENS = /invalid_request_error|invalid_request|INVALID_ARGUMENT/gi;

/**
 * Capability / parameter rejections: the provider is refusing the SHAPE of the
 * request for this model, not the signed state carried inside it. These are
 * deterministic config errors -- scrubbing signature blocks cannot fix them,
 * and retrying reproduces them exactly. Motivated by a production incident
 * where `"thinking.type.enabled" is not supported for this model` was
 * classified as signed-replay: the noun came from the rejected parameter's own
 * name and the verb from the `invalid_request_error` envelope.
 */
const CAPABILITY_REJECTION =
  /\b(?:is )?not supported\b|\bunsupported\b|\b(?:unrecognized|unknown) (?:parameter|field|argument|property)\b/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the given error message indicates a provider has
 * rejected stored signed thinking / reasoning state on the latest assistant
 * turn during replay, across the seven targeted providers.
 *
 * Match logic, in order:
 *   1. The Anthropic JSON-path fast-path fires -- a positional reference into
 *      stored message content is unambiguous replay evidence, so it wins even
 *      if capability wording also appears.
 *   2. Capability/parameter rejection wording fires -> NOT a replay error.
 *   3. Signature noun + rejection verb both fire, ignoring generic error
 *      envelopes that carry no evidence about the signed state.
 */
export function isSignedReplayError(message: string): boolean {
  if (!message) return false;
  if (ANTHROPIC_JSON_PATH.test(message)) return true;
  if (CAPABILITY_REJECTION.test(message)) return false;
  const withoutEnvelope = message.replace(ERROR_ENVELOPE_TOKENS, " ");
  return SIGNATURE_NOUN.test(withoutEnvelope) && REJECTION_VERB.test(withoutEnvelope);
}
