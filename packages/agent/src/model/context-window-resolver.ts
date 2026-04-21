// SPDX-License-Identifier: Apache-2.0
/**
 * Context window resolver: determines the effective context window size
 * for a model using a layered override system.
 *
 * Priority chain (highest to lowest):
 * 1. Per-agent override (runtime, per-agent config)
 * 2. Global override (from models config section)
 * 3. Catalog metadata (from pi-ai static registry or scan results)
 * 4. Fallback default (hardcoded safe value)
 *
 * Zero or negative values in override slots are treated as "not set"
 * and skipped in the priority chain.
 *
 * @module
 */

import type { ModelCatalog } from "./model-catalog.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies for creating a context window resolver. */
export interface ContextWindowResolverDeps {
  /** Model catalog for metadata lookup. */
  catalog: ModelCatalog;
  /** Global config override (e.g., from models config section). */
  globalOverride?: number;
  /** Default context window when no data available (e.g., 128000). */
  fallbackDefault: number;
}

/** Context window resolver interface returned by the factory. */
export interface ContextWindowResolver {
  /**
   * Resolve the context window size for a given model.
   * Priority: perAgentOverride > globalOverride > catalog metadata > fallbackDefault
   */
  resolve(provider: string, modelId: string, perAgentOverride?: number): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a context window resolver with layered override support.
 *
 * Usage:
 * ```typescript
 * const resolver = createContextWindowResolver({
 *   catalog,
 *   globalOverride: 100000,
 *   fallbackDefault: 128000,
 * });
 * const size = resolver.resolve("anthropic", "claude-sonnet-4", 50000);
 * // Returns 50000 (per-agent override wins)
 * ```
 */
export function createContextWindowResolver(deps: ContextWindowResolverDeps): ContextWindowResolver {
  const { catalog, globalOverride, fallbackDefault } = deps;

  return {
    resolve(provider: string, modelId: string, perAgentOverride?: number): number {
      // 1. Per-agent override
      if (perAgentOverride !== undefined && perAgentOverride > 0) {
        return perAgentOverride;
      }

      // 2. Global override
      if (globalOverride !== undefined && globalOverride > 0) {
        return globalOverride;
      }

      // 3. Catalog metadata
      const entry = catalog.get(provider, modelId);
      if (entry && entry.contextWindow > 0) {
        return entry.contextWindow;
      }

      // 4. Fallback default
      return fallbackDefault;
    },
  };
}
