// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for executor-session-state module.
 *
 * Covers createBoundedSessionMap: LRU eviction, TTL-based eviction,
 * capacity bounds, and Map-like API compatibility.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SESSION_STATE_MAX,
  SESSION_STATE_TTL_MS,
  createBoundedSessionMap,
} from "./executor-session-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("session state constants", () => {
  it("SESSION_STATE_MAX is 100", () => {
    expect(SESSION_STATE_MAX).toBe(100);
  });

  it("SESSION_STATE_TTL_MS is 3,600,000 (1 hour)", () => {
    expect(SESSION_STATE_TTL_MS).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// createBoundedSessionMap
// ---------------------------------------------------------------------------

describe("createBoundedSessionMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("get/set/has/delete work like a regular Map", () => {
    const map = createBoundedSessionMap<string>();

    map.set("key1", "val1");
    expect(map.has("key1")).toBe(true);
    expect(map.get("key1")).toBe("val1");
    expect(map.size).toBe(1);

    map.delete("key1");
    expect(map.has("key1")).toBe(false);
    expect(map.get("key1")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("does not exceed maxEntries (SESSION_STATE_MAX = 100)", () => {
    const max = 5;  // Use small capacity for test
    const map = createBoundedSessionMap<number>(max);

    for (let i = 0; i < max + 3; i++) {
      map.set(`key${i}`, i);
    }

    expect(map.size).toBeLessThanOrEqual(max);
  });

  it("evicts least-recently-accessed entry when exceeding capacity", () => {
    const map = createBoundedSessionMap<number>(3);

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    // All 3 entries present
    expect(map.size).toBe(3);

    // Adding 4th should evict "a" (oldest)
    map.set("d", 4);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });

  it("accessing an entry updates its last-access time (LRU ordering)", () => {
    const map = createBoundedSessionMap<number>(3);

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    // Access "a" to make it most recently used
    map.get("a");

    // Adding "d" should evict "b" (oldest after "a" was touched)
    map.set("d", 4);
    expect(map.has("a")).toBe(true);  // recently accessed
    expect(map.has("b")).toBe(false); // evicted (was LRU)
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });

  it("entries inactive for >1 hour are evicted on next set", () => {
    const map = createBoundedSessionMap<number>(100, 3_600_000);

    map.set("old-entry", 42);

    // Advance time by 1 hour + 1 ms
    vi.advanceTimersByTime(3_600_001);

    // Trigger eviction via set
    map.set("new-entry", 99);

    expect(map.has("old-entry")).toBe(false);
    expect(map.has("new-entry")).toBe(true);
  });

  it("entries within TTL window are NOT evicted", () => {
    const map = createBoundedSessionMap<number>(100, 3_600_000);

    map.set("alive", 42);

    // Advance time by 30 minutes (within TTL)
    vi.advanceTimersByTime(1_800_000);

    map.set("newer", 99);

    expect(map.has("alive")).toBe(true);
    expect(map.has("newer")).toBe(true);
  });

  it("clear() removes all entries", () => {
    const map = createBoundedSessionMap<string>();

    map.set("a", "1");
    map.set("b", "2");
    expect(map.size).toBe(2);

    map.clear();
    expect(map.size).toBe(0);
    expect(map.has("a")).toBe(false);
  });

  it("get() for non-existent key returns undefined", () => {
    const map = createBoundedSessionMap<string>();

    expect(map.get("nonexistent")).toBeUndefined();
  });

  it("overwriting an existing key updates the value and last-access", () => {
    const map = createBoundedSessionMap<number>(3);

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    // Overwrite "a" -- this should make it most recently accessed
    map.set("a", 100);

    // Adding "d" should evict "b" (oldest after "a" was updated)
    map.set("d", 4);
    expect(map.has("a")).toBe(true);
    expect(map.get("a")).toBe(100);
    expect(map.has("b")).toBe(false);
  });
});
