// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  isContextOverflowError,
  truncateContextForRecovery,
} from "./context-truncation-recovery.js";

describe("context-truncation-recovery", () => {
  describe("isContextOverflowError", () => {
    it("detects string error with context_length_exceeded", () => {
      expect(isContextOverflowError("context_length_exceeded")).toBe(true);
    });

    it("detects Error with overflow message", () => {
      expect(isContextOverflowError(new Error("prompt is too long"))).toBe(true);
    });

    it("detects 'maximum context length' phrasing", () => {
      expect(isContextOverflowError(new Error("This model's maximum context length is 200000 tokens"))).toBe(true);
    });

    it("detects 'token limit' phrasing", () => {
      expect(isContextOverflowError(new Error("token limit exceeded for this request"))).toBe(true);
    });

    it("detects 'too many tokens' phrasing", () => {
      expect(isContextOverflowError("too many tokens in request")).toBe(true);
    });

    it("detects Anthropic's request_too_large wire type (HTTP 413 byte-size overflow)", () => {
      expect(isContextOverflowError(new Error("413 request_too_large: Request exceeds the maximum size"))).toBe(true);
    });

    it("does NOT flag 'Request too large … tokens per min (TPM)' — OpenAI 429 throttling, not overflow", () => {
      // OpenAI formats TPM rate-limit rejections as "Request too large for
      // <model> … on tokens per min (TPM) …". Truncating the conversation on a
      // transient throttle would silently destroy context; only the
      // underscore wire type request_too_large is a real overflow signal.
      expect(
        isContextOverflowError(
          new Error(
            "Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 40000.",
          ),
        ),
      ).toBe(false);
    });

    it("detects API error object shape", () => {
      const apiError = {
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "prompt is too long: 250000 tokens > 200000 maximum context length",
        },
      };
      expect(isContextOverflowError(apiError)).toBe(true);
    });

    it("detects nested error.error.type with context pattern", () => {
      const apiError = {
        error: { type: "context_length_exceeded", message: "too long" },
      };
      expect(isContextOverflowError(apiError)).toBe(true);
    });

    it("detects Error with cause", () => {
      const err = new Error("request failed");
      (err as Error).cause = new Error("prompt is too long: 250000 tokens > 200000 maximum");
      expect(isContextOverflowError(err)).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(isContextOverflowError(new Error("network timeout"))).toBe(false);
      expect(isContextOverflowError("authentication failed")).toBe(false);
      expect(isContextOverflowError(new Error("rate limited"))).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isContextOverflowError(null)).toBe(false);
      expect(isContextOverflowError(undefined)).toBe(false);
    });

    it("returns false for non-error objects without overflow patterns", () => {
      expect(isContextOverflowError({ status: 500, message: "internal error" })).toBe(false);
    });

    it("matches overflow patterns case-insensitively across upper-case error messages", () => {
      expect(isContextOverflowError("CONTEXT_LENGTH_EXCEEDED")).toBe(true);
      expect(isContextOverflowError(new Error("PROMPT IS TOO LONG"))).toBe(true);
    });

    // -------------------------------------------------------------------------
    // SDK detector adoption: provider catalog + non-overflow exclusions.
    // The detection axis rides the pi SDK's isContextOverflow (per-provider
    // patterns plus throttling/rate-limit exclusions); only the error-shape
    // candidate extraction stays Comis-owned.
    // -------------------------------------------------------------------------

    describe("SDK detector adoption", () => {
      it("does NOT flag Bedrock throttling that mentions tokens", () => {
        // Bedrock formats throttling as "Throttling error: Too many tokens,
        // please wait before trying again." — matching it as overflow would
        // truncate the conversation on a transient, retryable condition.
        expect(
          isContextOverflowError(
            new Error("Throttling error: Too many tokens, please wait before trying again."),
          ),
        ).toBe(false);
      });

      it("does NOT flag rate-limit errors that mention tokens", () => {
        expect(
          isContextOverflowError("rate limit reached: too many tokens per minute for this org"),
        ).toBe(false);
      });

      it("detects Together AI 'input … longer than the model's context length' phrasing", () => {
        expect(
          isContextOverflowError(
            new Error(
              "The input (265330 tokens) is longer than the model's context length (262144 tokens).",
            ),
          ),
        ).toBe(true);
      });

      it("detects Groq 'reduce the length of the messages' phrasing", () => {
        expect(
          isContextOverflowError(new Error("Please reduce the length of the messages or completion.")),
        ).toBe(true);
      });

      it("detects LM Studio 'greater than the context length' phrasing", () => {
        expect(
          isContextOverflowError(
            "tokens to keep from the initial prompt is greater than the context length",
          ),
        ).toBe(true);
      });

      it("detects Google Gemini input-token-count phrasing", () => {
        expect(
          isContextOverflowError(
            new Error(
              "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
            ),
          ),
        ).toBe(true);
      });
    });
  });

  describe("truncateContextForRecovery", () => {
    it("returns shouldRetry: true when messages exceed keepCount", () => {
      const result = truncateContextForRecovery(20);
      expect(result.shouldRetry).toBe(true);
      expect(result.keepCount).toBe(4);
      expect(result.reason).toContain("Truncating from 20 to 4");
    });

    it("uses custom keepCount", () => {
      const result = truncateContextForRecovery(30, { keepCount: 10 });
      expect(result.shouldRetry).toBe(true);
      expect(result.keepCount).toBe(10);
    });

    it("returns shouldRetry: false when at minimum messages", () => {
      const result = truncateContextForRecovery(2);
      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toContain("minimum size");
    });

    it("returns shouldRetry: false when below minimum messages", () => {
      const result = truncateContextForRecovery(1);
      expect(result.shouldRetry).toBe(false);
    });

    it("returns shouldRetry: false when totalMessages equals keepCount", () => {
      const result = truncateContextForRecovery(4);
      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toContain("too short to trim");
    });

    it("returns shouldRetry: false when totalMessages less than keepCount", () => {
      const result = truncateContextForRecovery(3);
      expect(result.shouldRetry).toBe(false);
    });

    it("uses custom minMessages", () => {
      const result = truncateContextForRecovery(3, { minMessages: 3 });
      expect(result.shouldRetry).toBe(false);
      expect(result.reason).toContain("minimum size");
    });

    it("handles exactly keepCount + 1 (boundary)", () => {
      const result = truncateContextForRecovery(5);
      expect(result.shouldRetry).toBe(true);
      expect(result.keepCount).toBe(4);
    });

    it("always returns a reason string", () => {
      expect(truncateContextForRecovery(1).reason).toBeTruthy();
      expect(truncateContextForRecovery(4).reason).toBeTruthy();
      expect(truncateContextForRecovery(100).reason).toBeTruthy();
    });

    // -----------------------------------------------------------------------
    // MCP tool results in conversation
    // -----------------------------------------------------------------------

    describe("MCP tool results in conversation", () => {
      it("truncates conversations containing MCP tool results", () => {
        // Simulate a conversation with 20 messages including MCP tool results.
        // MCP tool results are regular messages in the array, so message count
        // is all that matters for the truncation strategy.
        // user(1) + assistant(2) + mcp_toolResult(3) + user(4) + ... = 20
        const result = truncateContextForRecovery(20);
        expect(result.shouldRetry).toBe(true);
        expect(result.keepCount).toBe(4);
        expect(result.reason).toContain("Truncating from 20 to 4");
      });

      it("handles minimal conversations with single MCP tool result", () => {
        // user(1) + assistant(2) + mcp_toolResult(3) = 3 messages
        const result = truncateContextForRecovery(3);
        expect(result.shouldRetry).toBe(false);
        expect(result.reason).toContain("too short to trim");
      });
    });
  });
});
