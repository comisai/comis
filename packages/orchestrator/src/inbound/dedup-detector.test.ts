// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the bounded-LRU duplicate-message detector.
 *
 * Covers:
 *   - first_check_returns_isDuplicate_false
 *   - second_check_within_window_returns_isDuplicate_true_with_deltaMs_1
 *   - check_after_window_expires_returns_isDuplicate_false (eviction by age)
 *   - inserting_more_than_1024_entries_keeps_map_size_at_or_below_1024 (FIFO cap)
 *   - check_result_is_synchronous_not_a_Promise
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createDedupDetector } from "./dedup-detector.js";

describe("createDedupDetector -- reservation lifecycle", () => {
  it("admits the same source after an uncommitted reservation rolls back", () => {
    const detector = createDedupDetector({ now: () => 1000 });
    const first = detector.reserve("m1");
    expect(first.isDuplicate).toBe(false);
    first.reservation?.rollback();

    const retry = detector.reserve("m1");
    expect(retry.isDuplicate).toBe(false);
  });

  it("suppresses the same source after its reservation commits", () => {
    const detector = createDedupDetector({ now: () => 1000 });
    const first = detector.reserve("m1");
    first.reservation?.commit();

    const retry = detector.reserve("m1");
    expect(retry).toEqual({
      isDuplicate: true,
      firstSeenAt: 1000,
      deltaMs: 0,
    });
  });
});

describe("createDedupDetector -- first check returns not-duplicate", () => {
  it("first_check_for_a_new_messageId_returns_isDuplicate_false", () => {
    const detector = createDedupDetector({ now: () => 1000 });
    const result = detector.reserve("m1");
    expect(result.isDuplicate).toBe(false);
    expect(result.firstSeenAt).toBeUndefined();
    expect(result.deltaMs).toBeUndefined();
  });
});

describe("createDedupDetector -- duplicate detection within window", () => {
  it("second_check_within_window_returns_isDuplicate_true_with_deltaMs_1", () => {
    let now = 1000;
    const detector = createDedupDetector({ now: () => now });

    // First call at t=1000 — not a duplicate
    const first = detector.reserve("m1");
    expect(first.isDuplicate).toBe(false);

    // Second call at t=1001 — duplicate within 10s window
    now = 1001;
    const second = detector.reserve("m1");
    expect(second.isDuplicate).toBe(true);
    expect(second.firstSeenAt).toBe(1000);
    expect(second.deltaMs).toBe(1);
  });

  it("subsequent_duplicate_checks_accumulate_deltaMs_correctly (firstSeenAt stays stable)", () => {
    let now = 1000;
    const detector = createDedupDetector({ now: () => now });

    detector.reserve("m1"); // t=1000, first seen

    now = 1005;
    const second = detector.reserve("m1"); // t=1005, duplicate
    expect(second.isDuplicate).toBe(true);
    expect(second.firstSeenAt).toBe(1000);
    expect(second.deltaMs).toBe(5);

    now = 1009;
    const third = detector.reserve("m1"); // t=1009, still within 10s
    expect(third.isDuplicate).toBe(true);
    expect(third.firstSeenAt).toBe(1000); // stable — NOT refreshed
    expect(third.deltaMs).toBe(9);
  });
});

describe("createDedupDetector -- eviction by age (10s window)", () => {
  it("check_after_window_expires_returns_isDuplicate_false (entry evicted)", () => {
    let now = 1000;
    const detector = createDedupDetector({ windowMs: 10_000, now: () => now });

    // First check at t=1000
    detector.reserve("m1");

    // Check at t=11001 — 11s later, OUTSIDE the 10s window
    now = 1000 + 10_001;
    const result = detector.reserve("m1");
    expect(result.isDuplicate).toBe(false);
    // After eviction + re-insert, firstSeenAt is the new timestamp
    expect(result.firstSeenAt).toBeUndefined();
    expect(result.deltaMs).toBeUndefined();
  });

  it("check_at_exact_window_boundary_is_outside_window (ts - firstSeenAt < windowMs only)", () => {
    let now = 1000;
    const detector = createDedupDetector({ windowMs: 10_000, now: () => now });

    detector.reserve("m1"); // firstSeenAt = 1000

    // At t=11000: delta = 10000 ms. firstSeenAt (1000) < ts (11000) - windowMs (10000) = 1000 → NOT evicted.
    // 1000 < 1000 is false → entry survives → isDuplicate=true
    now = 11_000;
    const result = detector.reserve("m1");
    // The eviction condition is: seenAt < ts - windowMs  → 1000 < 11000 - 10000 = 1000 → 1000 < 1000 is FALSE
    // So the entry is NOT evicted at exactly the boundary — still a duplicate.
    expect(result.isDuplicate).toBe(true);
  });
});

