import { describe, it, expect } from "vitest";
import {
  createHeartbeatResponseCache,
  hashHeartbeatPrompt,
} from "./response-cache.js";

describe("response-cache", () => {
  describe("hashHeartbeatPrompt", () => {
    it("produces a 16-character hex string", () => {
      const hash = hashHeartbeatPrompt("prompt text", "event digest");
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("is deterministic", () => {
      const a = hashHeartbeatPrompt("same prompt", "same digest");
      const b = hashHeartbeatPrompt("same prompt", "same digest");
      expect(a).toBe(b);
    });

    it("produces different hashes for different prompts", () => {
      const a = hashHeartbeatPrompt("prompt A", "digest");
      const b = hashHeartbeatPrompt("prompt B", "digest");
      expect(a).not.toBe(b);
    });

    it("produces different hashes for different digests", () => {
      const a = hashHeartbeatPrompt("prompt", "digest A");
      const b = hashHeartbeatPrompt("prompt", "digest B");
      expect(a).not.toBe(b);
    });
  });

  describe("createHeartbeatResponseCache", () => {
    it("returns undefined on cache miss", () => {
      const cache = createHeartbeatResponseCache();
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("returns cached value on hit", () => {
      const cache = createHeartbeatResponseCache();
      cache.set("key1", "response1");
      expect(cache.get("key1")).toBe("response1");
    });

    it("tracks size correctly", () => {
      const cache = createHeartbeatResponseCache();
      expect(cache.size()).toBe(0);
      cache.set("k1", "v1");
      expect(cache.size()).toBe(1);
      cache.set("k2", "v2");
      expect(cache.size()).toBe(2);
    });

    it("clears all entries", () => {
      const cache = createHeartbeatResponseCache();
      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get("k1")).toBeUndefined();
    });

    it("expires entries after TTL", () => {
      let now = 1000;
      const cache = createHeartbeatResponseCache({
        ttlMs: 5000,
        nowMs: () => now,
      });

      cache.set("key", "value");
      expect(cache.get("key")).toBe("value");

      // Advance past TTL
      now = 6001;
      expect(cache.get("key")).toBeUndefined();
    });

    it("does not expire entries before TTL", () => {
      let now = 1000;
      const cache = createHeartbeatResponseCache({
        ttlMs: 5000,
        nowMs: () => now,
      });

      cache.set("key", "value");
      now = 5999; // Just before expiry
      expect(cache.get("key")).toBe("value");
    });

    it("evicts oldest entry when maxEntries exceeded", () => {
      const cache = createHeartbeatResponseCache({ maxEntries: 2 });

      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.set("k3", "v3"); // Should evict k1

      expect(cache.get("k1")).toBeUndefined();
      expect(cache.get("k2")).toBe("v2");
      expect(cache.get("k3")).toBe("v3");
      expect(cache.size()).toBe(2);
    });

    it("does not evict when updating existing key", () => {
      const cache = createHeartbeatResponseCache({ maxEntries: 2 });

      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.set("k1", "v1-updated"); // Update, not new entry

      expect(cache.get("k1")).toBe("v1-updated");
      expect(cache.get("k2")).toBe("v2");
      expect(cache.size()).toBe(2);
    });

    it("expired entry is cleaned up on get", () => {
      let now = 1000;
      const cache = createHeartbeatResponseCache({
        ttlMs: 100,
        nowMs: () => now,
      });

      cache.set("key", "value");
      expect(cache.size()).toBe(1);

      now = 1200;
      cache.get("key"); // Triggers cleanup
      expect(cache.size()).toBe(0);
    });
  });
});
