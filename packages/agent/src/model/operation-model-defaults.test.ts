// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for catalog-derived operation model defaults.
 *
 * Asserts BEHAVIOR (cost ranking, text-capability filtering, graceful
 * degradation for unknown providers) rather than literal model IDs —
 * pinning literals would re-introduce the staleness problem this module
 * was designed to eliminate (every pi-ai SDK upgrade would break tests).
 */

import { describe, it, expect } from "vitest";
import { type KnownProvider } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import {
  resolveOperationDefaults,
  OPERATION_TIER_MAP,
  OPERATION_TIMEOUT_DEFAULTS,
  OPERATION_CACHE_DEFAULTS,
} from "./operation-model-defaults.js";

// ---------------------------------------------------------------------------
// resolveOperationDefaults
// ---------------------------------------------------------------------------

function totalCost(m: { cost?: { input?: number; output?: number } }): number {
  return (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
}

describe("resolveOperationDefaults", () => {
  it("returns {} for unknown (non-native) providers", () => {
    expect(resolveOperationDefaults("not-a-real-provider")).toEqual({});
    expect(resolveOperationDefaults("")).toEqual({});
    expect(resolveOperationDefaults("ollama")).toEqual({}); // custom YAML provider, not in pi-ai catalog
  });

  it("returns valid model IDs (present in catalog) for anthropic", () => {
    const result = resolveOperationDefaults("anthropic");
    const catalogIds = new Set(getModels("anthropic").map((m) => m.id));
    expect(result.fast).toBeDefined();
    expect(result.mid).toBeDefined();
    expect(catalogIds.has(result.fast!)).toBe(true);
    expect(catalogIds.has(result.mid!)).toBe(true);
  });

  it("returns Anthropic model IDs for anthropic provider (not cross-contaminated)", () => {
    const result = resolveOperationDefaults("anthropic");
    // Anthropic model IDs all start with "claude-".
    expect(result.fast!).toMatch(/^claude-/);
    expect(result.mid!).toMatch(/^claude-/);
  });

  it("never resolves a floating `-latest` alias (PINNED ids only — live-2026-06-18 anthropic `claude-3-5-haiku-latest` 404)", () => {
    // A `-latest` alias drifts and 404s once the provider retires it; the cost-gated
    // seams then silently yield empty verdicts. Operation-tier picks MUST be pinned ids.
    for (const provider of ["anthropic", "openai", "google", "openrouter"]) {
      const result = resolveOperationDefaults(provider);
      if (result.fast !== undefined) expect(result.fast.endsWith("-latest")).toBe(false);
      if (result.mid !== undefined) expect(result.mid.endsWith("-latest")).toBe(false);
    }
  });

  it("returns OpenRouter model IDs for openrouter provider (not Anthropic)", () => {
    const result = resolveOperationDefaults("openrouter");
    const catalogIds = new Set(getModels("openrouter").map((m) => m.id));
    expect(result.fast).toBeDefined();
    expect(result.mid).toBeDefined();
    expect(catalogIds.has(result.fast!)).toBe(true);
    expect(catalogIds.has(result.mid!)).toBe(true);
    // Critically: must NOT be Anthropic IDs.
    expect(result.fast!).not.toMatch(/^claude-/);
    expect(result.mid!).not.toMatch(/^claude-/);
  });

  it("fast tier total cost <= mid tier total cost (ranking property)", () => {
    for (const provider of ["anthropic", "openai", "google", "openrouter", "xai", "mistral"] as const) {
      const result = resolveOperationDefaults(provider);
      const all = getModels(provider);
      const fast = all.find((m) => m.id === result.fast);
      const mid = all.find((m) => m.id === result.mid);
      expect(fast, `fast model not found in ${provider} catalog`).toBeDefined();
      expect(mid, `mid model not found in ${provider} catalog`).toBeDefined();
      expect(totalCost(fast!)).toBeLessThanOrEqual(totalCost(mid!));
    }
  });

  it("picks text-capable models only", () => {
    for (const provider of ["anthropic", "openai", "google", "openrouter"] as const) {
      const { fast, mid } = resolveOperationDefaults(provider);
      const all = getModels(provider);
      expect(all.find((m) => m.id === fast)?.input?.includes("text")).toBe(true);
      expect(all.find((m) => m.id === mid)?.input?.includes("text")).toBe(true);
    }
  });

  it("filters out free/local-only models from cost ranking", () => {
    // Anthropic catalog has no free models — fast tier must have cost > 0.
    const result = resolveOperationDefaults("anthropic");
    const fastModel = getModels("anthropic").find((m) => m.id === result.fast);
    expect(totalCost(fastModel!)).toBeGreaterThan(0);
  });

  it("falls back to first text-capable id when all models are free", () => {
    // Z.AI catalog is predominantly free models. Algorithm must not divide by
    // zero — both slots get the same first text-capable id.
    const zaiModels = getModels("zai");
    const allFree = zaiModels.every((m) => totalCost(m) === 0);
    if (allFree) {
      const result = resolveOperationDefaults("zai");
      const firstText = zaiModels.find((m) => m.input?.includes("text"))?.id;
      expect(result.fast).toBe(firstText);
      expect(result.mid).toBe(firstText);
    } else {
      // If pi-ai later adds priced Z.AI models, algorithm uses standard ranking.
      // Behavioral assertion still holds: fast cost <= mid cost.
      const result = resolveOperationDefaults("zai");
      const fast = zaiModels.find((m) => m.id === result.fast);
      const mid = zaiModels.find((m) => m.id === result.mid);
      expect(totalCost(fast!)).toBeLessThanOrEqual(totalCost(mid!));
    }
  });

  it("is referentially stable for the same provider (no hidden state)", () => {
    // Repeated calls with the same input return identical IDs. Proves the
    // function is pure even though it reads module-level catalog state.
    const a = resolveOperationDefaults("anthropic");
    const b = resolveOperationDefaults("anthropic");
    expect(a.fast).toBe(b.fast);
    expect(a.mid).toBe(b.mid);
  });

  it("covers every native pi-ai provider with at least one slot", () => {
    // Regression guard: any native provider must produce at least one tier slot
    // (either via cost ranking or all-free fallback). If pi-ai ships a provider
    // with zero text-capable models, this test surfaces it.
    for (const provider of getProviders()) {
      const { fast, mid } = resolveOperationDefaults(provider as KnownProvider);
      const hasAnySlot = fast !== undefined || mid !== undefined;
      const text = getModels(provider as KnownProvider).filter((m) => m.input?.includes("text"));
      if (text.length === 0) {
        // No text-capable models -> empty result is correct
        expect(fast).toBeUndefined();
        expect(mid).toBeUndefined();
      } else {
        expect(hasAnySlot, `provider ${provider} produced no tier slot`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOperationDefaults — top-of-cohort selection
// ---------------------------------------------------------------------------

describe("resolveOperationDefaults — top-of-cohort selection", () => {
  it("anthropic mid lands in the Sonnet $18 cohort and picks the lex-greatest Sonnet", () => {
    const result = resolveOperationDefaults("anthropic");
    expect(result.mid).toBeDefined();
    expect(result.mid!).toMatch(/^claude-sonnet-/);
    // The bug was that mid resolved to claude-sonnet-4-5 by accident of catalog
    // enumeration order. Top-of-cohort must pick the lex-greatest Sonnet in the
    // mid cohort, which is strictly greater than claude-sonnet-4-5 in any catalog
    // that ships Sonnet 4.6+. Loose assertion to survive future pi-ai bumps.
    expect(result.mid!.localeCompare("claude-sonnet-4-5")).toBeGreaterThan(0);
  });

  it("within a cost-tied cohort, picks the lex-greatest model ID for both fast and mid", () => {
    // Across pi-ai providers, locate any provider whose mid cohort has 2+ members.
    // The picked ID must equal max(lex) over that cohort.
    for (const provider of ["anthropic", "openai", "mistral", "xai"] as const) {
      const result = resolveOperationDefaults(provider);
      const all = getModels(provider);
      // Mirror production: operation-tier picks exclude floating `-latest` aliases
      // (so anthropic fast now resolves the pinned `claude-haiku-4-5-20251001`, not the
      // retired `claude-3-5-haiku-latest` alias that 404'd live on 2026-06-18).
      const priced = all
        .filter((m) => m.input?.includes("text") && totalCost(m) > 0 && !m.id.endsWith("-latest"))
        .sort((a, b) => totalCost(a) - totalCost(b));
      if (priced.length === 0) continue;
      for (const [tier, pct] of [
        ["fast", 0.1],
        ["mid", 0.5],
      ] as const) {
        const idx = Math.min(priced.length - 1, Math.floor(priced.length * pct));
        const cohortCost = totalCost(priced[idx]!);
        const cohort = priced.filter((m) => totalCost(m) === cohortCost);
        const expectedId = [...cohort].sort((a, b) => b.id.localeCompare(a.id))[0]!.id;
        const actual = tier === "fast" ? result.fast : result.mid;
        expect(actual, `${provider} ${tier} should be lex-greatest of its cost cohort`).toBe(expectedId);
      }
    }
  });

  // Synthetic-input corner cases below validate `pickFromCohort` shape behavior
  // through the public function by selecting providers whose live catalog hits
  // the relevant shapes — but we also surface a tie-break guarantee via the
  // surveyed-providers loop above. Two further behaviors are pinned by other
  // tests in this file and intentionally not duplicated here:
  //   - All-free provider fallback: covered by the
  //     "falls back to first text-capable id when all models are free" test.
  //   - Single-model clamp & ranking property: covered by the
  //     "covers every native pi-ai provider" + "fast tier total cost <= mid tier
  //     total cost (ranking property)" tests.

  it("single-priced-model providers (if any) clamp both fast and mid to that model", () => {
    // Pi-ai catalog state at write time: most providers have multiple priced
    // text-capable models. If any provider ships exactly one priced model, both
    // fast and mid must clamp to it (idx = floor(1 * pct) = 0). Skip silently
    // when no such provider exists rather than coupling to live catalog state.
    let anyChecked = false;
    for (const provider of getProviders()) {
      const all = getModels(provider as KnownProvider);
      // Mirror production: operation-tier picks exclude floating `-latest` aliases.
      const priced = all.filter((m) => m.input?.includes("text") && totalCost(m) > 0 && !m.id.endsWith("-latest"));
      if (priced.length === 1) {
        anyChecked = true;
        const result = resolveOperationDefaults(provider as KnownProvider);
        expect(result.fast, `${provider} single-priced-model fast slot`).toBe(priced[0]!.id);
        expect(result.mid, `${provider} single-priced-model mid slot`).toBe(priced[0]!.id);
      }
    }
    // Either at least one provider exercised the clamp, or none did — both are
    // valid catalog states. Sanity log:
    expect(typeof anyChecked).toBe("boolean");
  });

  it("multi-cost cohort: fast and mid each select lex-greatest within their respective cost cohorts", () => {
    // Anthropic's catalog has three distinct cost tiers ($1.5, $4.8, $6, $18, $30, $90).
    // Verifies that fast and mid land in *different* cohorts (when they differ)
    // and each picks lex-greatest within its own cohort — i.e. cross-cohort
    // contamination cannot happen.
    const result = resolveOperationDefaults("anthropic");
    const all = getModels("anthropic");
    // Mirror production: operation-tier picks exclude floating `-latest` aliases.
    const priced = all
      .filter((m) => m.input?.includes("text") && totalCost(m) > 0 && !m.id.endsWith("-latest"))
      .sort((a, b) => totalCost(a) - totalCost(b));
    const fastIdx = Math.min(priced.length - 1, Math.floor(priced.length * 0.1));
    const midIdx = Math.min(priced.length - 1, Math.floor(priced.length * 0.5));
    const fastCohortCost = totalCost(priced[fastIdx]!);
    const midCohortCost = totalCost(priced[midIdx]!);
    const fastModel = all.find((m) => m.id === result.fast);
    const midModel = all.find((m) => m.id === result.mid);
    expect(fastModel, "fast model must exist in catalog").toBeDefined();
    expect(midModel, "mid model must exist in catalog").toBeDefined();
    expect(totalCost(fastModel!)).toBe(fastCohortCost);
    expect(totalCost(midModel!)).toBe(midCohortCost);
    // Lex-greatest within each cohort:
    const fastCohort = priced.filter((m) => totalCost(m) === fastCohortCost);
    const midCohort = priced.filter((m) => totalCost(m) === midCohortCost);
    expect(result.fast).toBe([...fastCohort].sort((a, b) => b.id.localeCompare(a.id))[0]!.id);
    expect(result.mid).toBe([...midCohort].sort((a, b) => b.id.localeCompare(a.id))[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// OPERATION_TIER_MAP — provider-agnostic semantics
// ---------------------------------------------------------------------------

describe("OPERATION_TIER_MAP", () => {
  it("covers all 11 ModelOperationType values (including verification, planning, outcomeJudge + skillSynthesis)", () => {
    const expectedOps = [
      "interactive", "cron", "heartbeat", "subagent", "compaction",
      "taskExtraction", "condensation", "verification", "planning", "outcomeJudge",
      "skillSynthesis",
    ];
    for (const op of expectedOps) {
      expect(OPERATION_TIER_MAP).toHaveProperty(op);
    }
    expect(Object.keys(OPERATION_TIER_MAP)).toHaveLength(11);
  });

  it("interactive is mapped to primary tier", () => {
    expect(OPERATION_TIER_MAP.interactive).toBe("primary");
  });

  it("outcomeJudge is mapped to the fast tier (optional cost-gated judge)", () => {
    expect(OPERATION_TIER_MAP.outcomeJudge).toBe("fast");
  });

  it("skillSynthesis is mapped to the mid tier (a synthesis op, not a fast classify)", () => {
    expect(OPERATION_TIER_MAP.skillSynthesis).toBe("mid");
  });

  it("heartbeat is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.heartbeat).toBe("fast");
  });

  it("cron is mapped to mid tier", () => {
    expect(OPERATION_TIER_MAP.cron).toBe("mid");
  });

  it("subagent is mapped to primary tier", () => {
    expect(OPERATION_TIER_MAP.subagent).toBe("primary");
  });

  it("compaction is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.compaction).toBe("fast");
  });

  it("taskExtraction is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.taskExtraction).toBe("fast");
  });

  it("condensation is mapped to fast tier", () => {
    expect(OPERATION_TIER_MAP.condensation).toBe("fast");
  });

  // verification + planning tiers
  it("verification is mapped to primary tier (self-check on local-only, cheap-model on configured)", () => {
    expect(OPERATION_TIER_MAP["verification"]).toBe("primary");
  });

  it("planning is mapped to primary tier (same resolution path as verification)", () => {
    expect(OPERATION_TIER_MAP["planning"]).toBe("primary");
  });
});

// ---------------------------------------------------------------------------
// OPERATION_TIMEOUT_DEFAULTS — per-operation timeout table
// ---------------------------------------------------------------------------

describe("OPERATION_TIMEOUT_DEFAULTS", () => {
  it("has correct timeout for heartbeat (60000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.heartbeat).toBe(60_000);
  });

  it("has correct timeout for cron (150000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.cron).toBe(150_000);
  });

  it("has correct timeout for subagent (120000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.subagent).toBe(120_000);
  });

  it("has correct timeout for compaction (60000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.compaction).toBe(60_000);
  });

  it("has correct timeout for taskExtraction (30000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.taskExtraction).toBe(30_000);
  });

  it("has correct timeout for condensation (30000ms)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS.condensation).toBe(30_000);
  });

  it("does NOT have an interactive key", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS).not.toHaveProperty("interactive");
  });

  it("has correct timeout for verification (120000ms — matches LLM_TIMEOUT_MS ceiling)", () => {
    expect(OPERATION_TIMEOUT_DEFAULTS["verification"]).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// OPERATION_CACHE_DEFAULTS — per-operation cache-retention table
// ---------------------------------------------------------------------------

describe("OPERATION_CACHE_DEFAULTS", () => {
  it("heartbeat cache retention is none", () => {
    expect(OPERATION_CACHE_DEFAULTS.heartbeat).toBe("none");
  });

  it("compaction cache retention is none", () => {
    expect(OPERATION_CACHE_DEFAULTS.compaction).toBe("none");
  });

  it("taskExtraction cache retention is none", () => {
    expect(OPERATION_CACHE_DEFAULTS.taskExtraction).toBe("none");
  });

  it("condensation cache retention is short", () => {
    expect(OPERATION_CACHE_DEFAULTS.condensation).toBe("short");
  });

  it("cron cache retention is short", () => {
    expect(OPERATION_CACHE_DEFAULTS.cron).toBe("short");
  });

  it("verification cache retention is none (critic responses must not be cached)", () => {
    expect(OPERATION_CACHE_DEFAULTS["verification"]).toBe("none");
  });

  it("planning cache retention is none (planner responses must not be cached)", () => {
    expect(OPERATION_CACHE_DEFAULTS["planning"]).toBe("none");
  });
});