describe("createDedupDetector -- LRU cap (1024 max entries)", () => {
  it("inserting_more_than_1024_entries_keeps_map_size_at_or_below_1024 (oldest evicted FIFO)", () => {
    // All within the same time window so no age-eviction.
    const detector = createDedupDetector({ maxEntries: 1024, windowMs: 60_000, now: () => 1000 });

    for (let i = 0; i < 1026; i++) {
      detector.reserve(`msg-${i}`);
    }

    // The detector's map is internal; we confirm via behavior:
    // The OLDEST entry (msg-0 and msg-1) should have been evicted.
    // After inserting msg-0 through msg-1025 with max=1024:
    //   After msg-1024 is inserted → size=1025 > 1024 → evict msg-0 (oldest)
    //   After msg-1025 is inserted → size=1025 > 1024 → evict msg-1 (new oldest)
    // So msg-0 and msg-1 should no longer be duplicates.
    const old0 = detector.reserve("msg-0");
    const old1 = detector.reserve("msg-1");
    expect(old0.isDuplicate).toBe(false); // evicted → treated as new
    expect(old1.isDuplicate).toBe(false); // evicted → treated as new

    // Recently added entries should still be seen as duplicates.
    const recent = detector.reserve("msg-1025");
    expect(recent.isDuplicate).toBe(true);
  });

  it("custom_maxEntries_cap_respected_when_overridden", () => {
    // Fixed clock so eviction only triggers on size, not age.
    const detector = createDedupDetector({ maxEntries: 3, windowMs: 60_000, now: () => 1000 });

    detector.reserve("a"); // 1st entry
    detector.reserve("b"); // 2nd entry
    detector.reserve("c"); // 3rd entry
    detector.reserve("d"); // 4th entry → size=4 > 3 → evict "a" (oldest)

    // "a" should have been evicted — treated as a new entry
    const resultA = detector.reserve("a"); // — not a duplicate (was evicted)
    expect(resultA.isDuplicate).toBe(false);

    // "a" was just re-inserted as part of the previous check. Now we insert "e".
    // seen after resultA check: {b:1000, c:1000, d:1000, a:1000} but max=3 so "b" evicted.
    // → seen = {c:1000, d:1000, a:1000}
    // "c" and "d" should still be duplicates.
    const resultC = detector.reserve("c");
    expect(resultC.isDuplicate).toBe(true);

    const resultD = detector.reserve("d");
    expect(resultD.isDuplicate).toBe(true);
  });
});

describe("createDedupDetector -- synchrony", () => {
  it("check_result_is_synchronous_not_a_Promise", () => {
    const detector = createDedupDetector({ now: () => 1000 });
    const result = detector.reserve("m1");
    // A Promise has a .then method; a plain object does not.
    expect(typeof result).toBe("object");
    expect(result).not.toBeInstanceOf(Promise);
    // More direct: result.isDuplicate is immediately available.
    expect(typeof result.isDuplicate).toBe("boolean");
  });
});

describe("createDedupDetector -- default options", () => {
  it("default_options_use_maxEntries_1024_and_windowMs_10000", () => {
    // createDedupDetector() with no args should not throw and should work.
    const detector = createDedupDetector();
    const r1 = detector.reserve("m1");
    expect(r1.isDuplicate).toBe(false);
    const r2 = detector.reserve("m1");
    // Within default 10s window (real time), it should be a duplicate.
    expect(r2.isDuplicate).toBe(true);
  });
});
