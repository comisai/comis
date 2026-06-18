// SPDX-License-Identifier: Apache-2.0
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

  // -------------------------------------------------------------------------
  // BUDGET-01: resetExecution(cap?) sets an OPTIONAL per-execution effective
  // cap for THIS run, scoped to one execution (cleared/replaced on the next
  // resetExecution). The shared per-agent guard must never leak one spawn's
  // tight cap into the agent's other runs (Pitfall 1), and a child can only
  // TIGHTEN — never RAISE — its budget above config.perExecution (min()).
  // -------------------------------------------------------------------------
  describe("resetExecution per-execution cap override", () => {
    it("enforces the tighter per-execution cap passed to resetExecution over config.perExecution", () => {
      const guard = createBudgetGuard(defaultConfig); // config.perExecution = 10_000
      guard.resetExecution(2_000);
      guard.recordUsage(1_500);
      // 1_500 + 600 = 2_100 > 2_000 effective cap, even though config is 10_000.
      const result = guard.checkBudget(600);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-execution");
        expect(result.error.currentUsage).toBe(1_500);
        expect(result.error.cap).toBe(2_000);
        expect(result.error.estimated).toBe(600);
      }
    });

    it("clears the tight cap on a subsequent bare resetExecution (no cross-run leak)", () => {
      const guard = createBudgetGuard(defaultConfig); // config.perExecution = 10_000
      guard.resetExecution(2_000); // sub-agent A: a tight 2_000 cap
      guard.resetExecution(); // sub-agent B on the SAME shared guard: back to config
      guard.recordUsage(5_000);
      // 5_000 + 0 = 5_000 < config.perExecution 10_000 — A's tight cap did NOT persist.
      const result = guard.checkBudget(0);
      expect(result.ok).toBe(true);
    });

    it("behaves exactly as today when resetExecution is called with no arg (config.perExecution bounds it)", () => {
      const guard = createBudgetGuard(defaultConfig); // config.perExecution = 10_000
      guard.resetExecution();
      guard.recordUsage(9_000);
      expect(guard.checkBudget(500).ok).toBe(true); // 9_500 <= 10_000
      const over = guard.checkBudget(1_500); // 10_500 > 10_000
      expect(over.ok).toBe(false);
      if (!over.ok) {
        expect(over.error.scope).toBe("per-execution");
        expect(over.error.cap).toBe(10_000);
      }
    });

    it("takes min(config.perExecution, cap) so a child cannot raise its budget above config", () => {
      const guard = createBudgetGuard(defaultConfig); // config.perExecution = 10_000
      guard.resetExecution(50_000); // cap > config — config must still bound it.
      guard.recordUsage(9_000);
      // Effective cap is min(10_000, 50_000) = 10_000, so 9_000 + 1_500 = 10_500 > 10_000.
      const result = guard.checkBudget(1_500);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.scope).toBe("per-execution");
        expect(result.error.cap).toBe(10_000);
      }
    });
  });

  // -------------------------------------------------------------------------
  // CR-01 (170-REVIEW): the per-execution dimension MUST be execution-local.
  // The BudgetGuard is created ONCE per agentId and shared across all of that
  // agent's executions. When a parallel graph runs two nodes resolving to the
  // SAME agentId concurrently, each calls resetExecution(cap) on the SAME
  // guard. If the per-execution cap + total live as module-level state on the
  // shared guard, exec B's resetExecution clobbers exec A's cap and wipes A's
  // accrued spend — a tight child cap is erased (silent budget bypass) and a
  // small sibling cap can falsely abort a large one.
  //
  // resetExecution(cap?) returns an execution-local window handle whose
  // checkBudget/recordUsage are scoped to ONE run; the per-hour/per-day rolling
  // windows stay shared per-agent (they are correctly per-agent).
  // -------------------------------------------------------------------------
  describe("CR-01: concurrent same-agent executions are budget-isolated", () => {
    it("each concurrent execution is bounded by ITS OWN cap and accrued spend on the shared guard", () => {
      // ONE shared per-agent guard, exactly as setup-agents-runtime creates it.
      const guard = createBudgetGuard(defaultConfig); // config.perExecution = 10_000

      // Two concurrent executions on the SAME guard with DIFFERENT caps.
      const execA = guard.resetExecution(2_000); // tight child cap
      const execB = guard.resetExecution(8_000); // large sibling cap

      // Interleave spend across both windows (the parallel-graph interleaving).
      execA.recordUsage(1_500); // A: 1_500 / 2_000
      execB.recordUsage(5_000); // B: 5_000 / 8_000

      // A is still bounded by capA=2_000 (NOT B's 8_000) and sees only A's spend:
      // 1_500 + 600 = 2_100 > 2_000 → A breaches on ITS OWN tight cap.
      const aOver = execA.checkBudget(600);
      expect(aOver.ok).toBe(false);
      if (!aOver.ok) {
        expect(aOver.error.scope).toBe("per-execution");
        expect(aOver.error.currentUsage).toBe(1_500); // A's spend, NOT polluted by B's 5_000
        expect(aOver.error.cap).toBe(2_000); // A's cap, NOT B's 8_000
      }

      // B is bounded by capB=8_000 and sees only B's spend:
      // 5_000 + 2_000 = 7_000 <= 8_000 → B is fine, NOT aborted by A's tight 2_000.
      const bOk = execB.checkBudget(2_000);
      expect(bOk.ok).toBe(true);

      // And B can be pushed to ITS OWN ceiling independently:
      // 5_000 + 3_500 = 8_500 > 8_000 → B breaches on capB, with B's own usage.
      const bOver = execB.checkBudget(3_500);
      expect(bOver.ok).toBe(false);
      if (!bOver.ok) {
        expect(bOver.error.scope).toBe("per-execution");
        expect(bOver.error.currentUsage).toBe(5_000); // B's spend, NOT A's 1_500
        expect(bOver.error.cap).toBe(8_000);
      }
    });

    it("a large concurrent sibling does NOT erase a tight child's accrued spend (silent-bypass guard)", () => {
      const guard = createBudgetGuard(defaultConfig);
      const child = guard.resetExecution(2_000); // tight cap
      child.recordUsage(1_900); // child near its cap

      // A large sibling starts concurrently AFTER the child accrued spend.
      const sibling = guard.resetExecution(9_000);
      sibling.recordUsage(100);

      // The child's tight cap MUST still fire: 1_900 + 200 = 2_100 > 2_000.
      // On the old shared-state code the sibling's resetExecution zeroed
      // executionTotal, so the child's spend was wiped and this check passed.
      const childOver = child.checkBudget(200);
      expect(childOver.ok).toBe(false);
      if (!childOver.ok) {
        expect(childOver.error.scope).toBe("per-execution");
        expect(childOver.error.currentUsage).toBe(1_900);
        expect(childOver.error.cap).toBe(2_000);
      }
    });

    it("the per-hour/per-day rolling windows stay SHARED across concurrent executions", () => {
      const guard = createBudgetGuard({ perExecution: 100_000, perHour: 6_000, perDay: 200_000 });
      const execA = guard.resetExecution(100_000);
      const execB = guard.resetExecution(100_000);

      execA.recordUsage(4_000); // contributes to the shared hourly window
      execB.recordUsage(4_000); // also contributes to the shared hourly window

      // Per-execution: each window sees only its own 4_000 (well under 100_000).
      // Per-hour: the SHARED window now holds 8_000 > perHour 6_000, so EITHER
      // execution's next checkBudget trips per-hour (the agent-wide cap is shared).
      const aHourly = execA.checkBudget(0);
      expect(aHourly.ok).toBe(false);
      if (!aHourly.ok) expect(aHourly.error.scope).toBe("per-hour");
      const bHourly = execB.checkBudget(0);
      expect(bHourly.ok).toBe(false);
      if (!bHourly.ok) expect(bHourly.error.scope).toBe("per-hour");
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
