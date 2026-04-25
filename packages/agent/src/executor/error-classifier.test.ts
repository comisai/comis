// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { classifyError, classifyPromptTimeout } from "./error-classifier.js";

describe("classifyError", () => {
  it("classifies Anthropic credit exhaustion as credit_exhausted", () => {
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("credit_exhausted");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("billing");
    expect(result.userMessage).toContain("administrator");
    // Must not leak raw error
    expect(result.userMessage).not.toContain("credit balance is too low");
    expect(result.userMessage).not.toContain("Anthropic");
  });

  it("classifies rate limiting (429) as rate_limited", () => {
    const error = new Error("429 Too Many Requests");
    const result = classifyError(error);
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("wait");
  });

  it("classifies rate limit by message content", () => {
    const error = new Error("Rate limit exceeded, please retry after 30s");
    const result = classifyError(error);
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("classifies auth errors as auth_invalid", () => {
    const error = new Error("401 Invalid API key provided");
    const result = classifyError(error);
    expect(result.category).toBe("auth_invalid");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("administrator");
    // Must not leak API key details
    expect(result.userMessage).not.toContain("API key");
    expect(result.userMessage).not.toContain("401");
  });

  it("classifies overloaded (503) as overloaded", () => {
    const error = new Error("503 Service Unavailable");
    const result = classifyError(error);
    expect(result.category).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  it("classifies Anthropic overloaded (529) as overloaded", () => {
    const error = new Error("529 Overloaded");
    const result = classifyError(error);
    expect(result.category).toBe("overloaded");
    expect(result.retryable).toBe(true);
  });

  it("classifies context window exceeded", () => {
    const error = new Error("This request exceeds the maximum context length");
    const result = classifyError(error);
    expect(result.category).toBe("context_too_long");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("new conversation");
  });

  it("classifies content filtering", () => {
    const error = new Error("Output blocked by content filter");
    const result = classifyError(error);
    expect(result.category).toBe("content_filtered");
    expect(result.retryable).toBe(true);
  });

  it("classifies Anthropic thinking-block JSON-path error (400) as client_request_signed_replay", () => {
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.13.content.5 thinking/redacted_thinking blocks cannot be modified"}}'
    );
    const result = classifyError(error);
    // Re-classified by Fix #1: signature noun + verb + JSON path all hit,
    // so this is the more-specific signed-replay subcategory. Retryable
    // because the runner scrubs signed state and re-enters the model retry chain.
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
    // userMessage must not leak raw provider internals
    expect(result.userMessage).not.toContain("thinking/redacted_thinking");
    expect(result.userMessage).not.toContain("invalid_request_error");
    expect(result.userMessage).not.toContain("messages.13");
    expect(result.userMessage).not.toContain("400");
    // Self-heal messaging emphasizes automatic recovery, not reset.
    expect(result.userMessage.toLowerCase()).toContain("automatically");
  });

  it('classifies bare "cannot be modified" without signature noun as client_request', () => {
    // No signature noun, no Anthropic JSON-path -- falls through to plain
    // client_request and remains non-retryable.
    const error = new Error("assistant.content.2 cannot be modified");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("classifies 422 unprocessable_entity as client_request", () => {
    const error = new Error("422 Unprocessable Entity");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("classifies generic unprocessable_entity string as client_request", () => {
    const error = new Error("provider returned unprocessable_entity");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("classifies malformed request payloads as client_request", () => {
    const error = new Error("malformed request payload at field 'messages'");
    const result = classifyError(error);
    expect(result.category).toBe("client_request");
    expect(result.retryable).toBe(false);
  });

  it("signed_replay userMessage is safe, human-readable, and never leaks internals", () => {
    // Same shape as the production-incident error: signature noun + verb +
    // Anthropic JSON-path all fire, so this classifies as the signed-replay
    // subcategory. Same safety guarantees as plain client_request.
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1 thinking/redacted_thinking blocks cannot be modified","api_key":"sk-ant-abc123","host":"api.anthropic.com"}}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.userMessage).not.toContain("sk-ant");
    expect(result.userMessage).not.toContain("anthropic.com");
    expect(result.userMessage).not.toContain("api_key");
    expect(result.userMessage).not.toContain("thinking");
    expect(result.userMessage).not.toContain("{");
    // Positive content: reads like a human-facing message
    expect(result.userMessage).toMatch(/request|conversation|formatting|automatically/i);
  });

  // -------------------------------------------------------------------------
  // Provider-agnostic signed-replay (Fix #1)
  // -------------------------------------------------------------------------

  it("classifies Gemini-flavored thoughtSignature mismatch as client_request_signed_replay", () => {
    const error = new Error(
      "INVALID_ARGUMENT: thought_signature mismatch on tool_call block at index 2"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).not.toContain("thought_signature");
  });

  it("classifies OpenAI Responses reasoning_item not_found as client_request_signed_replay", () => {
    const error = new Error(
      "400 invalid_request_error: reasoning_item rs_abc123 not found in conversation state"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).not.toContain("reasoning_item");
    expect(result.userMessage).not.toContain("rs_abc123");
  });

  it("classifies Mistral encrypted_content verification failure as client_request_signed_replay", () => {
    const error = new Error(
      "Mistral API error: encrypted_content verification failed on assistant turn 4"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
  });

  it("classifies OpenAI Completions reasoning_id expired as client_request_signed_replay", () => {
    const error = new Error(
      "400 invalid_request_error: reasoning_id rsn_xyz expired"
    );
    const result = classifyError(error);
    expect(result.category).toBe("client_request_signed_replay");
    expect(result.retryable).toBe(true);
  });

  it("regression: content_filtered still wins over client_request when content-filter keywords present", () => {
    // "blocked" is in content_filtered pattern; must not be stolen by client_request.
    const error = new Error("Output blocked by content filter");
    const result = classifyError(error);
    expect(result.category).toBe("content_filtered");
  });

  it("regression: credit_exhausted still wins over client_request even when invalid_request_error is present", () => {
    // Real Anthropic billing error carries type: invalid_request_error too;
    // credit_exhausted must remain authoritative because it sits earlier in the pattern table.
    const error = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."}}'
    );
    const result = classifyError(error);
    expect(result.category).toBe("credit_exhausted");
  });

  it("returns unknown for unrecognized errors", () => {
    const error = new Error("Something completely unexpected happened");
    const result = classifyError(error);
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("error occurred");
  });

  it("handles string errors", () => {
    const result = classifyError("credit balance is too low");
    expect(result.category).toBe("credit_exhausted");
  });

  it("handles non-Error objects", () => {
    const result = classifyError({ code: 429, message: "rate limit" });
    expect(result.category).toBe("rate_limited");
  });

  it("handles null/undefined gracefully", () => {
    expect(classifyError(null).category).toBe("unknown");
    expect(classifyError(undefined).category).toBe("unknown");
  });

  it("checks error cause chain", () => {
    const inner = new Error("credit balance is too low");
    const outer = new Error("Request failed", { cause: inner });
    const result = classifyError(outer);
    expect(result.category).toBe("credit_exhausted");
  });

  it("never leaks raw error content in any category", () => {
    const testErrors = [
      new Error('400 {"error":"credit balance is too low","key":"sk-ant-abc123"}'),
      new Error("429 rate limit at https://api.anthropic.com/v1/messages"),
      new Error("401 invalid x-api-key sk-ant-secret-key"),
      new Error("503 service unavailable internal-server.anthropic.com"),
    ];
    for (const error of testErrors) {
      const result = classifyError(error);
      expect(result.userMessage).not.toContain("sk-ant");
      expect(result.userMessage).not.toContain("anthropic.com");
      expect(result.userMessage).not.toContain("api.anthropic");
    }
  });
});

describe("classifyPromptTimeout", () => {
  it("returns prompt_timeout category", () => {
    const result = classifyPromptTimeout(120_000);
    expect(result.category).toBe("prompt_timeout");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("too long");
  });
});

// ---------------------------------------------------------------------------
// Silent LLM failure classification
// ---------------------------------------------------------------------------
//
// When a toolResult arrives with empty content, the LLM produces no text
// (finishReason:"stop"). The executor strips empty turns and retries once;
// if that also produces empty, it throws `Silent LLM failure: …`. Without
// an explicit classifier pattern, that error fell through to UNKNOWN_ERROR
// and the user saw "An error occurred while processing your request. Please
// try again." — which was the Telegram reply observed during the xlsx skill
// install (see auto-background-middleware regression).

describe("classifyError — Silent LLM failure", () => {
  it("classifies the exact retry-path error string", () => {
    const error = new Error(
      "Silent LLM failure: 2 LLM call(s) produced empty response after retry (finishReason: stop)",
    );
    const result = classifyError(error);
    expect(result.category).not.toBe("unknown");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).not.toBe(
      "An error occurred while processing your request. Please try again.",
    );
    expect(result.userMessage.toLowerCase()).toContain("tool call");
  });

  it("classifies the first-attempt error string (no retry suffix)", () => {
    const error = new Error(
      "Silent LLM failure: 1 LLM call(s) produced empty response (finishReason: stop)",
    );
    const result = classifyError(error);
    expect(result.category).not.toBe("unknown");
    expect(result.retryable).toBe(true);
    expect(result.userMessage.toLowerCase()).toMatch(/tool call|no output|try again/);
  });

  it("regression: overloaded still wins over silent-failure when both keywords appear", () => {
    // Defensive: a hypothetical combined message must still classify under
    // the more-specific upstream pattern, so operators aren't misled.
    const error = new Error("529 overloaded — silent LLM failure");
    const result = classifyError(error);
    expect(result.category).toBe("overloaded");
  });

  it("silent-failure classification does not leak internals", () => {
    const error = new Error(
      "Silent LLM failure: 2 LLM call(s) produced empty response after retry "
      + "(finishReason: stop) — host api.anthropic.com key sk-ant-secret123",
    );
    const result = classifyError(error);
    expect(result.userMessage).not.toContain("sk-ant");
    expect(result.userMessage).not.toContain("anthropic.com");
    expect(result.userMessage).not.toContain("finishReason");
  });
});
