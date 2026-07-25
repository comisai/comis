// SPDX-License-Identifier: Apache-2.0
/**
 * Dedup Detector Load Test
 *
 * Exercises the bounded-LRU duplicate detector at 10× expected production
 * throughput (~300 msg/s synthetic) using the injectable `now` clock for
 * full determinism (no real-timer dependency — CI-safe).
 *
 * Targets:
 *   - sub-millisecond per-check overhead at ~300 msg/s (10× expected)
 *   - bounded memory: Map never exceeds maxEntries (1024) — verified via
 *     eviction behavior (old IDs outside the window become fresh again)
 *   - correct duplicate detection within the window
 *   - correct post-window eviction (expired entries return isDuplicate:false)
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createDedupDetector } from "./dedup-detector.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 10× production load: 300 msg/s for 10 synthetic seconds */
const MESSAGES_PER_SECOND = 300;
const WINDOW_SECONDS = 10;
const TOTAL_MESSAGES = MESSAGES_PER_SECOND * WINDOW_SECONDS; // 3000
const INTERVAL_MS = 1000 / MESSAGES_PER_SECOND; // 3.33ms per message

/** Generous wall-clock ceiling: 100ms for 3000 synchronous Map checks */
const PERF_CEILING_MS = 100;

/** LRU cap */
const MAX_ENTRIES = 1024;

/** Dedup window */
const WINDOW_MS = 10_000; // 10 seconds

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dedup-detector load test — 10× expected production throughput", () => {

  it("all TOTAL_MESSAGES checks complete under the 100ms wall-clock ceiling (throughput guard)", () => {
    // This test only checks timing — no duplicates injected, just N unique IDs.
    let nowMs = 0;
    const detector = createDedupDetector({
      maxEntries: MAX_ENTRIES,
      windowMs: WINDOW_MS,
      now: () => nowMs,
    });

    const start = Date.now();
    for (let i = 0; i < TOTAL_MESSAGES; i++) {
      nowMs = Math.floor(i * INTERVAL_MS);
      detector.reserve(`msg-${i}`);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(PERF_CEILING_MS);
  });

  it("duplicates within a small window are correctly detected at 300 msg/s synthetic clock", () => {
    // Use a short sub-window so duplicates don't get evicted by the cap before re-check.
    // Insert 200 unique IDs (well below cap=1024), then re-inject 50 of them as duplicates.
    let nowMs = 0;
    const detector = createDedupDetector({
      maxEntries: MAX_ENTRIES,
      windowMs: WINDOW_MS,
      now: () => nowMs,
    });

    const UNIQUE_COUNT = 200;
    const DUPLICATE_COUNT = 50;

    // Step 1: insert UNIQUE_COUNT distinct messages at 300 msg/s pace
    for (let i = 0; i < UNIQUE_COUNT; i++) {
      nowMs = Math.floor(i * INTERVAL_MS);
      const result = detector.reserve(`dup-test-msg-${i}`);
      expect(result.isDuplicate).toBe(false);
    }

    // Step 2: re-inject the first DUPLICATE_COUNT IDs — they are still within the 10s window
    // (at 300 msg/s, 200 messages = 666ms elapsed, well under 10s)
    for (let i = 0; i < DUPLICATE_COUNT; i++) {
      nowMs = Math.floor((UNIQUE_COUNT + i) * INTERVAL_MS); // slightly later timestamps
      const result = detector.reserve(`dup-test-msg-${i}`);
      expect(result.isDuplicate).toBe(true); // within window → duplicate detected
      expect(result.deltaMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("post-window eviction: IDs past the 10s window return isDuplicate:false (bounded memory confirmed)", () => {
    // Insert a single ID at t=0, then check it after 10001ms → window expired → evicted
    let nowMs = 0;
    const detector = createDedupDetector({
      maxEntries: MAX_ENTRIES,
      windowMs: WINDOW_MS,
      now: () => nowMs,
    });

    // Insert at t=0
    detector.reserve("evict-test-msg");
    expect(detector.reserve("evict-test-msg")).toMatchObject({ isDuplicate: true }); // within window

    // Advance past the window
    nowMs = WINDOW_MS + 1; // 10001ms
    const afterWindow = detector.reserve("evict-test-msg");
    expect(afterWindow.isDuplicate).toBe(false); // evicted → treated as fresh
  });

  it("LRU cap enforced: inserting more than 1024 entries evicts oldest, Map stays bounded", () => {
    // Fixed clock so no age-eviction — only cap-based eviction
    const detector = createDedupDetector({
      maxEntries: MAX_ENTRIES,
      windowMs: 60_000, // long window, no age eviction
      now: () => 5_000,  // fixed clock
    });

    // Insert MAX_ENTRIES + 50 unique IDs
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      detector.reserve(`cap-msg-${i}`);
    }

    // The first 50 entries (oldest) should have been evicted by FIFO cap policy
    // Re-checking them: they return isDuplicate:false (evicted → treated as fresh)
    for (let i = 0; i < 50; i++) {
      const r = detector.reserve(`cap-msg-${i}`);
      // The evicted IDs get re-inserted here, but the important check is
      // that the ORIGINAL insert was gone → first re-check = not duplicate
      expect(r.isDuplicate).toBe(false);
    }

    // IDs near the end of the original insertion (after the cap evictions) were
    // recently inserted and should still be duplicates — pick one from the "safe" range
    // (note: after re-inserting 50 evicted IDs above, the cap evicts 50 more from the
    // middle of the range; pick an ID known to survive — near the last inserted)
    const lastInserted = `cap-msg-${MAX_ENTRIES + 49}`;
    const recent = detector.reserve(lastInserted);
    expect(recent.isDuplicate).toBe(true);
  });

  it("synchronous: every reserve is a plain DedupReservationResult (not a Promise)", () => {
    let nowMs = 1000;
    const detector = createDedupDetector({ now: () => nowMs });

    // Fresh check
    const r1 = detector.reserve("sync-reserve-msg");
    expect(r1).not.toBeInstanceOf(Promise);
    expect(typeof r1.isDuplicate).toBe("boolean");
    expect(r1.isDuplicate).toBe(false);

    // Duplicate check
    nowMs = 1001;
    const r2 = detector.reserve("sync-reserve-msg");
    expect(r2).not.toBeInstanceOf(Promise);
    expect(r2.isDuplicate).toBe(true);
    expect(r2.deltaMs).toBe(1);
  });
});
