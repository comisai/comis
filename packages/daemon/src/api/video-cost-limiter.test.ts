// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the VideoCostLimiter (SEC-02 / DIVERGENCE 3).
 *
 * Unlike the image cost limiter (post-hoc `canSpend(agentId)` with no estimate),
 * video is dollars-per-clip and ALREADY rendering once submitted (I6), so the
 * ceiling MUST be gated against a worst-case estimate BEFORE the provider call:
 * `canSpend(agentId, estimateUsd)` returns false when `(accumulated + estimate)`
 * would exceed `maxCostPerHourUsd`. The boundary is INCLUSIVE (== ceiling is ok).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createVideoCostLimiter } from "./video-cost-limiter.js";

describe("createVideoCostLimiter (DIVERGENCE 3 — pre-submit estimate gate)", () => {
  it("blocks when the estimate ALONE would exceed the ceiling (no prior spend)", () => {
    // maxCostPerHourUsd=10, no accumulated spend: an 11 estimate exceeds.
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    expect(limiter.canSpend("agent-1", 11)).toBe(false);
  });

  it("permits the boundary case where the estimate exactly equals the ceiling (inclusive)", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    expect(limiter.canSpend("agent-1", 10)).toBe(true);
  });

  it("gates the SUM (accumulated + estimate), not the bare accumulated spend", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    // Accumulate 7, then a 5 estimate => 12 > 10 => blocked (a post-hoc
    // `< ceiling` form would WRONGLY pass here because 7 < 10).
    limiter.record("agent-1", 7);
    expect(limiter.canSpend("agent-1", 5)).toBe(false);
    // A 3 estimate => 10 <= 10 => still permitted (inclusive boundary).
    expect(limiter.canSpend("agent-1", 3)).toBe(true);
  });

  it("record(actual) reflects in a subsequent canSpend (reconcile after submit)", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    expect(limiter.canSpend("agent-1", 6)).toBe(true);
    limiter.record("agent-1", 6);
    // 6 already spent; a 5 estimate => 11 > 10 => blocked.
    expect(limiter.canSpend("agent-1", 5)).toBe(false);
  });

  it("clamps a negative / NaN actual to 0 (no negative accounting / bucket credit)", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    limiter.record("agent-1", 8);
    limiter.record("agent-1", -100); // must NOT credit the bucket back below 8
    limiter.record("agent-1", Number.NaN); // must NOT corrupt the accumulator
    // Still 8 spent: a 2 estimate => 10 <= 10 ok; a 3 estimate => 11 > 10 blocked.
    expect(limiter.canSpend("agent-1", 2)).toBe(true);
    expect(limiter.canSpend("agent-1", 3)).toBe(false);
  });

  it("clamps a negative / NaN ESTIMATE to 0 (a poisoned estimate cannot bypass the gate)", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    limiter.record("agent-1", 10); // bucket at the ceiling
    // A negative/NaN estimate clamps to 0 => 10 + 0 <= 10 => permitted (the
    // estimate cannot drive the sum below the accumulated spend).
    expect(limiter.canSpend("agent-1", -5)).toBe(true);
    expect(limiter.canSpend("agent-1", Number.NaN)).toBe(true);
    // But a real positive estimate is still blocked at the ceiling.
    expect(limiter.canSpend("agent-1", 0.01)).toBe(false);
  });

  it("reset(agent) clears the accumulator", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    limiter.record("agent-1", 9);
    expect(limiter.canSpend("agent-1", 5)).toBe(false);
    limiter.reset("agent-1");
    expect(limiter.canSpend("agent-1", 5)).toBe(true);
  });

  it("rolls the fixed window after one hour (accumulated spend resets)", () => {
    let now = 0;
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => now });
    limiter.record("agent-1", 9);
    expect(limiter.canSpend("agent-1", 5)).toBe(false); // same window
    now = 3_600_000; // exactly one hour later → window rolls
    expect(limiter.canSpend("agent-1", 9)).toBe(true);
  });

  it("isolates accumulators per agent", () => {
    const limiter = createVideoCostLimiter({ maxCostPerHourUsd: 10, nowMs: () => 0 });
    limiter.record("agent-1", 10);
    expect(limiter.canSpend("agent-1", 1)).toBe(false);
    expect(limiter.canSpend("agent-2", 10)).toBe(true); // a different agent is unaffected
  });
});
