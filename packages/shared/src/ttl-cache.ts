/**
 * Generic TTL-based in-memory cache with optional max-entry eviction.
 *
 * Uses lazy expiry on get/has and Map insertion order for oldest-first
 * eviction when maxEntries is exceeded.
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
  /** Injectable clock for deterministic testing. Defaults to Date.now. */
  nowMs?: () => number;
}

/** A TTL-based cache with lazy expiry and optional max-entry eviction. */
export interface TTLCache<T> {
  /** Get a value by key. Returns undefined if missing or expired (auto-evicts expired). */
  get(key: string): T | undefined;
  /** Store a value with TTL. Evicts oldest if maxEntries exceeded. */
  set(key: string, value: T): void;
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
 * @param opts - Cache configuration
 * @returns TTLCache instance
 */
export function createTTLCache<T>(opts: TTLCacheOptions): TTLCache<T> {
  const { ttlMs, maxEntries } = opts;
  const getNow = opts.nowMs ?? Date.now;

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

  function set(key: string, value: T): void {
    // Evict oldest entry if at capacity and key is new
    if (maxEntries != null && store.size >= maxEntries && !store.has(key)) {
      const oldest = store.keys().next();
      if (!oldest.done) {
        store.delete(oldest.value);
      }
    }
    store.set(key, { value, expiresAt: getNow() + ttlMs });
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
