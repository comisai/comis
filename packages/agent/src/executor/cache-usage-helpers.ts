// SPDX-License-Identifier: Apache-2.0
/**
 * Cache eligibility helpers for provider-level cache support detection.
 *
 * Uses the model pricing catalog to dynamically determine cache eligibility
 * instead of a hardcoded provider map. A provider/model is cache-eligible
 * if its catalog entry has cacheRead pricing > 0.
 *
 * @module
 */

import { resolveModelPricing } from "../model/model-catalog.js";
import { createModelCatalog } from "../model/model-catalog.js";
import type { ModelCatalog } from "../model/model-catalog.js";

/** Cache support info for a provider. */
export interface CacheProviderInfo {
  cacheEligible: boolean;
  /** Maximum cache TTL in seconds. Actual TTL depends on per-request cacheRetention setting: "short" = 300s, "long" = 3600s. */
  maxCacheRetentionSec?: number;
}

// Lazy singleton for provider-level fallback catalog lookups
let _catalogSingleton: ModelCatalog | undefined;
function getCatalog(): ModelCatalog {
  if (!_catalogSingleton) {
    _catalogSingleton = createModelCatalog();
    _catalogSingleton.loadStatic();
  }
  return _catalogSingleton;
}

/**
 * Get cache support info for a provider, optionally refined by model.
 *
 * Resolution order:
 * 1. Anthropic fast-path: always cache-eligible with 3600s retention
 * 2. Model-specific: check if the given model has cacheRead pricing > 0
 * 3. Provider-level fallback: check if ANY model from this provider has cache pricing
 *
 * Returns `{ cacheEligible: false }` for unknown providers with no catalog entries.
 */
export function getCacheProviderInfo(provider: string, modelId?: string): CacheProviderInfo {
  // Fast-path: Anthropic always has 1-hour retention
  if (provider === "anthropic") {
    return { cacheEligible: true, maxCacheRetentionSec: 3600 };
  }

  // Model-specific check: if this model has cacheRead pricing, it supports caching
  if (modelId) {
    const pricing = resolveModelPricing(provider, modelId);
    if (pricing.cacheRead > 0) {
      return { cacheEligible: true };
    }
  }

  // Provider-level fallback: check if ANY model from this provider has cache pricing
  const providerModels = getCatalog().getByProvider(provider);
  const hasAnyCacheModel = providerModels.some(m => m.cost.cacheRead > 0);
  return { cacheEligible: hasAnyCacheModel };
}
