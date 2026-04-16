import { describe, it, expect } from "vitest";
import { createToolRetryBreaker, extractErrorTag } from "./tool-retry-breaker.js";
import type { ToolRetryBreaker } from "./tool-retry-breaker.js";

describe("tool retry breaker", () => {
  const defaultConfig = {
    maxConsecutiveFailures: 3,
    maxToolFailures: 5,
    suggestAlternatives: true,
    // High value so existing signature/tool-level tests aren't affected by error-pattern blocking
    maxConsecutiveErrorPatterns: 100,
  };

  function createBreaker(): ToolRetryBreaker {
    return createToolRetryBreaker(defaultConfig);
  }

  describe("beforeToolCall", () => {
    it("allows first call to any tool", () => {
      const breaker = createBreaker();
      const verdict = breaker.beforeToolCall("mcp__yfinance--get_recs", { symbol: "NVDA" });
      expect(verdict.block).toBe(false);
    });

    it("allows calls after successful results", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, true);

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(false);
    });

    it("blocks after 3 consecutive failures with same signature", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("mcp__yfinance--get_recs");
    });

    it("resets counter on success between failures", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      // 2 failures
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      // 1 success resets consecutive counter
      breaker.recordResult(tool, args, true);
      // 2 more failures -- consecutive count is 2, not 4
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(false);
    });

    it("blocks entire tool after 5 total failures regardless of args", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";

      // 5 failures with different args each time
      breaker.recordResult(tool, { symbol: "NVDA" }, false, "error");
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");
      breaker.recordResult(tool, { symbol: "GOOG" }, false, "error");
      breaker.recordResult(tool, { symbol: "MSFT" }, false, "error");
      breaker.recordResult(tool, { symbol: "TSLA" }, false, "error");

      // New args never seen before -- still blocked because tool-level threshold hit
      const verdict = breaker.beforeToolCall(tool, { symbol: "AMZN" });
      expect(verdict.block).toBe(true);
    });

    it("includes tool name and error pattern in block reason", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");
      breaker.recordResult(tool, args, false, "connection timeout");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("mcp__yfinance--get_recs");
      expect(verdict.reason).toContain("failed");
      expect(verdict.reason).toContain("connection timeout");
    });

    it("suggests alternative tools when available", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("web_search");
      expect(verdict.reason).toContain("mcp__tavily--tavily-search");
      expect(verdict.alternatives).toContain("web_search");
      expect(verdict.alternatives).toContain("mcp__tavily--tavily-search");
    });

    it("no alternatives for unknown tools", () => {
      const breaker = createBreaker();
      const tool = "some_random_tool";
      const args = { x: 1 };

      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");

      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("alternative approaches");
      expect(verdict.alternatives).toEqual([]);
    });
  });

  describe("fingerprinting", () => {
    it("treats same args in different order as identical", () => {
      const breaker = createBreaker();
      const tool = "some_tool";

      // Record failures with {a:1, b:2}
      breaker.recordResult(tool, { a: 1, b: 2 }, false, "error");
      breaker.recordResult(tool, { a: 1, b: 2 }, false, "error");
      // Record one more failure with {b:2, a:1} -- same fingerprint, should be 3rd consecutive
      breaker.recordResult(tool, { b: 2, a: 1 }, false, "error");

      const verdict = breaker.beforeToolCall(tool, { a: 1, b: 2 });
      expect(verdict.block).toBe(true);
    });

    it("treats different args as different signatures", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";

      // 2 failures for NVDA
      breaker.recordResult(tool, { symbol: "NVDA" }, false, "error");
      breaker.recordResult(tool, { symbol: "NVDA" }, false, "error");
      // 2 failures for AAPL
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");

      // Neither should be blocked yet (only 2 consecutive each)
      expect(breaker.beforeToolCall(tool, { symbol: "NVDA" }).block).toBe(false);
      expect(breaker.beforeToolCall(tool, { symbol: "AAPL" }).block).toBe(false);
    });
  });

  describe("error-pattern tracking", () => {
    const errorPatternConfig = {
      maxConsecutiveFailures: 3,
      maxToolFailures: 5,
      maxConsecutiveErrorPatterns: 2,
      suggestAlternatives: true,
    };

    function createErrorPatternBreaker(): ToolRetryBreaker {
      return createToolRetryBreaker(errorPatternConfig);
    }

    it("blocks after 2 same-error failures with different args", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "edit";

      // Two failures with same error tag "[not_read]" but different args
      breaker.recordResult(tool, { file: "file_a.ts" }, false, "File [not_read] error");
      breaker.recordResult(tool, { file: "file_b.ts" }, false, "File [not_read] error");

      const verdict = breaker.beforeToolCall(tool, { file: "file_c.ts" });
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("not_read");
    });

    it("resets ALL error-pattern counters for that tool on success", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "edit";

      // One failure with "[not_read]"
      breaker.recordResult(tool, { file: "file_a.ts" }, false, "File [not_read] error");
      // Success resets all error patterns for this tool
      breaker.recordResult(tool, { file: "file_b.ts" }, true);
      // Another failure with "[not_read]" — counter should be back to 1
      breaker.recordResult(tool, { file: "file_c.ts" }, false, "File [not_read] error");

      const verdict = breaker.beforeToolCall(tool, { file: "file_d.ts" });
      expect(verdict.block).toBe(false);
    });

    it("works alongside existing signature tracking (both can block independently)", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "some_tool";
      const args = { x: 1 };

      // Trigger signature-level block (3 consecutive with same args)
      breaker.recordResult(tool, args, false, "error A");
      breaker.recordResult(tool, args, false, "error A");
      breaker.recordResult(tool, args, false, "error A");

      // Signature block should fire
      expect(breaker.beforeToolCall(tool, args).block).toBe(true);

      // Error-pattern block should also fire for different args
      const breaker2 = createErrorPatternBreaker();
      breaker2.recordResult(tool, { y: 1 }, false, "error [tag_x]");
      breaker2.recordResult(tool, { y: 2 }, false, "error [tag_x]");

      expect(breaker2.beforeToolCall(tool, { y: 3 }).block).toBe(true);
    });

    it("error-pattern check runs BEFORE signature check in beforeToolCall", () => {
      const breaker = createErrorPatternBreaker();
      const tool = "edit";
      const args = { file: "test.ts" };

      // Set up error-pattern block (2 same-error, different args)
      breaker.recordResult(tool, { file: "a.ts" }, false, "[stuck]");
      breaker.recordResult(tool, { file: "b.ts" }, false, "[stuck]");

      // Also set up signature-level failures (but not enough to block — only 2)
      breaker.recordResult(tool, args, false, "different error");
      breaker.recordResult(tool, args, false, "different error");

      // Error-pattern block should catch this even though signature didn't hit threshold
      const verdict = breaker.beforeToolCall(tool, args);
      expect(verdict.block).toBe(true);
      expect(verdict.reason).toContain("stuck");
    });
  });

  describe("extractErrorTag", () => {
    it("extracts bracketed tags like [not_read]", () => {
      expect(extractErrorTag("File [not_read] error")).toBe("not_read");
    });

    it("extracts Validation failed prefix", () => {
      expect(extractErrorTag("Validation failed: missing field")).toBe("validation_failed");
    });

    it("fallback normalizes first 80 chars", () => {
      const tag = extractErrorTag("Something weird happened here!");
      expect(tag).toBe("something_weird_happened_here");
    });

    it("collapses consecutive underscores in fallback", () => {
      const tag = extractErrorTag("error: --- multiple --- separators");
      expect(tag).toBe("error_multiple_separators");
    });

    it("trims leading/trailing underscores in fallback", () => {
      const tag = extractErrorTag("!!!error!!!");
      expect(tag).toBe("error");
    });
  });

  describe("reset", () => {
    it("clears all state on reset", () => {
      const breaker = createBreaker();
      const tool = "mcp__yfinance--get_recs";
      const args = { symbol: "NVDA" };

      // Trigger both signature-level (3 consecutive) and tool-level (5 total) blocks
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, args, false, "error");
      breaker.recordResult(tool, { symbol: "AAPL" }, false, "error");
      breaker.recordResult(tool, { symbol: "GOOG" }, false, "error");
      expect(breaker.beforeToolCall(tool, args).block).toBe(true);
      expect(breaker.getBlockedTools().length).toBeGreaterThan(0);

      // Reset clears everything
      breaker.reset();

      expect(breaker.beforeToolCall(tool, args).block).toBe(false);
      expect(breaker.getBlockedTools()).toEqual([]);
    });
  });
});
