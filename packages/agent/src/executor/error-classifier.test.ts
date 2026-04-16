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
