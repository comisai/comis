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
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
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

  it("returns OpenRouter model IDs for openrouter provider (not Anthropic)", () => {
    const result = resolveOperationDefaults("openrouter");
    const catalogIds = new Set(getModels("openrouter").map((m) => m.id));
    expect(result.fast).toBeDefined();
    expect(result.mid).toBeDefined();
    expect(catalogIds.has(result.fast!)).toBe(true);
    expect(catalogIds.has(result.mid!)).toBe(true);
    // Critically: must NOT be Anthropic IDs (would prove Phase 2's primary bugfix).
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
// OPERATION_TIER_MAP — provider-agnostic semantics, unchanged from Phase 1
// ---------------------------------------------------------------------------

describe("OPERATION_TIER_MAP", () => {
  it("covers all 7 ModelOperationType values", () => {
    const expectedOps = ["interactive", "cron", "heartbeat", "subagent", "compaction", "taskExtraction", "condensation"];
    for (const op of expectedOps) {
      expect(OPERATION_TIER_MAP).toHaveProperty(op);
    }
    expect(Object.keys(OPERATION_TIER_MAP)).toHaveLength(7);
  });

  it("interactive is mapped to primary tier", () => {
    expect(OPERATION_TIER_MAP.interactive).toBe("primary");
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
});

// ---------------------------------------------------------------------------
// OPERATION_TIMEOUT_DEFAULTS — unchanged
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
});

// ---------------------------------------------------------------------------
// OPERATION_CACHE_DEFAULTS — unchanged
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
});
