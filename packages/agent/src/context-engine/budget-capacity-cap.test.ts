// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { computeTokenBudget } from "./token-budget.js";
import { computeTokenBudgetForProfile } from "./budget-capacity-cap.js";
import type { ModelProfile } from "../executor/model-profile.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";

// Frontier profile: 256K context, large output
const FRONTIER_PROFILE: ModelProfile = {
  contextWindow: 256_000,
  maxOutputTokens: 32_768,
  capabilityClass: "frontier",
  scaffoldLevel: "light",
  securityLevel: "standard",
  supportsVision: true,
  supportsTools: true,
  supportsPromptCache: true,
  supportsServerToolSearch: false,
  supportsStructuredOutput: false,
  reasoningStyle: "none",
};

// Small profile: 256K context window (the overfill case)
const SMALL_256K_PROFILE: ModelProfile = {
  ...FRONTIER_PROFILE,
  capabilityClass: "small",
  scaffoldLevel: "max",
  securityLevel: "locked",
  maxOutputTokens: 8_192,
  supportsPromptCache: false,
};

const S = 5_000; // system tokens estimate
const P = 1_000; // preamble tokens estimate

describe("computeTokenBudgetForProfile — C1", () => {
  describe("frontier: byte-identical to computeTokenBudget", () => {
    it("256K frontier → H identical to current computeTokenBudget", () => {
      const expected = computeTokenBudget(256_000, S, -1, P);
      const actual = computeTokenBudgetForProfile(FRONTIER_PROFILE, S, P, -1);
      expect(actual.availableHistoryTokens).toBe(expected.availableHistoryTokens);
    });

    it("128K frontier → H identical to current computeTokenBudget", () => {
      const profile: ModelProfile = { ...FRONTIER_PROFILE, contextWindow: 128_000 };
      const expected = computeTokenBudget(128_000, S, -1, P);
      const actual = computeTokenBudgetForProfile(profile, S, P, -1);
      expect(actual.availableHistoryTokens).toBe(expected.availableHistoryTokens);
    });
  });

  describe("8K starvation fix (nano/FAIL_CLOSED_PROFILE)", () => {
    it("FAIL_CLOSED_PROFILE (8K window, 4K maxOutputTokens) → H > 0", () => {
      // Without fix: O=8192 > window → H=0. With fix: effectiveO=min(8192,4096)=4096 → H>0
      const budget = computeTokenBudgetForProfile(FAIL_CLOSED_PROFILE, 2_000, 500);
      expect(budget.availableHistoryTokens).toBeGreaterThan(0);
    });
  });

  describe("256K overfill fix (small/nano class)", () => {
    it("small class, 256K window → H < raw-window H (cap applied)", () => {
      const rawBudget = computeTokenBudget(256_000, S, -1, P);
      const cappedBudget = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1);
      // Cap at 32K for small → H << raw H
      expect(cappedBudget.availableHistoryTokens).toBeLessThan(rawBudget.availableHistoryTokens);
    });

    it("small class, 256K window, default cap 32K → effectiveWindow respected", () => {
      const budget = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1);
      // With 32K effective, H can never exceed ~32K - S - O - M - R - P
      expect(budget.availableHistoryTokens).toBeLessThanOrEqual(32_000);
    });

    it("nano class, 256K window → cap at 16K (smaller than small)", () => {
      const nanoProfile: ModelProfile = {
        ...SMALL_256K_PROFILE,
        capabilityClass: "nano",
        maxOutputTokens: 4_096,
      };
      const smallBudget = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1);
      const nanoBudget = computeTokenBudgetForProfile(nanoProfile, S, P, -1);
      expect(nanoBudget.availableHistoryTokens).toBeLessThanOrEqual(smallBudget.availableHistoryTokens);
    });

    it("custom effectiveContextCapSmall param overrides default", () => {
      const budget16K = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1, 16_000);
      const budget8K = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1, 8_000);
      expect(budget8K.availableHistoryTokens).toBeLessThanOrEqual(budget16K.availableHistoryTokens);
    });
  });
});
