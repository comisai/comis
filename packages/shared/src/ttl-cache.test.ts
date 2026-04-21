// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createTTLCache } from "./ttl-cache.js";

describe("TTLCache", () => {
  it("get() returns undefined for missing key", () => {
    const cache = createTTLCache<string>({ ttlMs: 1000 });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("set()+get() returns stored value within TTL", () => {
    let now = 1000;
    const cache = createTTLCache<number>({ ttlMs: 5000, nowMs: () => now });
    cache.set("a", 42);
    now = 4999; // still within TTL
    expect(cache.get("a")).toBe(42);
  });

  it("get() returns undefined after TTL expires", () => {
    let now = 1000;
    const cache = createTTLCache<string>({ ttlMs: 5000, nowMs: () => now });
    cache.set("x", "hello");
    now = 6001; // past TTL
    expect(cache.get("x")).toBeUndefined();
  });

  it("has() returns true for live entry, false for expired", () => {
    let now = 0;
    const cache = createTTLCache<string>({ ttlMs: 100, nowMs: () => now });
    cache.set("k", "v");
    expect(cache.has("k")).toBe(true);
    now = 101;
    expect(cache.has("k")).toBe(false);
  });

  it("delete() removes entry and returns true; returns false for missing", () => {
    const cache = createTTLCache<string>({ ttlMs: 1000 });
    cache.set("a", "val");
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.delete("a")).toBe(false);
    expect(cache.delete("never-set")).toBe(false);
  });

  it("clear() empties all entries", () => {
    const cache = createTTLCache<number>({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size()).toBe(3);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts oldest entry when maxEntries reached", () => {
    const cache = createTTLCache<string>({ ttlMs: 10_000, maxEntries: 3 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // At capacity -- inserting "d" should evict "a" (oldest)
    cache.set("d", "4");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
    expect(cache.size()).toBe(3);
  });

  it("entries() iterator skips expired entries and yields only live pairs", () => {
    let now = 0;
    const cache = createTTLCache<string>({ ttlMs: 100, nowMs: () => now });
    cache.set("live1", "a");
    now = 50;
    cache.set("live2", "b");
    // Advance past TTL for "live1" but not "live2"
    now = 110;
    const result = Array.from(cache.entries());
    expect(result).toEqual([["live2", "b"]]);
  });

  it("size() returns count including potentially expired (lazy eviction)", () => {
    let now = 0;
    const cache = createTTLCache<string>({ ttlMs: 100, nowMs: () => now });
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size()).toBe(2);
    now = 200; // Both expired but not yet evicted lazily
    expect(cache.size()).toBe(2);
  });
});
