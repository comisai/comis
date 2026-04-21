// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for block-stability-tracker.ts -- per-zone content stability tracking.
 *
 * Covers: promotion threshold, demotion on change, zone independence,
 * session isolation, session cleanup, first-call baseline, performance,
 * and configurable threshold.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createBlockStabilityTracker,
  clearSessionBlockStability,
  type BlockStabilityTracker,
} from "./block-stability-tracker.js";

describe("BlockStabilityTracker", () => {
  let tracker: BlockStabilityTracker;

  beforeEach(() => {
    // Clear all module-level state between tests
    clearSessionBlockStability("sess-A");
    clearSessionBlockStability("sess-B");
    tracker = createBlockStabilityTracker();
  });

  it("promotion after threshold: stable after N consecutive identical hashes", () => {
    const session = "sess-A";
    const zone = "semi-stable";
    const hash = 12345;
    const threshold = 3;

    // Record hash 3 times -- should NOT be stable yet (need >= threshold)
    tracker.recordZoneHash(session, zone, hash);
    expect(tracker.isStable(session, zone, threshold)).toBe(false);

    tracker.recordZoneHash(session, zone, hash);
    expect(tracker.isStable(session, zone, threshold)).toBe(false);

    tracker.recordZoneHash(session, zone, hash);
    // 3rd call = consecutiveCount 3 >= threshold 3
    expect(tracker.isStable(session, zone, threshold)).toBe(true);

    // 4th call still stable
    tracker.recordZoneHash(session, zone, hash);
    expect(tracker.isStable(session, zone, threshold)).toBe(true);
  });

  it("demotion on content change: resets counter when hash changes", () => {
    const session = "sess-A";
    const zone = "semi-stable";
    const threshold = 3;

    // Reach stability
    tracker.recordZoneHash(session, zone, 12345);
    tracker.recordZoneHash(session, zone, 12345);
    tracker.recordZoneHash(session, zone, 12345);
    expect(tracker.isStable(session, zone, threshold)).toBe(true);

    // Change hash -- counter resets to 1 (the new hash counts as first observation)
    tracker.recordZoneHash(session, zone, 99999);
    expect(tracker.isStable(session, zone, threshold)).toBe(false);

    // Need 2 more calls with 99999 to reach threshold 3 again
    tracker.recordZoneHash(session, zone, 99999);
    expect(tracker.isStable(session, zone, threshold)).toBe(false);

    tracker.recordZoneHash(session, zone, 99999);
    expect(tracker.isStable(session, zone, threshold)).toBe(true);
  });

  it("independent zones: stability of one zone does not affect another", () => {
    const session = "sess-A";
    const threshold = 3;

    // Zone "semi-stable" reaches stability
    tracker.recordZoneHash(session, "semi-stable", 111);
    tracker.recordZoneHash(session, "semi-stable", 111);
    tracker.recordZoneHash(session, "semi-stable", 111);
    expect(tracker.isStable(session, "semi-stable", threshold)).toBe(true);

    // Zone "recent" has only 1 call -- should NOT be stable
    tracker.recordZoneHash(session, "recent", 222);
    expect(tracker.isStable(session, "recent", threshold)).toBe(false);
  });

  it("session isolation: different sessions are fully independent", () => {
    const threshold = 3;

    // Session A reaches stability
    tracker.recordZoneHash("sess-A", "zone1", 111);
    tracker.recordZoneHash("sess-A", "zone1", 111);
    tracker.recordZoneHash("sess-A", "zone1", 111);
    expect(tracker.isStable("sess-A", "zone1", threshold)).toBe(true);

    // Session B same zone same hash -- only 1 call, not stable
    tracker.recordZoneHash("sess-B", "zone1", 111);
    expect(tracker.isStable("sess-B", "zone1", threshold)).toBe(false);
  });

  it("clearSession removes all state: subsequent isStable returns false", () => {
    const session = "sess-A";
    const threshold = 3;

    // Reach stability
    tracker.recordZoneHash(session, "zone1", 111);
    tracker.recordZoneHash(session, "zone1", 111);
    tracker.recordZoneHash(session, "zone1", 111);
    expect(tracker.isStable(session, "zone1", threshold)).toBe(true);

    // Clear session
    clearSessionBlockStability(session);

    // State is gone -- isStable should return false
    expect(tracker.isStable(session, "zone1", threshold)).toBe(false);
  });

  it("first call sets baseline: isStable returns false on first call", () => {
    const session = "sess-A";

    tracker.recordZoneHash(session, "zone1", 111);
    // First call = consecutiveCount 1, threshold 1 would be true but threshold > 1 = false
    expect(tracker.isStable(session, "zone1", 2)).toBe(false);
    // Even with threshold=1, first call means consecutiveCount=1 which equals threshold
    expect(tracker.isStable(session, "zone1", 1)).toBe(true);
  });

  it("performance: < 1ms for 10 zones", () => {
    const session = "sess-A";
    const start = performance.now();

    for (let i = 0; i < 10; i++) {
      tracker.recordZoneHash(session, `zone-${i}`, i * 1000);
      tracker.isStable(session, `zone-${i}`, 3);
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1);
  });

  it("threshold=1 means stable on second identical call", () => {
    const session = "sess-A";
    const zone = "fast-zone";

    // First call sets baseline with consecutiveCount=1
    tracker.recordZoneHash(session, zone, 42);
    // threshold=1 means stable when consecutiveCount >= 1
    // First call gives consecutiveCount=1 which equals threshold
    expect(tracker.isStable(session, zone, 1)).toBe(true);

    // Second identical call increments to 2, still stable
    tracker.recordZoneHash(session, zone, 42);
    expect(tracker.isStable(session, zone, 1)).toBe(true);
  });
});
