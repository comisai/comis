// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createDuplicateDetector } from "./duplicate-detector.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("DuplicateDetector", () => {
  it("isDuplicate returns false for first occurrence", () => {
    const dedup = createDuplicateDetector();
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(false);
  });

  it("isDuplicate returns true for same key+text within TTL", () => {
    let now = 1000;
    const dedup = createDuplicateDetector({ nowMs: () => now });

    dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%");
    now += 1000; // 1 second later -- well within 24h TTL
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(true);
  });

  it("isDuplicate returns false after TTL expires", () => {
    let now = 1000;
    const dedup = createDuplicateDetector({ nowMs: () => now, ttlMs: DAY_MS });

    dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%");
    now += DAY_MS + 1; // just past 24h
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(false);
  });

  it("different keys with same text are not duplicates", () => {
    const dedup = createDuplicateDetector();

    dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%");
    expect(dedup.isDuplicate("agent-b:discord:chat-2", "CPU at 90%")).toBe(false);
  });

  it("same key with different text are not duplicates", () => {
    const dedup = createDuplicateDetector();

    dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%");
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "Memory at 80%")).toBe(false);
  });

  it("clear() removes all entries", () => {
    const dedup = createDuplicateDetector();

    dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%");
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(true);

    dedup.clear();
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(false);
  });

  it("expired entries are auto-evicted on next check", () => {
    let now = 1000;
    const ttlMs = 5000;
    const dedup = createDuplicateDetector({ nowMs: () => now, ttlMs });

    // First occurrence -- recorded
    dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%");

    // Advance past TTL
    now += ttlMs + 1;

    // Should return false (evicted) and NOT be treated as duplicate
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(false);

    // Now it's been re-recorded, so next check within TTL should be duplicate
    now += 100;
    expect(dedup.isDuplicate("agent-a:discord:chat-1", "CPU at 90%")).toBe(true);
  });

  describe("maxEntries eviction", () => {
    it("evicts oldest entry when at maxEntries capacity", () => {
      const dedup = createDuplicateDetector({ maxEntries: 3, ttlMs: 60_000 });

      // Insert 3 entries -- all return false (new)
      expect(dedup.isDuplicate("a", "text-a")).toBe(false);
      expect(dedup.isDuplicate("b", "text-b")).toBe(false);
      expect(dedup.isDuplicate("c", "text-c")).toBe(false);

      // Insert 4th -- evicts "a" (oldest by FIFO), map now: b, c, d
      expect(dedup.isDuplicate("d", "text-d")).toBe(false);

      // "a" was evicted -- treated as new (re-insert evicts "b"), map now: c, d, a
      expect(dedup.isDuplicate("a", "text-a")).toBe(false);

      // "c" still present (within TTL and capacity)
      expect(dedup.isDuplicate("c", "text-c")).toBe(true);

      // "d" still present
      expect(dedup.isDuplicate("d", "text-d")).toBe(true);
    });

    it("isDuplicate returns false for evicted entries that would be within TTL", () => {
      let clock = 0;
      const dedup = createDuplicateDetector({
        maxEntries: 2,
        ttlMs: 60_000,
        nowMs: () => clock,
      });

      // Fill capacity
      expect(dedup.isDuplicate("x", "1")).toBe(false);
      expect(dedup.isDuplicate("y", "2")).toBe(false);

      // Insert 3rd at clock=1000 -- evicts "x"
      clock = 1000;
      expect(dedup.isDuplicate("z", "3")).toBe(false);

      // "x" was evicted despite being within 60s TTL
      clock = 2000;
      expect(dedup.isDuplicate("x", "1")).toBe(false);
    });

    it("default maxEntries is 500", () => {
      const dedup = createDuplicateDetector();

      // Insert 501 unique entries
      for (let i = 0; i < 501; i++) {
        dedup.isDuplicate(`key-${i}`, `text-${i}`);
      }

      // First entry was evicted (isDuplicate returns false)
      expect(dedup.isDuplicate("key-0", "text-0")).toBe(false);

      // Entry 2 is still present (isDuplicate returns true)
      expect(dedup.isDuplicate("key-2", "text-2")).toBe(true);
    });
  });
});
