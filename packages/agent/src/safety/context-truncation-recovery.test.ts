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

    it("detects 'request too large' phrasing", () => {
      expect(isContextOverflowError(new Error("request too large"))).toBe(true);
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
      (err as Error).cause = new Error("exceeds token limit");
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

    it("is case-insensitive", () => {
      expect(isContextOverflowError("CONTEXT_LENGTH_EXCEEDED")).toBe(true);
      expect(isContextOverflowError(new Error("PROMPT IS TOO LONG"))).toBe(true);
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
