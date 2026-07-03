// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-agent/hour image-generation USD cost
 * accumulator. Clones the fixed-window structure of the count rate limiter
 * (`skills/.../image-gen/rate-limiter.ts` + `notification/rate-limiter.test.ts`)
 * — same `windowMs = 3_600_000`, same per-agent `Map`, deterministic clock via
 * `nowMs: () => clock` — but accumulates spend (USD) instead of a count, with a
 * `canSpend(agentId)` pre-check (the cost is only known AFTER provider.execute)
 * and a `record(agentId, costUsd)` post-hoc accumulate.
 * @module
 */
import { describe, it, expect } from "vitest";
import { createImageCostLimiter } from "./image-cost-limiter.js";

describe("createImageCostLimiter (per-agent hourly cost ceiling)", () => {
  it("canSpend is true for a fresh agent (no spend recorded yet)", () => {
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => 0 });
    expect(limiter.canSpend("agent-1")).toBe(true);
  });

  it("blocks once accumulated spend reaches/exceeds the ceiling", () => {
    let clock = 0;
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => clock });

    expect(limiter.canSpend("agent-1")).toBe(true); // 0 spent < 5
    limiter.record("agent-1", 6); // over the ceiling
    expect(limiter.canSpend("agent-1")).toBe(false); // 6 spent >= 5 → blocked
  });

  it("blocks exactly AT the ceiling (>=, not >)", () => {
    let clock = 0;
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => clock });

    limiter.record("agent-1", 3);
    expect(limiter.canSpend("agent-1")).toBe(true); // 3 < 5
    limiter.record("agent-1", 2);
    expect(limiter.canSpend("agent-1")).toBe(false); // 5 >= 5 → blocked
  });

  it("resets the accumulator after the window expires (1 hour)", () => {
    let clock = 0;
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => clock });

    limiter.record("agent-1", 6);
    expect(limiter.canSpend("agent-1")).toBe(false);

    // Advance past 1 hour — the fixed window resets the spend.
    clock = 3_600_001;
    expect(limiter.canSpend("agent-1")).toBe(true);
  });

  it("tracks independent accumulators per agentId", () => {
    let clock = 0;
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => clock });

    limiter.record("agent-1", 6);
    expect(limiter.canSpend("agent-1")).toBe(false);
    // A different agent has its own bucket — unaffected by agent-1's spend.
    expect(limiter.canSpend("agent-2")).toBe(true);
  });

  it("reset(agentId) clears that agent's accumulator", () => {
    let clock = 0;
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => clock });

    limiter.record("agent-1", 6);
    expect(limiter.canSpend("agent-1")).toBe(false);

    limiter.reset("agent-1");
    expect(limiter.canSpend("agent-1")).toBe(true);
  });

  it("clamps a negative/NaN costUsd to 0 (no negative accounting)", () => {
    let clock = 0;
    const limiter = createImageCostLimiter({ maxCostPerHourUsd: 5, nowMs: () => clock });

    limiter.record("agent-1", 4);
    // A negative refund-like value must NOT subtract from the accumulator
    // (Math.max(0, costUsd)) — otherwise an attacker could "credit" the bucket.
    limiter.record("agent-1", -10);
    expect(limiter.canSpend("agent-1")).toBe(true); // still 4 (the -10 clamped to 0)
    limiter.record("agent-1", Number.NaN);
    // NaN clamps to 0 too — the accumulator stays a finite 4, still under 5.
    expect(limiter.canSpend("agent-1")).toBe(true);
    limiter.record("agent-1", 1);
    expect(limiter.canSpend("agent-1")).toBe(false); // 4 + 0 + 0 + 1 = 5 >= 5
  });
});
