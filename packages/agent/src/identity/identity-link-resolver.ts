// SPDX-License-Identifier: Apache-2.0
/**
 * Identity link resolver with in-memory cache.
 *
 * Sits in front of IdentityLinkStore to avoid a SQLite query on every
 * incoming message. The cache pre-populates on creation and falls
 * through to the store on cache misses.
 *
 * Uses a structural dependency interface (IdentityLinkResolverDeps)
 * to avoid a circular package dependency between agent and memory.
 */

/**
 * Cached identity link resolver for message-time lookups.
 */
export interface IdentityLinkResolver {
  /** Resolve canonical ID for a provider identity. Returns undefined if not linked. */
  resolve(provider: string, providerUserId: string): string | undefined;
  /** Invalidate cache (call after link/unlink operations). */
  invalidateCache(): void;
  /** Refresh cache from store (loads all links into memory). */
  refreshCache(): void;
}

/**
 * Dependencies for the identity link resolver.
 *
 * Uses a structural interface (not importing IdentityLinkStore directly)
 * to avoid a circular package dependency (agent should not import from memory).
 * The channel-manager wiring layer will pass the concrete store.
 */
export interface IdentityLinkResolverDeps {
  /** The underlying store for identity link data. */
  store: {
    resolve(provider: string, providerUserId: string): string | undefined;
    listAll(): Array<{ provider: string; providerUserId: string; canonicalId: string }>;
  };
}

/**
 * Create an IdentityLinkResolver with in-memory caching.
 *
 * Pre-populates the cache on creation by calling store.listAll().
 * Cache misses fall through to store.resolve() and are then cached.
 * Call invalidateCache() after link/unlink operations to force refresh.
 */
export function createIdentityLinkResolver(deps: IdentityLinkResolverDeps): IdentityLinkResolver {
  /** Cache keyed by "provider:providerUserId" -> canonicalId */
  let cache = new Map<string, string>();

  function cacheKey(provider: string, providerUserId: string): string {
    return `${provider}:${providerUserId}`;
  }

  function refreshCache(): void {
    const newCache = new Map<string, string>();
    const allLinks = deps.store.listAll();
    for (const link of allLinks) {
      newCache.set(cacheKey(link.provider, link.providerUserId), link.canonicalId);
    }
    cache = newCache;
  }

  // Pre-populate on creation
  refreshCache();

  return {
    resolve(provider: string, providerUserId: string): string | undefined {
      const key = cacheKey(provider, providerUserId);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      // Cache miss -- fall through to store
      const resolved = deps.store.resolve(provider, providerUserId);
      if (resolved !== undefined) {
        cache.set(key, resolved);
      }
      return resolved;
    },

    invalidateCache(): void {
      cache.clear();
    },

    refreshCache,
  };
}
