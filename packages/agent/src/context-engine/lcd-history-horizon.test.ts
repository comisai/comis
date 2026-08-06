// SPDX-License-Identifier: Apache-2.0
/**
 * History-horizon quantization — keeping the evicted prefix's left edge stable
 * across turns so the provider's prompt cache can hit.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  HISTORY_BUDGET_QUANTUM_TOKENS,
  quantizeHistoryBudget,
} from "./lcd-history-horizon.js";

describe("quantizeHistoryBudget", () => {
  it("absorbs the per-call jitter that moved the horizon every turn", () => {
    // Measured live on comis-moshe: shipHistoryBudget wobbled across consecutive
    // turns of one conversation because it is derived from S and the fresh-tail
    // preamble, both of which vary per call. Each distinct value picked a
    // different oldest-kept step, rewriting message[0] and invalidating the whole
    // ~130k cached prefix.
    const observed = [82896, 83217, 82890, 83379];
    const quantized = new Set(observed.map(quantizeHistoryBudget));
    expect(quantized.size).toBe(1);
  });

  it("never returns more than it was given, so the budget stays a ceiling", () => {
    for (const budget of [0, 1, 4095, 8191, 8192, 100000, 131072]) {
      expect(quantizeHistoryBudget(budget)).toBeLessThanOrEqual(budget);
    }
  });

  it("floors to the quantum grid", () => {
    expect(quantizeHistoryBudget(3 * HISTORY_BUDGET_QUANTUM_TOKENS)).toBe(
      3 * HISTORY_BUDGET_QUANTUM_TOKENS,
    );
    expect(quantizeHistoryBudget(3 * HISTORY_BUDGET_QUANTUM_TOKENS + 1)).toBe(
      3 * HISTORY_BUDGET_QUANTUM_TOKENS,
    );
    expect(quantizeHistoryBudget(4 * HISTORY_BUDGET_QUANTUM_TOKENS - 1)).toBe(
      3 * HISTORY_BUDGET_QUANTUM_TOKENS,
    );
  });

  it("keeps a sub-quantum budget usable instead of flooring it to zero", () => {
    // A small window can leave less than one quantum for history. Flooring that
    // to 0 would drop the entire history prefix on every small-model turn — a
    // regression far worse than the churn this fix targets.
    expect(quantizeHistoryBudget(1)).toBe(1);
    expect(quantizeHistoryBudget(HISTORY_BUDGET_QUANTUM_TOKENS - 1)).toBe(
      HISTORY_BUDGET_QUANTUM_TOKENS - 1,
    );
  });

  it("passes non-positive budgets through untouched", () => {
    // evictHistoryUnderBudget treats <= 0 as "drop everything"; quantization
    // must not turn a 0 into something that keeps history, nor a negative into 0.
    expect(quantizeHistoryBudget(0)).toBe(0);
    expect(quantizeHistoryBudget(-500)).toBe(-500);
  });

  it("is idempotent — re-quantizing a quantized budget changes nothing", () => {
    for (const budget of [83379, 100000, 5]) {
      const once = quantizeHistoryBudget(budget);
      expect(quantizeHistoryBudget(once)).toBe(once);
    }
  });

  it("holds the grid across a growing conversation until a whole cell is consumed", () => {
    // The horizon should advance in rare, large steps rather than every turn.
    // Two budgets inside one cell must agree; a budget a full cell lower must not.
    const high = 90000;
    const sameCell = high - 100;
    const nextCell = high - HISTORY_BUDGET_QUANTUM_TOKENS;
    expect(quantizeHistoryBudget(sameCell)).toBe(quantizeHistoryBudget(high));
    expect(quantizeHistoryBudget(nextCell)).toBeLessThan(quantizeHistoryBudget(high));
  });
});
