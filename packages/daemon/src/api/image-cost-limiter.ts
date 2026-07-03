// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent hourly image-generation COST ceiling.
 *
 * A daemon-side fixed-window USD accumulator that mirrors the count rate
 * limiter (`@comis/skills` `image-gen/rate-limiter.ts`) byte-for-byte in
 * structure — same per-agent `Map`, same one-hour fixed window, same
 * `systemNowMs` clock — but accumulates spend (USD) instead of a count.
 *
 * It lives in `@comis/daemon` (NOT `@comis/skills`) deliberately: the cost
 * ceiling is a daemon-side accumulator wired beside the boot-selected provider
 * in the RPC handler, and placing it here keeps the cycle graph clean (no new
 * pi-ai/core-media import edge into skills).
 *
 * Usage (image-handlers.ts): the cost of a generation is only known AFTER
 * `provider.execute`, so the gate is a two-step:
 *   1. BEFORE execute — `canSpend(agentId)` pre-check; block with
 *      `quota_exceeded` if the accumulated spend this window already reached
 *      the ceiling.
 *   2. AFTER a successful generation — `record(agentId, costUsd)` to accumulate
 *      the actual cost into the agent's bucket for the rest of the window.
 *
 * SOFT CAP — concurrency caveat. The two steps straddle the
 * `await provider.execute`, and `canSpend` is a read-only pre-check with NO
 * reservation. So N concurrent `image.generate` calls for the SAME agent all
 * evaluate `canSpend()` BEFORE any `record()` runs: when the accumulated spend is
 * just under the ceiling, all N pass, all N execute, and all N charge — the
 * bucket can finish OVER the ceiling by up to (concurrency − 1) × per-call cost.
 * This is UNLIKE the count rate limiter, whose `tryAcquire` is an atomic
 * synchronous check-and-increment that claims the slot before the await and so
 * cannot be raced. This is therefore a BEST-EFFORT per-hour ceiling, not a hard
 * guarantee. The overshoot is BOUNDED, not unbounded: the count rate limit
 * (`maxPerHour`, checked FIRST in image-handlers.ts) caps the concurrent in-flight
 * generations per agent, so the worst-case spend within one window is
 * ~`maxPerHour × maxCostPerGeneration` rather than infinity, and `agentId` is
 * dispatcher-injected from the agent scope (not attacker-controllable). Operators
 * who need a hard ceiling should set `maxPerHour` conservatively alongside
 * `maxCostPerHourUsd`. A near-hard variant would require an in-flight reservation
 * (reserve an estimate at the pre-check, reconcile to the real costUsd at record)
 * — deliberately NOT added here: it introduces a reservation-leak failure class
 * (a thrown execute must always release) for a bound the count limit already
 * provides.
 *
 * The count rate limiter (`maxPerHour`) is RETAINED and orthogonal; this ADDS
 * a USD ceiling. When `maxCostPerHourUsd` is unset the limiter is not
 * constructed at all (the dep is `undefined` and the ceiling is skipped) — no
 * regression for installs that do not opt in.
 *
 * @module
 */
import { systemNowMs } from "@comis/core";

/** Per-agent hourly USD cost ceiling for image generation. */
export interface ImageCostLimiter {
  /**
   * True if the agent is still UNDER the ceiling for the current window.
   *
   * BEST-EFFORT under concurrency: this is a read-only pre-check with no
   * reservation, so concurrent same-agent calls can each pass before any records,
   * overshooting the ceiling by up to (concurrency − 1) × per-call cost. The
   * overshoot is bounded by the count rate limit (`maxPerHour`, checked first) —
   * see the module header. Not a hard guarantee.
   */
  canSpend(agentId: string): boolean;
  /**
   * Accumulate `costUsd` into the agent's current-window bucket after a
   * successful generation. A negative/NaN value is clamped to 0 (no negative
   * accounting — an attacker must not be able to "credit" the bucket).
   */
  record(agentId: string, costUsd: number): void;
  /** Reset the accumulator for a specific agent. */
  reset(agentId: string): void;
}

interface CostBucket {
  spentUsd: number;
  windowStart: number;
}

/**
 * Create a per-agent USD cost limiter for image generation.
 *
 * Uses a simple fixed-window approach: resets the accumulator after one hour
 * from the first activity in the window (mirrors the count rate limiter).
 *
 * @param opts - Configuration with the maxCostPerHourUsd ceiling and an
 *   optional clock override (for deterministic tests).
 * @returns ImageCostLimiter instance
 */
export function createImageCostLimiter(opts: {
  maxCostPerHourUsd: number;
  nowMs?: () => number;
}): ImageCostLimiter {
  const buckets = new Map<string, CostBucket>();
  const nowMs = opts.nowMs ?? (() => systemNowMs());
  const windowMs = 3_600_000; // 1 hour

  /** Resolve (and roll over) the agent's bucket for the current window. */
  const freshBucket = (agentId: string, now: number): CostBucket => {
    let bucket = buckets.get(agentId);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { spentUsd: 0, windowStart: now };
      buckets.set(agentId, bucket);
    }
    return bucket;
  };

  return {
    canSpend(agentId: string): boolean {
      return freshBucket(agentId, nowMs()).spentUsd < opts.maxCostPerHourUsd;
    },

    record(agentId: string, costUsd: number): void {
      // Clamp negative/NaN to 0 — Number.isFinite rejects NaN/±Infinity, then
      // Math.max guards a negative finite value. No negative accounting.
      const safe = Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;
      freshBucket(agentId, nowMs()).spentUsd += safe;
    },

    reset(agentId: string): void {
      buckets.delete(agentId);
    },
  };
}
