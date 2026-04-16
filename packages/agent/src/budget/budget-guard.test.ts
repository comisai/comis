import type { BudgetConfig } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBudgetGuard, BudgetError } from "./budget-guard.js";

describe("BudgetGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultConfig: BudgetConfig = {
    perExecution: 10_000,
    perHour: 50_000,
    perDay: 200_000,
  };

  describe("estimateCost", () => {
    it("estimates tokens from context chars using SDK-derived chars/4 ratio", () => {
      const guard = createBudgetGuard(defaultConfig);
      // 3000 chars / 4 = 750 input tokens + 500 output = 1250
      const estimate = guard.estimateCost(3000, 500);
      expect(estimate).toBe(1250);
    });

    it("rounds up fractional token estimates", () => {
      const guard = createBudgetGuard(defaultConfig);
      // 100 chars / 4 = 25 + 200 output = 225
      const estimate = guard.estimateCost(100, 200);
      expect(estimate).toBe(225);
    });

    it("handles zero context chars", () => {
      const guard = createBudgetGuard(defaultConfig);
      const estimate = guard.estimateCost(0, 500);
      expect(estimate).toBe(500);
    });

    it("handles zero max output tokens", () => {
      const guard = createBudgetGuard(defaultConfig);
      // 3000 chars / 4 = 750
      const estimate = guard.estimateCost(3000, 0);
      expect(estimate).toBe(750);
    });

    it("logs pre-execution estimate at DEBUG level when logger provided", () => {
      const mockLogger = { debug: vi.fn(), warn: vi.fn() };
      const guard = createBudgetGuard(defaultConfig, mockLogger);
      // 4000 chars / 4 = 1000 input tokens + 500 output = 1500
      guard.estimateCost(4000, 500);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { contextChars: 4000, inputTokens: 1000, maxOutputTokens: 500, totalEstimate: 1500 },
        "Pre-execution cost estimate",
      );
    });
  });

  describe("discrepancy detection", () => {
    it("logs WARN when actual usage diverges significantly from estimate", () => {
      const mockLogger = { debug: vi.fn(), warn: vi.fn() };
      const guard = createBudgetGuard(defaultConfig, mockLogger);
      // 4000 chars / 4 = 1000 input + 500 output = 1500 estimate
      guard.estimateCost(4000, 500);
      // Actual usage 4000 >> 1500 estimate (ratio 2.67, well above 50% threshold)
      guard.recordUsage(4000);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          estimated: 1500,
          actual: 4000,
          hint: "Token estimate diverged significantly from actual API usage; budget may over/under-protect",
          errorKind: "validation",
        }),
        "Token estimate vs actual discrepancy",
      );
    });

    it("does not log WARN when actual usage is close to estimate", () => {
      const mockLogger = { debug: vi.fn(), warn: vi.fn() };
      const guard = createBudgetGuard(defaultConfig, mockLogger);
      // 4000 chars / 4 = 1000 input + 500 output = 1500 estimate
      guard.estimateCost(4000, 500);
      // Actual 1600 is within 50% of 1500 estimate (|1600 - 1500| / 1500 = 0.067)
      guard.recordUsage(1600);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("does not re-trigger WARN on repeated recordUsage without new estimate", () => {
      const mockLogger = { debug: vi.fn(), warn: vi.fn() };
      const guard = createBudgetGuard(defaultConfig, mockLogger);
      guard.estimateCost(4000, 500);
      guard.recordUsage(4000); // triggers WARN
      mockLogger.warn.mockClear();
      guard.recordUsage(4000); // should NOT trigger WARN (lastEstimate reset to 0)
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("checkBudget", () => {
    it("returns ok when under all caps", () => {
      const guard = createBudgetGuard(defaultConfig);
      const result = guard.checkBudget(5000);
      expect(result.ok).toBe(true);
    });

    it("returns err with scope 'per-execution' when execution total + estimate exceeds perExecution", () => {
      const guard = createBudgetGuard(defaultConfig);
      guard.recordUsage(8000);
      const result = guard.checkBudget(3000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(BudgetError);
        expect(result.error.scope).toBe("per-execution");
        expect(result.error.currentUsage).toBe(8000);
        expect(result.error.cap).toBe(10_000);
        expect(result.error.estimated).toBe(3000);
      }
    });

    it("returns ok when exactly at per-execution cap", () => {
      const guard = createBudgetGuard(defaultConfig);
      guard.recordUsage(5000);
      const result = guard.checkBudget(5000);
      expect(result.ok).toBe(true);
    });

    it("returns err with scope 'per-hour' when hourly window + estimate exceeds perHour", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 10_000, perDay: 200_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(8000);
      guard.resetExecution();
      const result = guard.checkBudget(3000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-hour");
        expect(result.error.currentUsage).toBe(8000);
        expect(result.error.cap).toBe(10_000);
        expect(result.error.estimated).toBe(3000);
      }
    });

    it("returns err with scope 'per-day' when daily window + estimate exceeds perDay", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 100_000, perDay: 10_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(8000);
      guard.resetExecution();
      const result = guard.checkBudget(3000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-day");
        expect(result.error.currentUsage).toBe(8000);
        expect(result.error.cap).toBe(10_000);
        expect(result.error.estimated).toBe(3000);
      }
    });

    it("checks per-execution before per-hour before per-day", () => {
      // All three caps would be exceeded, but per-execution should be reported first
      const config: BudgetConfig = { perExecution: 5000, perHour: 5000, perDay: 5000 };
      const guard = createBudgetGuard(config);
      guard.recordUsage(4000);
      const result = guard.checkBudget(2000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-execution");
      }
    });

    it("includes diagnostic information in BudgetError message", () => {
      const guard = createBudgetGuard(defaultConfig);
      guard.recordUsage(9000);
      const result = guard.checkBudget(2000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("per-execution");
        expect(result.error.message).toContain("9000");
        expect(result.error.message).toContain("10000");
        expect(result.error.message).toContain("2000");
      }
    });
  });

  describe("recordUsage", () => {
    it("accumulates tokens in execution total", () => {
      const guard = createBudgetGuard(defaultConfig);
      guard.recordUsage(3000);
      guard.recordUsage(4000);
      // 7000 + 4000 = 11000 > 10000 per-execution cap
      const result = guard.checkBudget(4000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-execution");
        expect(result.error.currentUsage).toBe(7000);
      }
    });

    it("accumulates tokens in rolling windows", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 10_000, perDay: 200_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(3000);
      guard.resetExecution();
      guard.recordUsage(3000);
      guard.resetExecution();
      guard.recordUsage(3000);
      guard.resetExecution();
      // Hourly: 9000. Next check of 2000 would be 11000 > 10000
      const result = guard.checkBudget(2000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-hour");
        expect(result.error.currentUsage).toBe(9000);
      }
    });
  });

  describe("rolling window pruning", () => {
    it("prunes hourly entries older than 1 hour on checkBudget", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 10_000, perDay: 200_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(8000);
      guard.resetExecution();

      // Advance past 1 hour
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      // The old 8000 tokens should be pruned from hourly window
      const result = guard.checkBudget(5000);
      expect(result.ok).toBe(true);
    });

    it("prunes daily entries older than 1 day on checkBudget", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 100_000, perDay: 10_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(8000);
      guard.resetExecution();

      // Advance past 1 day
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

      // The old 8000 tokens should be pruned from daily window
      const result = guard.checkBudget(5000);
      expect(result.ok).toBe(true);
    });

    it("retains recent entries within the rolling window", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 10_000, perDay: 200_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(5000);
      guard.resetExecution();

      // Advance 30 minutes (within hour)
      vi.advanceTimersByTime(30 * 60 * 1000);

      guard.recordUsage(3000);
      guard.resetExecution();

      // Hourly: 5000 + 3000 = 8000; requesting 3000 would be 11000 > 10000
      const result = guard.checkBudget(3000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-hour");
      }
    });
  });

  describe("resetExecution", () => {
    it("resets per-execution counter", () => {
      const guard = createBudgetGuard(defaultConfig);
      guard.recordUsage(9000);

      guard.resetExecution();

      // After reset, execution total is 0; 9000 estimate is under 10000 cap
      const result = guard.checkBudget(9000);
      expect(result.ok).toBe(true);
    });

    it("does not reset rolling windows", () => {
      const config: BudgetConfig = { perExecution: 100_000, perHour: 10_000, perDay: 200_000 };
      const guard = createBudgetGuard(config);

      guard.recordUsage(8000);
      guard.resetExecution();

      // Execution is reset, but hourly still has 8000
      // 8000 + 3000 = 11000 > 10000 per-hour
      const result = guard.checkBudget(3000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-hour");
      }
    });
  });

  describe("BudgetError", () => {
    it("is an instance of Error", () => {
      const error = new BudgetError("per-execution", 8000, 10000, 3000);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("BudgetError");
    });

    it("exposes scope, currentUsage, cap, and estimated properties", () => {
      const error = new BudgetError("per-hour", 45000, 50000, 10000);
      expect(error.scope).toBe("per-hour");
      expect(error.currentUsage).toBe(45000);
      expect(error.cap).toBe(50000);
      expect(error.estimated).toBe(10000);
    });
  });
});
