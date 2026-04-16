/**
 * Model alias resolver: maps friendly short names (e.g., "claude", "gpt4")
 * to full provider + modelId pairs using configurable aliases.
 *
 * Resolution chain:
 * 1. Exact alias match (case-insensitive)
 * 2. Slash-separated "provider/modelId" split
 * 3. Catalog lookup (if provided) with defaultProvider
 * 4. defaultProvider fallback (assume raw model ID)
 * 5. undefined (no match possible)
 *
 * @module
 */

import type { ModelCatalog } from "./model-catalog.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A model alias mapping a friendly name to a provider + model ID pair. */
export interface ModelAlias {
  /** Short alias name (e.g., "claude", "gpt4") */
  alias: string;
  /** Provider identifier (e.g., "anthropic", "openai") */
  provider: string;
  /** Full model identifier at the provider (e.g., "claude-sonnet-4-5-20250929") */
  modelId: string;
}

/** Model alias resolver interface returned by the factory. */
export interface ModelAliasResolver {
  /** Resolve an alias or model string to provider + modelId. Returns undefined if unresolvable. */
  resolve(input: string): { provider: string; modelId: string } | undefined;
  /** Get all registered aliases. */
  getAliases(): ModelAlias[];
}

/** Dependencies for creating a model alias resolver. */
export interface ModelAliasResolverDeps {
  /** Configured alias mappings. */
  aliases: ModelAlias[];
  /** Optional catalog for fallback to direct model ID lookup. */
  catalog?: ModelCatalog;
  /** Default provider to assume when input is a bare model ID. */
  defaultProvider?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a model alias resolver from a set of alias mappings.
 *
 * Usage:
 * ```typescript
 * const resolver = createModelAliasResolver({
 *   aliases: [{ alias: "claude", provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" }],
 *   catalog,
 *   defaultProvider: "anthropic",
 * });
 * const result = resolver.resolve("claude");
 * // { provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" }
 * ```
 */
export function createModelAliasResolver(deps: ModelAliasResolverDeps): ModelAliasResolver {
  const { aliases, catalog, defaultProvider } = deps;

  // Pre-compute lowercase alias lookup map for case-insensitive matching
  const aliasMap = new Map<string, ModelAlias>();
  for (const alias of aliases) {
    aliasMap.set(alias.alias.toLowerCase(), alias);
  }

  return {
    resolve(input: string): { provider: string; modelId: string } | undefined {
      // 1. Check aliases (case-insensitive)
      const aliasMatch = aliasMap.get(input.toLowerCase());
      if (aliasMatch) {
        return { provider: aliasMatch.provider, modelId: aliasMatch.modelId };
      }

      // 2. Slash-separated "provider/modelId"
      const slashIndex = input.indexOf("/");
      if (slashIndex !== -1) {
        return {
          provider: input.slice(0, slashIndex),
          modelId: input.slice(slashIndex + 1),
        };
      }

      // 3. Catalog lookup with defaultProvider
      if (catalog && defaultProvider) {
        const entry = catalog.get(defaultProvider, input);
        if (entry) {
          return { provider: defaultProvider, modelId: input };
        }
      }

      // 4. defaultProvider fallback (assume user knows the model ID)
      if (defaultProvider) {
        return { provider: defaultProvider, modelId: input };
      }

      // 5. Unresolvable
      return undefined;
    },

    getAliases(): ModelAlias[] {
      return [...aliases];
    },
  };
}
