import { describe, it, expect } from "vitest";
import { getCacheProviderInfo } from "./cache-usage-helpers.js";

describe("getCacheProviderInfo", () => {
  // -------------------------------------------------------------------------
  // Anthropic fast-path
  // -------------------------------------------------------------------------

  it("returns cacheEligible: true for anthropic with 3600s retention regardless of modelId", () => {
    const info = getCacheProviderInfo("anthropic");
    expect(info.cacheEligible).toBe(true);
    expect(info.maxCacheRetentionSec).toBe(3600);
  });

  it("anthropic fast-path ignores modelId", () => {
    const info = getCacheProviderInfo("anthropic", "nonexistent-model");
    expect(info.cacheEligible).toBe(true);
    expect(info.maxCacheRetentionSec).toBe(3600);
  });

  // -------------------------------------------------------------------------
  // Model-specific cache detection
  // -------------------------------------------------------------------------

  it("known cache-capable provider+model returns cacheEligible: true", () => {
    // gpt-4o has cacheRead pricing in the catalog
    const info = getCacheProviderInfo("openai", "gpt-4o");
    expect(info.cacheEligible).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Provider-level fallback (no modelId)
  // -------------------------------------------------------------------------

  it("provider with cache-capable models returns cacheEligible: true without modelId", () => {
    const info = getCacheProviderInfo("openai");
    expect(info.cacheEligible).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unknown provider
  // -------------------------------------------------------------------------

  it("returns cacheEligible: false for unknown provider", () => {
    const info = getCacheProviderInfo("custom-proxy");
    expect(info.cacheEligible).toBe(false);
    expect(info.maxCacheRetentionSec).toBeUndefined();
  });

  it("returns cacheEligible: false for empty string", () => {
    const info = getCacheProviderInfo("");
    expect(info.cacheEligible).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Backward compatibility: previously-whitelisted providers remain eligible
  // -------------------------------------------------------------------------

  describe("backward compatibility with previously-whitelisted providers", () => {
    // Providers whose catalog entries include cacheRead pricing
    const catalogCacheProviders = ["anthropic", "openai", "google", "openrouter"];

    for (const provider of catalogCacheProviders) {
      it(`${provider} remains cache-eligible`, () => {
        const info = getCacheProviderInfo(provider);
        expect(info.cacheEligible).toBe(true);
      });
    }

    // NOTE: vertex and bedrock do not have cacheRead pricing in the pi-ai catalog.
    // The dynamic approach is correct -- these will become cache-eligible automatically
    // when the upstream SDK adds cacheRead pricing entries for their models.
    it("vertex and bedrock not cache-eligible until catalog has pricing entries", () => {
      expect(getCacheProviderInfo("vertex").cacheEligible).toBe(false);
      expect(getCacheProviderInfo("bedrock").cacheEligible).toBe(false);
    });
  });
});
