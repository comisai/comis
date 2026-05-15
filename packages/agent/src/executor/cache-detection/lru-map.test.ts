// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for cache-detection/lru-map.ts (Phase 42 split per
 * EXEC-SPLIT-09).
 *
 * Targeted coverage of the LRU-bounded Map: get/set/delete/clear/has/size,
 * insertion-order tracking, MRU-on-get, and capacity-bounded eviction with
 * onEvict callback.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createLruMap } from "./lru-map.js";

describe("createLruMap — get / set / has / delete / clear / size", () => {
  it("set then get returns the stored value", () => {
    const map = createLruMap<string, number>(5);
    map.set("a", 1);
    expect(map.get("a")).toBe(1);
  });

  it("get on missing key returns undefined", () => {
    const map = createLruMap<string, number>(5);
    expect(map.get("missing")).toBeUndefined();
  });

  it("has returns true for present keys, false for missing", () => {
    const map = createLruMap<string, number>(5);
    map.set("a", 1);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
  });

  it("delete removes the key", () => {
    const map = createLruMap<string, number>(5);
    map.set("a", 1);
    map.delete("a");
    expect(map.has("a")).toBe(false);
    expect(map.get("a")).toBeUndefined();
  });

  it("clear removes all entries", () => {
    const map = createLruMap<string, number>(5);
    map.set("a", 1);
    map.set("b", 2);
    map.clear();
    expect(map.size).toBe(0);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(false);
  });

  it("size reflects current entry count", () => {
    const map = createLruMap<string, number>(5);
    expect(map.size).toBe(0);
    map.set("a", 1);
    expect(map.size).toBe(1);
    map.set("b", 2);
    expect(map.size).toBe(2);
    map.delete("a");
    expect(map.size).toBe(1);
  });

  it("set on existing key updates the value (no growth)", () => {
    const map = createLruMap<string, number>(5);
    map.set("a", 1);
    map.set("a", 2);
    expect(map.get("a")).toBe(2);
    expect(map.size).toBe(1);
  });
});

describe("createLruMap — capacity-bounded eviction", () => {
  it("when size exceeds capacity, evicts the least-recently-used entry", () => {
    const map = createLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4); // exceeds capacity — should evict "a"
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
    expect(map.size).toBe(3);
  });

  it("get moves accessed key to most-recently-used position (delete-then-reinsert)", () => {
    const map = createLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // Touch "a" via get — should move it to MRU position.
    map.get("a");
    // Add "d" — LRU should now be "b" (not "a").
    map.set("d", 4);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.has("c")).toBe(true);
    expect(map.has("d")).toBe(true);
  });

  it("set on existing key moves it to most-recently-used", () => {
    const map = createLruMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    // Update "a" — should move it to MRU position.
    map.set("a", 99);
    // Add "d" — LRU should now be "b".
    map.set("d", 4);
    expect(map.has("a")).toBe(true);
    expect(map.get("a")).toBe(99);
    expect(map.has("b")).toBe(false);
  });

  it("onEvict callback fires with the evicted key", () => {
    const onEvict = vi.fn();
    const map = createLruMap<string, number>(2, onEvict);
    map.set("a", 1);
    map.set("b", 2);
    expect(onEvict).not.toHaveBeenCalled();
    map.set("c", 3);
    expect(onEvict).toHaveBeenCalledOnce();
    expect(onEvict).toHaveBeenCalledWith("a");
  });

  it("no eviction when capacity is not exceeded", () => {
    const onEvict = vi.fn();
    const map = createLruMap<string, number>(5, onEvict);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(onEvict).not.toHaveBeenCalled();
    expect(map.size).toBe(3);
  });

  it("eviction continues correctly across multiple adds beyond capacity", () => {
    const evicted: string[] = [];
    const map = createLruMap<string, number>(2, (key) => evicted.push(key));
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3); // evicts "a"
    map.set("d", 4); // evicts "b"
    map.set("e", 5); // evicts "c"
    expect(evicted).toEqual(["a", "b", "c"]);
    expect(map.has("d")).toBe(true);
    expect(map.has("e")).toBe(true);
    expect(map.size).toBe(2);
  });
});
