import { describe, it, expect } from "vitest";
import {
  createTurnBudgetTracker,
  COMPLETION_THRESHOLD,
  DIMINISHING_DELTA_THRESHOLD,
  MAX_CONTINUATIONS,
} from "./turn-budget-tracker.js";

describe("createTurnBudgetTracker", () => {
  it("returns continue on first check with zero output tokens", () => {
    const tracker = createTurnBudgetTracker(500_000);
    const decision = tracker.check(0);
    expect(decision).toEqual({
      action: "continue",
      utilization: 0,
      reason: "under_budget",
    });
  });

  it("returns budget_reached when utilization >= 90%", () => {
    const tracker = createTurnBudgetTracker(500_000);
    const decision = tracker.check(450_001);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toBe("budget_reached");
    expect(decision.utilization).toBeCloseTo(0.900002, 4);
  });

  it("returns budget_reached at exact 90% boundary", () => {
    const tracker = createTurnBudgetTracker(500_000);
    const decision = tracker.check(450_000);
    expect(decision.action).toBe("stop");
    expect(decision.reason).toBe("budget_reached");
    expect(decision.utilization).toBe(0.9);
  });

  it("returns diminishing_returns when 2 consecutive deltas below 500 tokens", () => {
    const tracker = createTurnBudgetTracker(500_000);

    // First check: delta = 100000 (large, not diminishing) -- continuationCount becomes 1
    const d1 = tracker.check(100_000);
    expect(d1.action).toBe("continue");

    // Second check: delta = 300 (below threshold) -- only 1 low delta so far, continues
    // continuationCount becomes 2
    const d2 = tracker.check(100_300);
    expect(d2.action).toBe("continue");

    // Third check: delta = 200 (below threshold) -- 2 consecutive low deltas, stops
    // continuationCount is 2 (> 0), last 2 deltas are [300, 200] both < 500
    const d3 = tracker.check(100_500);
    expect(d3.action).toBe("stop");
    expect(d3.reason).toBe("diminishing_returns");
  });

  it("does not trigger diminishing returns on first continuation", () => {
    // Even if first delta is small, diminishing returns requires continuationCount > 0
    const tracker = createTurnBudgetTracker(500_000);

    // First check with small output -- continuationCount is 0
    const d1 = tracker.check(100);
    expect(d1.action).toBe("continue");
    expect(d1.reason).toBe("under_budget");
  });

  it("returns max_continuations after 3 continuations", () => {
    const tracker = createTurnBudgetTracker(10_000_000);

    // 3 continue decisions -- each increments continuationCount
    const d1 = tracker.check(0);
    expect(d1.action).toBe("continue"); // continuationCount becomes 1

    const d2 = tracker.check(1_000_000);
    expect(d2.action).toBe("continue"); // continuationCount becomes 2

    const d3 = tracker.check(2_000_000);
    expect(d3.action).toBe("continue"); // continuationCount becomes 3

    // Fourth check: continuationCount is 3 >= MAX_CONTINUATIONS
    const d4 = tracker.check(3_000_000);
    expect(d4.action).toBe("stop");
    expect(d4.reason).toBe("max_continuations");
  });

  it("prioritizes max_continuations over budget_reached", () => {
    // Use a target where large deltas keep us under 90% for 3 checks
    // but the 4th check exceeds 90% AND hits max_continuations
    const tracker = createTurnBudgetTracker(100_000);

    // Each check uses deltas >= 500 to avoid diminishing_returns
    tracker.check(10_000);  // util=0.1, cont becomes 1
    tracker.check(20_000);  // util=0.2, cont becomes 2
    tracker.check(30_000);  // util=0.3, cont becomes 3

    // Fourth check: cont=3 >= MAX_CONTINUATIONS AND util=0.95 >= 0.9
    // max_continuations is checked first
    const d = tracker.check(95_000);
    expect(d.action).toBe("stop");
    expect(d.reason).toBe("max_continuations");
  });

  it("calculates utilization as outputTokens / targetTokens", () => {
    const tracker = createTurnBudgetTracker(1_000_000);
    const decision = tracker.check(250_000);
    expect(decision.utilization).toBe(0.25);
  });

  it("exposes targetTokens property", () => {
    const tracker = createTurnBudgetTracker(500_000);
    expect(tracker.targetTokens).toBe(500_000);
  });

  it("tracks cumulative deltas correctly across multiple checks", () => {
    const tracker = createTurnBudgetTracker(500_000);

    // check(100000): delta = 100000
    tracker.check(100_000);
    // check(150000): delta = 50000
    tracker.check(150_000);
    // check(200000): delta = 50000
    tracker.check(200_000);
    // At this point: continuationCount = 3, so next check hits max_continuations
    const d = tracker.check(250_000);
    expect(d.action).toBe("stop");
    expect(d.reason).toBe("max_continuations");
    expect(d.utilization).toBe(0.5);
  });

  it("exports expected constants", () => {
    expect(COMPLETION_THRESHOLD).toBe(0.9);
    expect(DIMINISHING_DELTA_THRESHOLD).toBe(500);
    expect(MAX_CONTINUATIONS).toBe(3);
  });
});
