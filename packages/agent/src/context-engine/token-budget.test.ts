// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { computeTokenBudget } from "./token-budget.js";

// ---------------------------------------------------------------------------
// computeTokenBudget
// ---------------------------------------------------------------------------

describe("computeTokenBudget", () => {
  it("computes correct budget for large model (200K context)", () => {
    const budget = computeTokenBudget(200_000, 5_000);

    // M = max(ceil(200000 * 5 / 100), 2048) = max(10000, 2048) = 10000
    expect(budget.safetyMarginTokens).toBe(10_000);
    // R = ceil(200000 * 25 / 100) = 50000
    expect(budget.contextRotBufferTokens).toBe(50_000);
    // O = 8192
    expect(budget.outputReserveTokens).toBe(8_192);
    // H = 200000 - 5000 - 8192 - 10000 - 50000 = 126808
    expect(budget.availableHistoryTokens).toBe(126_808);

    expect(budget.windowTokens).toBe(200_000);
    expect(budget.systemTokens).toBe(5_000);
  });

  it("applies safety margin floor for small model (32K context)", () => {
    const budget = computeTokenBudget(32_000, 3_000);

    // M = max(ceil(32000 * 5 / 100), 2048) = max(1600, 2048) = 2048
    expect(budget.safetyMarginTokens).toBe(2_048);
    // R = ceil(32000 * 25 / 100) = 8000
    expect(budget.contextRotBufferTokens).toBe(8_000);
    // O = 8192
    expect(budget.outputReserveTokens).toBe(8_192);
    // H = 32000 - 3000 - 8192 - 2048 - 8000 = 10760
    expect(budget.availableHistoryTokens).toBe(10_760);
  });

  it("clamps negative budget to zero", () => {
    // Very small context window with large system prompt overhead
    const budget = computeTokenBudget(4_000, 3_000);

    // M = max(ceil(4000 * 5 / 100), 2048) = max(200, 2048) = 2048
    // R = ceil(4000 * 25 / 100) = 1000
    // H = 4000 - 3000 - 8192 - 2048 - 1000 = -10240 -> clamped to 0
    expect(budget.availableHistoryTokens).toBe(0);
    expect(budget.safetyMarginTokens).toBe(2_048);
    expect(budget.contextRotBufferTokens).toBe(1_000);
  });

  it("computes correctly with zero system tokens", () => {
    const budget = computeTokenBudget(128_000, 0);

    // M = max(ceil(128000 * 5 / 100), 2048) = max(6400, 2048) = 6400
    expect(budget.safetyMarginTokens).toBe(6_400);
    // R = ceil(128000 * 25 / 100) = 32000
    expect(budget.contextRotBufferTokens).toBe(32_000);
    // O = 8192
    expect(budget.outputReserveTokens).toBe(8_192);
    // H = 128000 - 0 - 8192 - 6400 - 32000 = 81408
    expect(budget.availableHistoryTokens).toBe(81_408);
    expect(budget.systemTokens).toBe(0);
  });

  it("all budget components are non-negative for various inputs", () => {
    const testCases = [
      [200_000, 5_000],
      [32_000, 3_000],
      [4_000, 3_000],
      [128_000, 0],
      [8_000, 8_000],
      [1_000, 500],
      [1_000_000, 10_000],
    ] as const;

    for (const [contextWindow, systemTokens] of testCases) {
      const budget = computeTokenBudget(contextWindow, systemTokens);
      expect(budget.windowTokens).toBeGreaterThanOrEqual(0);
      expect(budget.systemTokens).toBeGreaterThanOrEqual(0);
      expect(budget.outputReserveTokens).toBeGreaterThanOrEqual(0);
      expect(budget.safetyMarginTokens).toBeGreaterThanOrEqual(0);
      expect(budget.contextRotBufferTokens).toBeGreaterThanOrEqual(0);
      expect(budget.availableHistoryTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it("budget breakdown sums correctly (overhead + available <= window)", () => {
    const testCases = [
      [200_000, 5_000],
      [32_000, 3_000],
      [128_000, 0],
      [1_000_000, 10_000],
    ] as const;

    for (const [contextWindow, systemTokens] of testCases) {
      const budget = computeTokenBudget(contextWindow, systemTokens);
      const totalUsed =
        budget.systemTokens +
        budget.outputReserveTokens +
        budget.safetyMarginTokens +
        budget.contextRotBufferTokens +
        budget.availableHistoryTokens;
      expect(totalUsed).toBeLessThanOrEqual(budget.windowTokens);
    }
  });

  it("returns exact window/system values passed in", () => {
    const budget = computeTokenBudget(100_000, 7_500);
    expect(budget.windowTokens).toBe(100_000);
    expect(budget.systemTokens).toBe(7_500);
  });

  it("reduces available history when system tokens are provided", () => {
    const budgetWithoutSystem = computeTokenBudget(200_000, 0);
    const budgetWithSystem = computeTokenBudget(200_000, 8_600);

    // System tokens should reduce available history by exactly the estimate
    expect(budgetWithSystem.availableHistoryTokens).toBe(
      budgetWithoutSystem.availableHistoryTokens - 8_600,
    );
    expect(budgetWithSystem.systemTokens).toBe(8_600);
  });

  it("passes through cache fence index", () => {
    const budget = computeTokenBudget(200_000, 5_000, 42);
    expect(budget.cacheFenceIndex).toBe(42);
  });

  it("defaults cache fence to -1 when omitted", () => {
    const budget = computeTokenBudget(200_000, 5_000);
    expect(budget.cacheFenceIndex).toBe(-1);
  });
});
