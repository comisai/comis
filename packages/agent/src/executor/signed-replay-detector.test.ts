// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the provider-agnostic signed-replay error detector.
 *
 * Verifies coverage across all seven targeted providers (Anthropic,
 * Bedrock-Claude, Google Gemini/Vertex/Gemini-CLI, OpenAI Responses,
 * OpenAI Completions reasoning, Mistral) plus negative cases.
 */

import { describe, it, expect } from "vitest";
import { isSignedReplayError } from "./signed-replay-detector.js";

describe("isSignedReplayError", () => {
  // -------------------------------------------------------------------------
  // Anthropic / Bedrock-Claude
  // -------------------------------------------------------------------------

  it("matches Anthropic JSON-path fast-path with thinking", () => {
    const msg =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.17: \'thinking\' or \'redacted_thinking\' blocks in the latest assistant message cannot be modified"}}';
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches Anthropic JSON-path fast-path with redacted_thinking", () => {
    const msg =
      "messages.13.content.4: redacted_thinking signature verification failed";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches Anthropic production-incident error shape", () => {
    // Verbatim error text from the production incident that motivated this detector.
    const msg =
      "400 invalid_request_error: messages.5.content.17: 'thinking' or 'redacted_thinking' blocks in the latest assistant message cannot be modified";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Google Gemini / Vertex / Gemini-CLI
  // -------------------------------------------------------------------------

  it("matches Gemini-shaped error with thought_signature mismatch", () => {
    const msg =
      "INVALID_ARGUMENT: thought_signature mismatch on tool_call block at index 2";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches Gemini-shaped error with thought_signature verification failed", () => {
    const msg = "thought_signature verification failed for assistant turn";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // OpenAI Responses (o-series)
  // -------------------------------------------------------------------------

  it("matches OpenAI Responses-shaped error with reasoning_item not found", () => {
    const msg =
      "400 invalid_request_error: reasoning_item rs_abc123 not found in conversation state";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches OpenAI Responses-shaped error with reasoning_item invalid", () => {
    const msg = "reasoning_item is invalid or has been modified";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // OpenAI Completions reasoning
  // -------------------------------------------------------------------------

  it("matches OpenAI Completions reasoning-shaped error with reasoning_id expired", () => {
    const msg =
      "400 invalid_request_error: reasoning_id rsn_xyz expired; please retry without it";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches OpenAI Completions reasoning-shaped error with reasoning_id not found", () => {
    const msg = "reasoning_id not found";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Mistral
  // -------------------------------------------------------------------------

  it("matches Mistral-shaped error with encrypted_content verification failed", () => {
    const msg =
      "Mistral API error: encrypted_content verification failed on assistant turn 4";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches Mistral-shaped error with encrypted_content tampered", () => {
    const msg = "encrypted_content tampered or corrupted";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches Mistral-shaped error with encrypted_content stale", () => {
    const msg = "encrypted_content is stale; cannot be replayed";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("matches spaced encrypted content verification wording", () => {
    const msg =
      "The encrypted content for item rs_test_item could not be verified. "
      + "Reason: Encrypted content could not be decrypted or parsed.";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Negative cases
  // -------------------------------------------------------------------------

  it("does not match generic 429 rate_limit_exceeded", () => {
    const msg = "429 rate_limit_exceeded: too many requests, please retry";
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match unrelated 400 error with no signature noun", () => {
    // Hits "invalid" verb but not signature noun, and not the Anthropic JSON-path
    const msg = "400 invalid_request_error: model not found in registry";
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match credit-exhausted billing error", () => {
    const msg =
      '400 invalid_request_error: Your credit balance is too low to access the Anthropic API';
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match auth-invalid error", () => {
    const msg = "401 unauthorized: invalid x-api-key";
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match overloaded error", () => {
    const msg = "529 overloaded";
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match content-filter error", () => {
    const msg = "Output blocked by content filter";
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match bare 'cannot be modified' without signature noun", () => {
    // Verb fires but no signature noun, and no JSON path
    const msg = "assistant.content.2 cannot be modified";
    expect(isSignedReplayError(msg)).toBe(false);
  });

  // Capability/parameter rejections: the provider is refusing the SHAPE of the
  // request for this model, not the signed state carried in it. Scrub-and-retry
  // cannot fix these, so classifying them as signed-replay burns an extra LLM
  // call and reports a "formatting issue" instead of the real cause.
  it("does not match the adaptive-thinking capability rejection", () => {
    // Verbatim wire error from the production incident: the generic
    // `invalid_request_error` envelope supplied the "invalid" verb while the
    // parameter name `thinking.type.enabled` supplied the "thinking" noun.
    const msg =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."},"request_id":"req_011CdiFuZtawr8drzdBmCtx9"}';
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match an unsupported-parameter rejection naming a signature noun", () => {
    const msg =
      '400 invalid_request_error: unsupported parameter "thinking" for this model';
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match an unrecognized-field rejection naming a signature noun", () => {
    const msg =
      '400 invalid_request_error: unrecognized field "reasoning_id" in request body';
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not treat the generic invalid_request_error envelope as a rejection verb", () => {
    // Envelope + signature noun only — no verb describing the signed state.
    const msg =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking budget must be at least 1024 tokens"}}';
    expect(isSignedReplayError(msg)).toBe(false);
  });

  it("does not match empty string", () => {
    expect(isSignedReplayError("")).toBe(false);
  });

  it("does not match arbitrary text", () => {
    expect(isSignedReplayError("Hello, world!")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case insensitivity
  // -------------------------------------------------------------------------

  it("is case-insensitive for signature noun", () => {
    const msg = "THOUGHT_SIGNATURE MISMATCH on assistant turn";
    expect(isSignedReplayError(msg)).toBe(true);
  });

  it("is case-insensitive for Anthropic JSON-path", () => {
    const msg = "MESSAGES.5.CONTENT.17: THINKING blocks";
    expect(isSignedReplayError(msg)).toBe(true);
  });
});
