// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createContextWindowResolver } from "./context-window-resolver.js";
import { createModelCatalog } from "./model-catalog.js";

// ---------------------------------------------------------------------------
// createContextWindowResolver
// ---------------------------------------------------------------------------

describe("createContextWindowResolver", () => {
  function makeCatalogWithEntry(provider: string, modelId: string, contextWindow: number) {
    const catalog = createModelCatalog();
    catalog.mergeScanned([
      {
        provider,
        modelId,
        displayName: `${provider}/${modelId}`,
        contextWindow,
        maxTokens: 4096,
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        validated: true,
        validatedAt: Date.now(),
      },
    ]);
    return catalog;
  }

  // -------------------------------------------------------------------------
  // Priority chain
  // -------------------------------------------------------------------------

  describe("priority chain", () => {
    it("per-agent override takes precedence over everything", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        globalOverride: 100000,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4", 50000);

      expect(result).toBe(50000);
    });

    it("global override takes precedence over catalog and fallback", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        globalOverride: 100000,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4");

      expect(result).toBe(100000);
    });

    it("catalog metadata used when no overrides provided", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4");

      expect(result).toBe(200000);
    });

    it("fallback default used when model not in catalog and no overrides", () => {
      const catalog = createModelCatalog(); // empty catalog
      const resolver = createContextWindowResolver({
        catalog,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("unknown", "unknown-model");

      expect(result).toBe(128000);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: zero/negative override values
  // -------------------------------------------------------------------------

  describe("zero and negative values treated as not set", () => {
    it("zero per-agent override is skipped", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4", 0);

      expect(result).toBe(200000);
    });

    it("negative per-agent override is skipped", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4", -1);

      expect(result).toBe(200000);
    });

    it("zero global override is skipped", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        globalOverride: 0,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4");

      expect(result).toBe(200000);
    });

    it("negative global override is skipped", () => {
      const catalog = makeCatalogWithEntry("anthropic", "claude-sonnet-4", 200000);
      const resolver = createContextWindowResolver({
        catalog,
        globalOverride: -10,
        fallbackDefault: 128000,
      });

      const result = resolver.resolve("anthropic", "claude-sonnet-4");

      expect(result).toBe(200000);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown model
  // -------------------------------------------------------------------------

  describe("unknown model", () => {
    it("returns fallback default when model not in catalog and no overrides", () => {
      const catalog = createModelCatalog();
      const resolver = createContextWindowResolver({
        catalog,
        fallbackDefault: 32000,
      });

      expect(resolver.resolve("mystery-provider", "mystery-model")).toBe(32000);
    });
  });
});
