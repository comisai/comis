// SPDX-License-Identifier: Apache-2.0
/**
 * Generic TTL-based in-memory cache with optional max-entry eviction.
 *
 * Uses lazy expiry on get/has and Map insertion order for oldest-first
 * eviction when maxEntries is exceeded.
 *
 * `nowMs` is REQUIRED — no `Date.now` fallback, so no clock read in this
 * leaf utility ever resolves to the `Date.now` global. Callers thread
 * `nowMs` from their injected `ClockPort` (Pattern A:
 * `nowMs: () => deps.clock.now()`) or from the sanctioned-root
 * `systemNowMs` helper (Pattern B). The callback is a bare structural
 * type to preserve the leaf invariant for `@comis/shared` (no
 * `@comis/core` import).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for creating a TTLCache instance. */
export interface TTLCacheOptions {
  /** Time-to-live in milliseconds for each entry. */
  ttlMs: number;
  /** Maximum number of entries. When exceeded, oldest entry is evicted. */
  maxEntries?: number;
  /** Required clock callback — no Date.now fallback. */
  nowMs: () => number;
}

/** A TTL-based cache with lazy expiry and optional max-entry eviction. */
export interface TTLCache<T> {
  /** Get a value by key. Returns undefined if missing or expired (auto-evicts expired). */
  get(key: string): T | undefined;
  /** Store a value with the default or supplied TTL. Evicts oldest if maxEntries exceeded. */
  set(key: string, value: T, ttlMs?: number): void;
  /** Check if key exists and is not expired (auto-evicts expired). */
  has(key: string): boolean;
  /** Remove a key. Returns true if the key existed. */
  delete(key: string): boolean;
  /** Remove all entries. */
  clear(): void;
  /** Number of entries in the cache (may include expired entries -- lazy eviction). */
  size(): number;
  /** Iterate live (non-expired) entries. Expired entries are evicted during iteration. */
  entries(): IterableIterator<[string, T]>;
}

// ---------------------------------------------------------------------------
// Internal entry
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TTL-based in-memory cache.
 *
 * @param opts - Cache configuration. `nowMs` is REQUIRED — no
 *   `Date.now` fallback. Pass `nowMs: () => deps.clock.now()` (Pattern A)
 *   or `nowMs: systemNowMs` (Pattern B) at the call site.
 * @returns TTLCache instance
 */
export function createTTLCache<T>(opts: TTLCacheOptions): TTLCache<T> {
  const { ttlMs, maxEntries } = opts;
  const getNow = opts.nowMs;

  const store = new Map<string, CacheEntry<T>>();

  function get(key: string): T | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (getNow() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: T, entryTtlMs = ttlMs): void {
    // Evict oldest entry if at capacity and key is new
    if (maxEntries != null && store.size >= maxEntries && !store.has(key)) {
      const oldest = store.keys().next();
      if (!oldest.done) {
        store.delete(oldest.value);
      }
    }
    store.set(key, { value, expiresAt: getNow() + entryTtlMs });
  }

  function has(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    if (getNow() >= entry.expiresAt) {
      store.delete(key);
      return false;
    }
    return true;
  }

  function del(key: string): boolean {
    return store.delete(key);
  }

  function clear(): void {
    store.clear();
  }

  function size(): number {
    return store.size;
  }

  function* entries(): IterableIterator<[string, T]> {
    const now = getNow();
    for (const [key, entry] of store) {
      if (now >= entry.expiresAt) {
        store.delete(key);
        continue;
      }
      yield [key, entry.value];
    }
  }

  return { get, set, has, delete: del, clear, size, entries };
}
