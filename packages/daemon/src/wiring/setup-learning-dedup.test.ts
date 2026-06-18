// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for markTrajectoryResolved — the per-trajectory resolve-dedup guard for the
 * Verified Learning outcome loop (setup-learning.ts).
 *
 * `OutcomeSignalPort.resolve()` is a PURE read+fusion (no row-state mutation), so the
 * daemon-side dedup is what makes the resolve→consume chain run exactly ONCE per
 * trajectory. A DAG turn fires BOTH `graph:completed` AND `diagnostic:message_processed`
 * (the single-agent path's completion event), so without this guard the consumer chain
 * (RANK reward / FORGET accrual / SURFACE promote-demote) would run twice for one
 * trajectory — double reward / double promote. Mirrors the WR-01 bounded-tally tests
 * for failureCorroborated (setup-learning.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  markTrajectoryResolved,
  MAX_TRACKED_RESOLVED_TRAJECTORIES,
} from "./setup-learning-dedup.js";

describe("markTrajectoryResolved — per-trajectory resolve dedup", () => {
  it("returns true the FIRST time a trajectory is seen and false on every replay", () => {
    const seen = new Set<string>();
    expect(markTrajectoryResolved("traj-1", seen)).toBe(true); // first → run the chain
    expect(markTrajectoryResolved("traj-1", seen)).toBe(false); // replay → no-op
    expect(markTrajectoryResolved("traj-1", seen)).toBe(false);
    // A DISTINCT trajectory is independent (the dedup does not collapse them).
    expect(markTrajectoryResolved("traj-2", seen)).toBe(true);
  });

  it("a DAG turn's two completion events resolve a trajectory exactly once", () => {
    // The real wiring calls markTrajectoryResolved once per completion event. A DAG
    // turn fires graph:completed AND diagnostic:message_processed for the SAME traceId.
    const seen = new Set<string>();
    const trajectoryId = "trace-dag-1";
    const firstFires = markTrajectoryResolved(trajectoryId, seen); // graph:completed
    const secondFires = markTrajectoryResolved(trajectoryId, seen); // diagnostic
    expect(firstFires).toBe(true); // exactly one runs the consumer chain
    expect(secondFires).toBe(false); // the other is a no-op (no double reward/promote)
  });

  it("caps the tracked trajectory ids (bounded evict-oldest, no daemon-lifetime growth)", () => {
    const seen = new Set<string>();
    const maxTracked = 8; // small explicit cap for the test
    for (let i = 0; i < 500; i++) markTrajectoryResolved(`traj-${i}`, seen, maxTracked);
    // The Set is bounded by the cap — it never holds all 500 ids.
    expect(seen.size).toBeLessThanOrEqual(maxTracked);
    // The MOST RECENT id is retained (evict-oldest, not evict-newest).
    expect(seen.has("traj-499")).toBe(true);
    // The OLDEST id was evicted, so a later re-resolve of it reads as "first seen"
    // again — a benign at-most-once-more (cf. a daemon restart), never a correctness loss.
    expect(markTrajectoryResolved("traj-0", seen, maxTracked)).toBe(true);
  });

  it("defaults the cap to MAX_TRACKED_RESOLVED_TRAJECTORIES (a bounded, sane value)", () => {
    // The default cap is a finite bound (not Infinity / 0) — a busy fleet cannot grow
    // the Set without limit, and a realistic per-turn workload never bites the cap.
    expect(MAX_TRACKED_RESOLVED_TRAJECTORIES).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_TRACKED_RESOLVED_TRAJECTORIES)).toBe(true);
  });
});
