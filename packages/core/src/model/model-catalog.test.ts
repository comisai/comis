// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  createModelCatalog,
  resolveModelPricing,
  resolvePricingState,
  ZERO_COST,
  type CatalogEntry,
  type ModelCatalog,
} from "./model-catalog.js";

describe("ModelCatalog", () => {
  let catalog: ModelCatalog;

  beforeEach(() => {
    catalog = createModelCatalog();
  });

  describe("loadStatic()", () => {
    it("populates catalog with entries from pi-ai", () => {
      catalog.loadStatic();
      const all = catalog.getAll();
      expect(all.length).toBeGreaterThan(0);
    });

    it("includes a known model like anthropic/claude-sonnet-4-5-20250929", () => {
      catalog.loadStatic();
      const entry = catalog.get("anthropic", "claude-sonnet-4-5-20250929");
      expect(entry).toBeDefined();
      expect(entry!.provider).toBe("anthropic");
      expect(entry!.modelId).toBe("claude-sonnet-4-5-20250929");
      expect(entry!.displayName).toBe("Claude Sonnet 4.5");
      expect(entry!.contextWindow).toBe(200000);
      expect(entry!.input).toContain("text");
      expect(entry!.input).toContain("image");
      expect(entry!.reasoning).toBe(true);
    });

    it("populates cost data from pi-ai", () => {
      catalog.loadStatic();
      const entry = catalog.get("anthropic", "claude-sonnet-4-5-20250929");
      expect(entry).toBeDefined();
      expect(entry!.cost.input).toBeGreaterThan(0);
      expect(entry!.cost.output).toBeGreaterThan(0);
    });

    it("sets validated=false and validatedAt=0 for static entries", () => {
      catalog.loadStatic();
      const entry = catalog.get("anthropic", "claude-sonnet-4-5-20250929");
      expect(entry).toBeDefined();
      expect(entry!.validated).toBe(false);
      expect(entry!.validatedAt).toBe(0);
    });

    it("loads 22+ providers from pi-ai", () => {
      catalog.loadStatic();
      const providers = catalog.getProviders();
      expect(providers.length).toBeGreaterThanOrEqual(22);
    });
  });

  describe("get()", () => {
    it("returns undefined for unknown provider/model", () => {
      catalog.loadStatic();
      expect(catalog.get("nonexistent", "fake-model")).toBeUndefined();
    });

    it("returns undefined for known provider but unknown model", () => {
      catalog.loadStatic();
      expect(catalog.get("anthropic", "nonexistent-model")).toBeUndefined();
    });
  });

  describe("getByProvider()", () => {
    it("returns only models for the specified provider", () => {
      catalog.loadStatic();
      const anthropicModels = catalog.getByProvider("anthropic");
      expect(anthropicModels.length).toBeGreaterThan(0);
      for (const entry of anthropicModels) {
        expect(entry.provider).toBe("anthropic");
      }
    });

    it("returns empty array for unknown provider", () => {
      catalog.loadStatic();
      expect(catalog.getByProvider("nonexistent")).toEqual([]);
    });
  });

  describe("getProviders()", () => {
    it("returns array including anthropic and openai", () => {
      catalog.loadStatic();
      const providers = catalog.getProviders();
      expect(providers).toContain("anthropic");
      expect(providers).toContain("openai");
    });
  });

  describe("mergeScanned()", () => {
    it("sets validated=true on existing entries", () => {
      catalog.loadStatic();
      const now = Date.now();

      catalog.mergeScanned([
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5-20250929",
          displayName: "Claude Sonnet 4.5",
          contextWindow: 200000,
          maxTokens: 64000,
          input: ["text", "image"],
          reasoning: true,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          validated: true,
          validatedAt: now,
        },
      ]);

      const entry = catalog.get("anthropic", "claude-sonnet-4-5-20250929");
      expect(entry).toBeDefined();
      expect(entry!.validated).toBe(true);
      expect(entry!.validatedAt).toBe(now);
    });

    it("adds new entries not in pi-ai", () => {
      catalog.loadStatic();
      const now = Date.now();

      catalog.mergeScanned([
        {
          provider: "custom-provider",
          modelId: "custom-model-v1",
          displayName: "Custom Model v1",
          contextWindow: 8192,
          maxTokens: 4096,
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          validated: true,
          validatedAt: now,
        },
      ]);

      const entry = catalog.get("custom-provider", "custom-model-v1");
      expect(entry).toBeDefined();
      expect(entry!.provider).toBe("custom-provider");
      expect(entry!.modelId).toBe("custom-model-v1");
      expect(entry!.validated).toBe(true);
      expect(entry!.validatedAt).toBe(now);
    });

    it("new provider appears in getProviders()", () => {
      catalog.loadStatic();
      const now = Date.now();

      catalog.mergeScanned([
        {
          provider: "custom-provider",
          modelId: "custom-model-v1",
          displayName: "Custom Model v1",
          contextWindow: 8192,
          maxTokens: 4096,
          input: ["text"],
          reasoning: false,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          validated: true,
          validatedAt: now,
        },
      ]);

      expect(catalog.getProviders()).toContain("custom-provider");
    });
  });

  describe("resolveModelPricing", () => {
    it("returns per-token rates for a known model", () => {
      const rates = resolveModelPricing("anthropic", "claude-sonnet-4-5-20250929");
      // Per-MTok rates divided by 1M => per-token rates, all should be tiny positive numbers
      expect(rates.input).toBeGreaterThan(0);
      expect(rates.input).toBeLessThan(0.001);
      expect(rates.output).toBeGreaterThan(0);
      expect(rates.output).toBeLessThan(0.001);
      expect(rates.cacheRead).toBeGreaterThanOrEqual(0);
      expect(rates.cacheRead).toBeLessThan(0.001);
      expect(rates.cacheWrite).toBeGreaterThanOrEqual(0);
      expect(rates.cacheWrite).toBeLessThan(0.001);
    });

    it("returns ZERO_COST for unknown model", () => {
      const rates = resolveModelPricing("unknown", "nonexistent");
      expect(rates).toEqual(ZERO_COST);
      expect(rates.input).toBe(0);
      expect(rates.output).toBe(0);
      expect(rates.cacheRead).toBe(0);
      expect(rates.cacheWrite).toBe(0);
    });

    it("accepts optional catalog parameter", () => {
      const cat = createModelCatalog();
      cat.loadStatic();
      const rates = resolveModelPricing("anthropic", "claude-sonnet-4-5-20250929", cat);
      expect(rates.input).toBeGreaterThan(0);
    });

    it("lazy singleton returns consistent results across calls", () => {
      const first = resolveModelPricing("anthropic", "claude-sonnet-4-5-20250929");
      const second = resolveModelPricing("anthropic", "claude-sonnet-4-5-20250929");
      expect(first).toEqual(second);
    });

    // 49-01: cacheWrite1h SDK-preference guard
    it("returns cacheWrite1h = 2x input when SDK has no cacheWrite1h field", () => {
      const rates = resolveModelPricing("anthropic", "claude-sonnet-4-5-20250929");
      // cacheWrite1h should be derived as 2x input (per-token rate)
      expect(rates.cacheWrite1h).toBeCloseTo(rates.input * 2, 10);
    });

    it("returns cacheWrite1h field as a number", () => {
      const rates = resolveModelPricing("anthropic", "claude-sonnet-4-5-20250929");
      expect(typeof rates.cacheWrite1h).toBe("number");
      expect(rates.cacheWrite1h).toBeGreaterThan(0);
    });

    it("ZERO_COST includes cacheWrite1h = 0 for unknown models", () => {
      const rates = resolveModelPricing("unknown", "nonexistent");
      expect(rates.cacheWrite1h).toBe(0);
    });
  });

  // PERSIST-03 (observability-excellence E1) — the three-state honest-pricing
  // signal. A NEW function alongside resolveModelPricing (whose 5 production
  // callers + return type must stay untouched — Landmine L3). The discriminator
  // is provider-family membership (model-family.ts NATIVE_PROVIDER_FAMILY), NOT a
  // bare catalog-presence boolean: a native provider with no catalog entry is the
  // dangerous ffe11736 fail-open (returns "unknown", never "free").
  describe("resolvePricingState (PERSIST-03)", () => {
    it("returns 'priced' for a native provider model with a catalog entry", () => {
      // claude-sonnet-4-5 is a known anthropic model with non-zero cost.
      expect(resolvePricingState("anthropic", "claude-sonnet-4-5-20250929")).toBe("priced");
    });

    it("returns 'free' for a gateway/local provider absent from NATIVE_PROVIDER_FAMILY (ollama)", () => {
      // ollama is a local runtime — $0 is correct, never "unknown".
      expect(resolvePricingState("ollama", "qwen3:8b")).toBe("free");
    });

    it("returns 'unknown' for a NATIVE provider with no catalog entry (the ffe11736 chimera case)", () => {
      // anthropic IS in NATIVE_PROVIDER_FAMILY but this model id has no catalog
      // entry → the dangerous silent-$0 fail-open must surface as "unknown".
      expect(resolvePricingState("anthropic", "some-model-not-in-catalog")).toBe("unknown");
    });

    it("returns 'free' for another gateway family (openrouter)", () => {
      expect(resolvePricingState("openrouter", "anything")).toBe("free");
    });

    // LOW-2 (177-obs-loop): the documented-but-untested branch — a catalog entry
    // that IS PRESENT but carries ALL-ZERO rates (e.g. a scanned custom model) is
    // treated as NOT-priced and FALLS THROUGH to the provider-family discriminator
    // (model-catalog.ts:267-278). The result then depends ONLY on whether the
    // provider is native: native → unknown (the ffe11736 silent-$0 danger), gateway
    // → free ($0 is honest for a local runtime). Both directions are now pinned.
    const zeroRateEntry = (provider: string, modelId: string): CatalogEntry => ({
      provider,
      modelId,
      displayName: `${provider}/${modelId}`,
      contextWindow: 8192,
      maxTokens: 4096,
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      validated: true,
      validatedAt: 1,
    });

    it("LOW-2: a PRESENT all-zero-rate catalog entry on a NATIVE provider falls through to 'unknown'", () => {
      const c = createModelCatalog();
      c.mergeScanned([zeroRateEntry("anthropic", "custom-uncosted-model")]);
      // The entry exists, but all rates are 0 → not "priced"; anthropic is native
      // → the silent-$0 fail-open surfaces as "unknown", NOT a phantom "free".
      expect(c.get("anthropic", "custom-uncosted-model")).toBeDefined();
      expect(resolvePricingState("anthropic", "custom-uncosted-model", c)).toBe("unknown");
    });

    it("LOW-2: a PRESENT all-zero-rate catalog entry on a GATEWAY provider falls through to 'free'", () => {
      const c = createModelCatalog();
      c.mergeScanned([zeroRateEntry("ollama", "qwen3:custom")]);
      // The entry exists with all-zero rates; ollama is a local runtime (absent
      // from NATIVE_PROVIDER_FAMILY) → $0 is honest → "free", never "unknown".
      expect(c.get("ollama", "qwen3:custom")).toBeDefined();
      expect(resolvePricingState("ollama", "qwen3:custom", c)).toBe("free");
    });
  });
});
