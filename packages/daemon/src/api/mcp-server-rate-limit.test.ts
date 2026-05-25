// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 69 Plan 04 -- Per-MCP-client per-tool minute-bucket rate-limit unit tests.
 *
 * Pins the bucket-rollover, ceiling rejection, per-key isolation, and prune
 * semantics of the rate-limit module that the live tools/call dispatcher
 * consults. The module is a stateful Map<key, {minuteBucket, count}>; tests
 * use a fake clock to drive bucket boundaries deterministically.
 *
 * SERVE-07. Bucket boundary: floor(now / 60_000) -- bucket flips each UTC
 * minute (NOT a sliding window; that's the ws-handler precedent at
 * ws-handler.ts:299-316). Per CONTEXT.md §1.7 "bucket reset on the minute
 * boundary".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkAndIncrement,
  createRateLimitState,
  nextResetAt,
  pruneOldBuckets,
} from "./mcp-server-rate-limit.js";

// ---------------------------------------------------------------------------
// Fake-clock plumbing -- vi.setSystemTime drives systemNowMs (which delegates
// to Date.now per packages/core/src/runtime/system-time.ts:17-19).
// ---------------------------------------------------------------------------

const BASE_EPOCH_MS = 1_715_000_000_000; // Some fixed epoch on a minute boundary.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_EPOCH_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("mcp-server-rate-limit -- Phase 69 Plan 04 minute-bucket semantics", () => {
  it("checkAndIncrement allows up to ceiling calls within the same minute bucket", () => {
    const state = createRateLimitState();
    const key = "client-a:memory_search";
    const ceiling = 5;

    for (let i = 0; i < ceiling; i++) {
      expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    }
  });

  it("checkAndIncrement rejects calls after ceiling is reached within the same minute", () => {
    const state = createRateLimitState();
    const key = "client-a:memory_search";
    const ceiling = 3;

    // 3 allowed
    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    // 4th rejected
    expect(checkAndIncrement(state, key, ceiling)).toBe(false);
    // 5th and 6th also rejected (saturated)
    expect(checkAndIncrement(state, key, ceiling)).toBe(false);
    expect(checkAndIncrement(state, key, ceiling)).toBe(false);
  });

  it("checkAndIncrement resets count when the minute bucket rolls over", () => {
    const state = createRateLimitState();
    const key = "client-a:memory_search";
    const ceiling = 2;

    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    expect(checkAndIncrement(state, key, ceiling)).toBe(false); // saturated

    // Advance past the minute boundary -- previously-blocked key is now accepted.
    vi.setSystemTime(BASE_EPOCH_MS + 60_001);

    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    expect(checkAndIncrement(state, key, ceiling)).toBe(true);
    expect(checkAndIncrement(state, key, ceiling)).toBe(false); // saturated again in new bucket
  });

  it("checkAndIncrement isolates buckets per key -- saturating one key does not affect another", () => {
    const state = createRateLimitState();
    const ceiling = 2;
    const keyA = "client-a:memory_search";
    const keyB = "client-a:web_search";
    const keyC = "client-b:memory_search"; // different client, same tool

    // Saturate keyA
    expect(checkAndIncrement(state, keyA, ceiling)).toBe(true);
    expect(checkAndIncrement(state, keyA, ceiling)).toBe(true);
    expect(checkAndIncrement(state, keyA, ceiling)).toBe(false);

    // keyB and keyC remain unaffected
    expect(checkAndIncrement(state, keyB, ceiling)).toBe(true);
    expect(checkAndIncrement(state, keyB, ceiling)).toBe(true);
    expect(checkAndIncrement(state, keyC, ceiling)).toBe(true);
    expect(checkAndIncrement(state, keyC, ceiling)).toBe(true);

    // Now saturate keyB / keyC independently; keyA still saturated.
    expect(checkAndIncrement(state, keyB, ceiling)).toBe(false);
    expect(checkAndIncrement(state, keyC, ceiling)).toBe(false);
    expect(checkAndIncrement(state, keyA, ceiling)).toBe(false);
  });

  it("nextResetAt returns the next-minute boundary as epoch ms", () => {
    // BASE_EPOCH_MS = 1_715_000_000_000 -- check it is on (or compute the offset).
    // floor(BASE/60000) = N; nextResetAt = (N+1)*60000.
    const expected =
      (Math.floor(BASE_EPOCH_MS / 60_000) + 1) * 60_000;
    expect(nextResetAt()).toBe(expected);

    // Advance into the same minute -- result unchanged.
    vi.setSystemTime(BASE_EPOCH_MS + 30_000);
    expect(nextResetAt()).toBe(expected);

    // Advance past the boundary -- next boundary moves forward by 60_000.
    vi.setSystemTime(BASE_EPOCH_MS + 60_001);
    expect(nextResetAt()).toBe(expected + 60_000);
  });

  it("pruneOldBuckets removes entries whose minuteBucket is more than N minutes old", () => {
    const state = createRateLimitState();

    // Seed bucket at base epoch.
    checkAndIncrement(state, "client-old:memory_search", 5);
    expect(state.buckets.size).toBe(1);

    // Advance 11 minutes (>10) and seed a new key.
    vi.setSystemTime(BASE_EPOCH_MS + 11 * 60_000);
    checkAndIncrement(state, "client-fresh:memory_search", 5);
    expect(state.buckets.size).toBe(2);

    // Prune keeping the last 10 minutes -- the old (11-min-stale) entry drops;
    // the fresh entry survives.
    pruneOldBuckets(state, 10);
    expect(state.buckets.size).toBe(1);
    expect(state.buckets.has("client-fresh:memory_search")).toBe(true);
    expect(state.buckets.has("client-old:memory_search")).toBe(false);
  });

  it("pruneOldBuckets is a no-op when all buckets are within the keep window", () => {
    const state = createRateLimitState();
    checkAndIncrement(state, "client-a:memory_search", 5);
    checkAndIncrement(state, "client-b:web_search", 5);
    expect(state.buckets.size).toBe(2);

    // Advance 5 minutes (< 10) and prune.
    vi.setSystemTime(BASE_EPOCH_MS + 5 * 60_000);
    pruneOldBuckets(state, 10);
    expect(state.buckets.size).toBe(2);
  });
});
