import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  createTtlGuard,
  recordLastResponseTs,
  clearSessionLastResponseTs,
  getElapsedSinceLastResponse,
  _getSessionLastResponseTsForTest,
} from "./ttl-guard.js";
import type { StreamFn } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockNext(): StreamFn {
  return vi.fn(async function* () {
    yield { type: "text", text: "hello" };
  }) as unknown as StreamFn;
}

function createMockModel(provider: string) {
  return { provider, id: "test-model" } as Parameters<StreamFn>[0];
}

function createMockContext() {
  return { messages: [] } as unknown as Parameters<StreamFn>[1];
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TTL guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Clear all session timestamps between tests
    const map = _getSessionLastResponseTsForTest();
    map.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Wall-clock TTL check
  // -------------------------------------------------------------------------

  describe("wall-clock TTL check", () => {
    it("fires onTtlExpiry when elapsed > 5 minutes for 'short' retention", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-short-expiry";

      // Record a timestamp at t=0 with "short" retention
      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");

      // Advance 5 minutes + 1ms (300001ms > 300000ms)
      vi.setSystemTime(new Date(300_001));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      // Consume the stream to trigger execution
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalled();
    });

    it("fires onTtlExpiry when elapsed > 60 minutes for 'long' retention", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-long-expiry";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "long");

      // Advance 60 minutes + 1ms (3600001ms > 3600000ms)
      vi.setSystemTime(new Date(3_600_001));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "long",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalled();
    });

    it("does NOT fire onTtlExpiry when elapsed < TTL boundary for 'short'", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-short-no-expiry";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");

      // Only 200 seconds (200000ms < 300000ms)
      vi.setSystemTime(new Date(200_000));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("does NOT fire onTtlExpiry when elapsed < TTL boundary for 'long'", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-long-no-expiry";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "long");

      // Only 30 minutes (1800000ms < 3600000ms)
      vi.setSystemTime(new Date(1_800_000));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "long",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("does NOT fire onTtlExpiry when elapsed equals exactly the TTL boundary (strict >)", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-exact-boundary";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");

      // Exactly 5 minutes (300000ms == 300000ms, should NOT fire)
      vi.setSystemTime(new Date(300_000));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Anthropic-only guard
  // -------------------------------------------------------------------------

  describe("Anthropic-only guard", () => {
    it("does NOT call onTtlExpiry for 'google' provider even when elapsed exceeds TTL", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-google";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");
      vi.setSystemTime(new Date(600_000)); // 10 min, well past 5 min

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("google"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("does NOT call onTtlExpiry for 'openai' provider", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-openai";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");
      vi.setSystemTime(new Date(600_000));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("openai"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("does NOT call onTtlExpiry for 'deepseek' provider", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-deepseek";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");
      vi.setSystemTime(new Date(600_000));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("deepseek"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("performs TTL check for 'anthropic' provider", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-anthropic";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");
      vi.setSystemTime(new Date(300_001));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).toHaveBeenCalledOnce();
    });

    it("performs TTL check for 'anthropic-vertex' provider", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-vertex";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");
      vi.setSystemTime(new Date(300_001));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic-vertex"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).toHaveBeenCalledOnce();
    });

    it("performs TTL check for 'amazon-bedrock' provider", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-bedrock";

      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");
      vi.setSystemTime(new Date(300_001));

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("amazon-bedrock"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Cold-start (no prior timestamp)
  // -------------------------------------------------------------------------

  describe("cold-start (no prior timestamp)", () => {
    it("passes through when no entry exists for the session key", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-cold-start";

      // Do NOT record any timestamp

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it("passes through when stored retention has unknown value", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-unknown-retention";

      vi.setSystemTime(new Date(0));
      // Store with "none" retention (no TTL boundary defined for "none")
      recordLastResponseTs(sessionKey, "none");
      vi.setSystemTime(new Date(600_000)); // 10 minutes

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "none",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // recordLastResponseTs
  // -------------------------------------------------------------------------

  describe("recordLastResponseTs", () => {
    it("stores timestamp and retention in Map", () => {
      vi.setSystemTime(new Date(12345));

      recordLastResponseTs("key-a", "short");

      const map = _getSessionLastResponseTsForTest();
      expect(map.get("key-a")).toEqual({ ts: 12345, retention: "short" });
    });

    it("overwrites previous entry for same session key", () => {
      vi.setSystemTime(new Date(100));
      recordLastResponseTs("key-b", "short");

      vi.setSystemTime(new Date(200));
      recordLastResponseTs("key-b", "long");

      const map = _getSessionLastResponseTsForTest();
      expect(map.get("key-b")).toEqual({ ts: 200, retention: "long" });
    });

    it("maintains independent entries for different session keys", () => {
      vi.setSystemTime(new Date(100));
      recordLastResponseTs("key-c", "short");

      vi.setSystemTime(new Date(200));
      recordLastResponseTs("key-d", "long");

      const map = _getSessionLastResponseTsForTest();
      expect(map.get("key-c")).toEqual({ ts: 100, retention: "short" });
      expect(map.get("key-d")).toEqual({ ts: 200, retention: "long" });
    });
  });

  // -------------------------------------------------------------------------
  // getElapsedSinceLastResponse (idle detection)
  // -------------------------------------------------------------------------

  describe("getElapsedSinceLastResponse", () => {
    it("returns undefined when no entry exists for the session key", () => {
      expect(getElapsedSinceLastResponse("nonexistent-key")).toBeUndefined();
    });

    it("returns positive elapsed milliseconds when entry exists", () => {
      vi.setSystemTime(new Date(10_000));
      recordLastResponseTs("idle-test-key", "long");

      vi.setSystemTime(new Date(70_000)); // 60 seconds later
      const elapsed = getElapsedSinceLastResponse("idle-test-key");

      expect(elapsed).toBe(60_000);
    });
  });

  // -------------------------------------------------------------------------
  // clearSessionLastResponseTs
  // -------------------------------------------------------------------------

  describe("clearSessionLastResponseTs", () => {
    it("removes the entry for the given key", () => {
      recordLastResponseTs("key-e", "short");

      clearSessionLastResponseTs("key-e");

      const map = _getSessionLastResponseTsForTest();
      expect(map.has("key-e")).toBe(false);
    });

    it("is a no-op for non-existent key (no throw)", () => {
      expect(() => clearSessionLastResponseTs("non-existent-key")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Integration: stale detection after update
  // -------------------------------------------------------------------------

  describe("integration", () => {
    it("after TTL expiry fires and timestamp updates, next call uses new timestamp", async () => {
      const onTtlExpiry = vi.fn();
      const next = createMockNext();
      const logger = createMockLogger();
      const sessionKey = "session-integration";

      // First: record at t=0, advance past TTL
      vi.setSystemTime(new Date(0));
      recordLastResponseTs(sessionKey, "short");

      vi.setSystemTime(new Date(300_001)); // Past 5 min TTL

      const wrapper = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry,
        logger,
      });

      const stream = wrapper(next);
      for await (const _ of stream(createMockModel("anthropic"), createMockContext())) {
        // consume
      }
      expect(onTtlExpiry).toHaveBeenCalledOnce();

      // Now update the timestamp (simulating post-response recording)
      vi.setSystemTime(new Date(300_001));
      recordLastResponseTs(sessionKey, "short");

      // Advance by only 2 minutes from the new timestamp -- should NOT expire
      vi.setSystemTime(new Date(300_001 + 120_000));

      const onTtlExpiry2 = vi.fn();
      const next2 = createMockNext();
      const wrapper2 = createTtlGuard({
        sessionKey,
        getRetention: () => "short",
        onTtlExpiry: onTtlExpiry2,
        logger,
      });

      const stream2 = wrapper2(next2);
      for await (const _ of stream2(createMockModel("anthropic"), createMockContext())) {
        // consume
      }

      expect(onTtlExpiry2).not.toHaveBeenCalled();
      expect(next2).toHaveBeenCalled();
    });
  });
});
