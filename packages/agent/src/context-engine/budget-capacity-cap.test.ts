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

  // W1 (obs-llm-troubleshooting): cap provenance — the budget must say WHICH knob
  // clamped the window so the exhaustion error / logs / trajectory can name it.
  // Live incident: config declared contextWindow=131072 but the guard aborted at
  // "effective window 32000" with nothing pointing at effectiveContextCapSmall.
  describe("cap provenance (rawContextWindowTokens + windowCapSource)", () => {
    it("small-class capped budget reports the raw declared window and the small-cap knob as source", () => {
      const budget = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1);
      expect(budget.windowTokens).toBe(32_000);
      expect(budget.rawContextWindowTokens).toBe(256_000);
      expect(budget.windowCapSource).toBe("effectiveContextCapSmall");
    });

    it("nano-class capped budget attributes the nano knob as the cap source", () => {
      const nanoProfile: ModelProfile = {
        ...SMALL_256K_PROFILE,
        capabilityClass: "nano",
        maxOutputTokens: 4_096,
      };
      const budget = computeTokenBudgetForProfile(nanoProfile, S, P, -1);
      expect(budget.windowTokens).toBe(16_000);
      expect(budget.rawContextWindowTokens).toBe(256_000);
      expect(budget.windowCapSource).toBe("effectiveContextCapNano");
    });

    it("frontier budget is uncapped: raw equals effective and source is none", () => {
      const budget = computeTokenBudgetForProfile(FRONTIER_PROFILE, S, P, -1);
      expect(budget.rawContextWindowTokens).toBe(256_000);
      expect(budget.windowTokens).toBe(256_000);
      expect(budget.windowCapSource).toBe("none");
    });

    it("explicit effectiveContextCapSmall=0 disables the cap and reports source none", () => {
      const budget = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1, 0);
      expect(budget.windowTokens).toBe(256_000);
      expect(budget.rawContextWindowTokens).toBe(256_000);
      expect(budget.windowCapSource).toBe("none");
    });

    it("small model whose declared window already fits under the cap reports source none (8K-starvation path)", () => {
      const profile: ModelProfile = {
        ...SMALL_256K_PROFILE,
        contextWindow: 8_000,
        maxOutputTokens: 4_096,
      };
      const budget = computeTokenBudgetForProfile(profile, 2_000, 500);
      expect(budget.windowTokens).toBe(8_000);
      expect(budget.rawContextWindowTokens).toBe(8_000);
      expect(budget.windowCapSource).toBe("none");
    });
  });

  // KNOB-02 (Phase 176): served-window provenance. The executor overwrites
  // profile.contextWindow with the RECONCILED (possibly Ollama-served) value
  // before the budget ever sees it (pi-executor.ts resolveModelProfile call),
  // so today a served-bound turn misreports the served value as "the model's
  // declared window" with windowCapSource:"none" — the operator never learns
  // the configured window exists. The optional 7th windowProvenance parameter
  // carries { configuredWindow, served?, reconcileSource } so the budget can
  // report the TRUE configured window and name "served" as the cap source.
  describe("KNOB-02: served-window provenance (windowProvenance 7th param)", () => {
    it("KNOB-02-1: served-bound profile reports the TRUE configured window and windowCapSource 'served'", () => {
      // Executor-overwritten contextWindow = the served 8192; configured = 131072.
      // Pre-patch truth: rawContextWindowTokens === 8192 (the served value
      // misreported as declared) and windowCapSource === "none".
      const budget = computeTokenBudgetForProfile(
        { ...SMALL_256K_PROFILE, contextWindow: 8_192 },
        1_000,
        0,
        -1,
        32_000,
        16_000,
        { configuredWindow: 131_072, served: 8_192, reconcileSource: "served" },
      );
      expect(budget.rawContextWindowTokens).toBe(131_072);
      expect(budget.windowCapSource).toBe("served");
      expect(budget.servedWindowTokens).toBe(8_192);
    });

    it("KNOB-02-2: double-cap — class cap bites tighter than served: the cap keeps the source, served is carried", () => {
      // served 50000 bound first (executor-reconciled contextWindow), but the
      // small class cap 32000 clamps further → source = the cap knob, raw = the
      // TRUE configured window, servedWindowTokens carried for the full chain.
      const budget = computeTokenBudgetForProfile(
        { ...SMALL_256K_PROFILE, contextWindow: 50_000 },
        1_000,
        0,
        -1,
        32_000,
        16_000,
        { configuredWindow: 131_072, served: 50_000, reconcileSource: "served" },
      );
      expect(budget.windowCapSource).toBe("effectiveContextCapSmall");
      expect(budget.rawContextWindowTokens).toBe(131_072);
      expect(budget.servedWindowTokens).toBe(50_000);
    });

    it("KNOB-02-3: capability reconcile upstream — the class knob is named, never a silent 'none' clamp", () => {
      // The executor's capability cap bound the window upstream (contextWindow
      // arrives already at 32000) — the budget's own cap bit never fires, but
      // the clamp must still be named (no silent clamp).
      const budget = computeTokenBudgetForProfile(
        { ...SMALL_256K_PROFILE, contextWindow: 32_000 },
        1_000,
        0,
        -1,
        32_000,
        16_000,
        { configuredWindow: 131_072, reconcileSource: "capability" },
      );
      expect(budget.windowCapSource).toBe("effectiveContextCapSmall");
      expect(budget.rawContextWindowTokens).toBe(131_072);
      expect(budget.servedWindowTokens).toBeUndefined();
    });

    it("KNOB-02-4: I3 pin — without the 7th arg every capability class is byte-identical to pre-provenance output", () => {
      // Inline pre-patch literals (NOT self-comparison of two calls): these are
      // the exact TokenBudget values computeTokenBudgetForProfile produced
      // BEFORE the windowProvenance parameter existed. They must keep passing.
      const frontier = computeTokenBudgetForProfile(FRONTIER_PROFILE, S, P, -1);
      expect(frontier).toEqual({
        windowTokens: 256_000,
        rawContextWindowTokens: 256_000,
        windowCapSource: "none",
        systemTokens: 5_000,
        outputReserveTokens: 8_192,
        safetyMarginTokens: 12_800,
        contextRotBufferTokens: 64_000,
        freshTailPreambleTokens: 1_000,
        availableHistoryTokens: 165_008,
        cacheFenceIndex: -1,
      });

      const midProfile: ModelProfile = { ...FRONTIER_PROFILE, capabilityClass: "mid", contextWindow: 128_000 };
      const mid = computeTokenBudgetForProfile(midProfile, S, P, -1);
      expect(mid).toEqual({
        windowTokens: 128_000,
        rawContextWindowTokens: 128_000,
        windowCapSource: "none",
        systemTokens: 5_000,
        outputReserveTokens: 8_192,
        safetyMarginTokens: 6_400,
        contextRotBufferTokens: 32_000,
        freshTailPreambleTokens: 1_000,
        availableHistoryTokens: 75_408,
        cacheFenceIndex: -1,
      });

      const small = computeTokenBudgetForProfile(SMALL_256K_PROFILE, S, P, -1);
      expect(small).toEqual({
        windowTokens: 32_000,
        rawContextWindowTokens: 256_000,
        windowCapSource: "effectiveContextCapSmall",
        systemTokens: 5_000,
        outputReserveTokens: 8_192,
        safetyMarginTokens: 2_048,
        contextRotBufferTokens: 8_000,
        freshTailPreambleTokens: 1_000,
        availableHistoryTokens: 7_760,
        cacheFenceIndex: -1,
      });

      const nanoProfile: ModelProfile = { ...SMALL_256K_PROFILE, capabilityClass: "nano", maxOutputTokens: 4_096 };
      const nano = computeTokenBudgetForProfile(nanoProfile, S, P, -1);
      expect(nano).toEqual({
        windowTokens: 16_000,
        rawContextWindowTokens: 256_000,
        windowCapSource: "effectiveContextCapNano",
        systemTokens: 5_000,
        outputReserveTokens: 4_096,
        safetyMarginTokens: 2_048,
        contextRotBufferTokens: 4_000,
        freshTailPreambleTokens: 1_000,
        availableHistoryTokens: 4_096,
        cacheFenceIndex: -1,
      });
    });

    it("KNOB-02-5: provenance present but nothing bound (reconcileSource 'configured') is identical to no-provenance output", () => {
      const profile: ModelProfile = { ...FRONTIER_PROFILE, contextWindow: 131_072 };
      const budget = computeTokenBudgetForProfile(profile, S, P, -1, undefined, undefined, {
        configuredWindow: 131_072,
        reconcileSource: "configured",
      });
      expect(budget).toEqual({
        windowTokens: 131_072,
        rawContextWindowTokens: 131_072,
        windowCapSource: "none",
        systemTokens: 5_000,
        outputReserveTokens: 8_192,
        safetyMarginTokens: 6_554,
        contextRotBufferTokens: 32_768,
        freshTailPreambleTokens: 1_000,
        availableHistoryTokens: 77_558,
        cacheFenceIndex: -1,
      });
    });
  });
});
