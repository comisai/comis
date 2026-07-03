// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the pure spend-ceiling check (terminal-spend-ceiling.ts).
 *
 * Written test-first: `terminal-spend-ceiling.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns
 * them GREEN. (Mirrors terminal-drive-journal.test.ts:1-9 / terminal-dialog-detector.test.ts
 * — the "module does not exist on first commit" banner.)
 *
 * `checkSpendCeiling(costUsd, maxCostUsd)` answers ONE question over the drive
 * journal's accumulated run-total cost: has the drive spent MORE than its operator
 * spend ceiling (`drive.maxCostUsd`)? On a breach it returns the typed discriminant
 * `{ breach: "spend_ceiling" }` so the caller (the wake-turn driver)
 * escalates/stops with the figure — a 40h thrashing-misclassification loop can NEVER
 * burn cost silently unbounded. PREDICATE-ONLY: it reads the journal's
 * honest `costUsd` (hardcoded `0` at the canned-keystroke seam) and adds NO cost
 * producer — it becomes load-bearing the day a real LLM-in-the-loop turn writes a
 * non-zero `costUsd`.
 *
 * It mirrors `checkWallClock` (terminal-caps.ts:144-157): a strict `>` boundary (AT the
 * cap the budget is not yet spent) and the `null = uncapped` member that mirrors
 * `cap === undefined ⇒ undefined`. These tests pin the FULL contract:
 *
 *   - over the cap → `{ breach: "spend_ceiling" }` (escalate/stop, never silent overspend).
 *   - `null` maxCostUsd → undefined (uncapped).
 *   - AT the cap (`costUsd === maxCostUsd`) → undefined (strict `>`: not yet over —
 *     mirrors checkWallClock).
 *   - under the cap → undefined (no breach).
 *   - TOTAL / never throws: a degenerate cost (NaN / negative / Infinity) OR a degenerate
 *     cap → undefined (the SAFE direction — never a spurious breach that kills a healthy
 *     drive).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { checkSpendCeiling, type SpendBreach } from "./terminal-spend-ceiling.js";

describe("checkSpendCeiling — over the cap breaches (escalate/stop, never silent overspend)", () => {
  it("returns the typed breach when costUsd EXCEEDS maxCostUsd", () => {
    expect(checkSpendCeiling(12.5, 10)).toEqual<{ breach: SpendBreach }>({
      breach: "spend_ceiling",
    });
  });

  it("breaches even just past the cap (the overspend is caught, never silent)", () => {
    expect(checkSpendCeiling(10.0001, 10)).toEqual<{ breach: SpendBreach }>({
      breach: "spend_ceiling",
    });
  });
});

describe("checkSpendCeiling — null maxCostUsd is uncapped", () => {
  it("returns undefined for any cost when the cap is null, however large", () => {
    expect(checkSpendCeiling(999, null)).toBeUndefined();
    expect(checkSpendCeiling(0, null)).toBeUndefined();
    expect(checkSpendCeiling(1_000_000, null)).toBeUndefined();
  });
});

describe("checkSpendCeiling — strict > boundary (AT the cap is not yet over)", () => {
  it("returns undefined when costUsd EQUALS maxCostUsd (mirror checkWallClock)", () => {
    // At the exact cap the budget is not yet spent — strict `>`, like the wall-clock cap.
    expect(checkSpendCeiling(10, 10)).toBeUndefined();
    expect(checkSpendCeiling(0, 0)).toBeUndefined();
  });

  it("returns undefined when costUsd is UNDER maxCostUsd", () => {
    expect(checkSpendCeiling(9.99, 10)).toBeUndefined();
    expect(checkSpendCeiling(0, 10)).toBeUndefined();
  });
});

describe("checkSpendCeiling — TOTAL / safe-direction default (degenerate input → no spurious breach)", () => {
  it("a degenerate COST (NaN / negative / Infinity) → undefined, never a spurious breach", () => {
    // A forged/garbage cost must NOT kill a healthy drive — the safe direction is no breach.
    expect(checkSpendCeiling(Number.NaN, 10)).toBeUndefined();
    expect(checkSpendCeiling(-5, 10)).toBeUndefined();
    expect(checkSpendCeiling(Number.POSITIVE_INFINITY, 10)).toBeUndefined();
  });

  it("a degenerate CAP (NaN / negative / Infinity) → undefined (uncapped/safe)", () => {
    expect(checkSpendCeiling(12.5, Number.NaN)).toBeUndefined();
    expect(checkSpendCeiling(12.5, -1)).toBeUndefined();
    expect(checkSpendCeiling(12.5, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("never throws on any combination of degenerate inputs", () => {
    expect(() => checkSpendCeiling(Number.NaN, Number.NaN)).not.toThrow();
    expect(() => checkSpendCeiling(Number.POSITIVE_INFINITY, null)).not.toThrow();
  });
});
