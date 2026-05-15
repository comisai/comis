// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-break detection — LRU-bounded Map (Phase 42 split per
 * EXEC-SPLIT-09).
 *
 * Simple LRU-bounded Map using JS Map's insertion-order guarantee.
 * Used by cache-state.ts to bound per-session detector state.
 *
 * Split out from cache-state.ts to satisfy the EXEC-SPLIT-10 ≤350L cap.
 *
 * @module
 */

/**
 * Simple LRU-bounded Map using JS Map's insertion-order guarantee.
 * On get()/set(), delete-then-reinsert moves the key to most-recently-used.
 * On set(), if size exceeds capacity, the first key (LRU) is evicted.
 */
export interface LruMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  clear(): void;
  has(key: K): boolean;
  readonly size: number;
}

export function createLruMap<K, V>(capacity: number, onEvict?: (key: K) => void): LruMap<K, V> {
  const map = new Map<K, V>();
  return {
    get(key: K): V | undefined {
      const value = map.get(key);
      if (value !== undefined) {
        // Move to most-recently-used: delete then re-insert at end
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: K, value: V): void {
      // If key exists, delete first to update insertion order
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, value);
      // Evict LRU (first key) if over capacity
      if (map.size > capacity) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) {
          onEvict?.(firstKey);
          map.delete(firstKey);
        }
      }
    },
    delete(key: K): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    has(key: K): boolean {
      return map.has(key);
    },
    get size(): number {
      return map.size;
    },
  };
}
