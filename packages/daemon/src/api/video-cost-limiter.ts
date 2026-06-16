// SPDX-License-Identifier: Apache-2.0
/**
 * SEC-02 / DIVERGENCE 3: per-agent hourly video-generation COST ceiling, gated
 * PRE-SUBMIT against a worst-case estimate.
 *
 * A daemon-side fixed-window USD accumulator that mirrors the image cost limiter
 * (`./image-cost-limiter.ts`) byte-for-byte in structure — same per-agent `Map`,
 * same one-hour fixed window, same `systemNowMs` clock, same NaN/negative clamp
 * on `record` — with ONE deliberate divergence: `canSpend` takes a worst-case
 * `estimateUsd` and gates the SUM `(accumulated + estimate)`, not the bare
 * accumulated spend.
 *
 * WHY the estimate (vs the image limiter's post-hoc `canSpend(agentId)`): an
 * image's cost is only known AFTER `provider.execute`, so the image gate is a
 * pre-check on the ALREADY-spent total plus a post-hoc `record`. A video clip is
 * dollars-per-clip and is ALREADY RENDERING once submitted (I6) — there is no
 * "un-bill" once the queue accepts the job — so the ceiling cannot wait for the
 * actual cost. The handler computes a conservative worst-case estimate
 * (`estimateVideoCostUsd`: duration × per-second rate, audio/4k upper bound) and
 * passes it here BEFORE calling `port.execute`; exceeding the ceiling blocks the
 * submit. After completion the handler reconciles the actual cost via `record`.
 *
 * SOFT CAP — concurrency caveat (WR-01, inherited from the image limiter). The
 * pre-check and `record` straddle the `await port.execute`, and `canSpend` is a
 * read-only check with NO reservation. So N concurrent same-agent `video.generate`
 * calls all evaluate `canSpend()` BEFORE any `record()` runs: when the
 * accumulated spend is just under the ceiling, all N can pass and all N charge —
 * the bucket can finish OVER the ceiling by up to (concurrency − 1) × per-call
 * cost. This is therefore a BEST-EFFORT per-hour ceiling, not a hard guarantee.
 * The overshoot is BOUNDED, not unbounded: the count rate limit (`maxPerHour`,
 * checked FIRST in video-handlers.ts via the rate limiter's atomic
 * check-and-increment `tryAcquire`) caps the concurrent in-flight renders per
 * agent, so the worst-case spend within one window is
 * ~`maxPerHour × maxCostPerRender` rather than infinity, and `agentId` is
 * dispatcher-injected from the agent scope (not attacker-controllable). Because
 * the video gate is on the ESTIMATE (worst-case) rather than the realized cost,
 * it is strictly MORE conservative than the image post-hoc gate. Operators who
 * need a hard ceiling should set `maxPerHour` conservatively alongside
 * `maxCostPerHourUsd`. A true reservation (reserve the estimate at the pre-check,
 * reconcile at record) is deliberately NOT added — it introduces a
 * reservation-leak failure class (a thrown execute must always release) for a
 * bound the count limit already provides.
 *
 * The count rate limiter (`maxPerHour`) is RETAINED and orthogonal; this ADDS a
 * USD ceiling. When `maxCostPerHourUsd` is unset the limiter is not constructed
 * at all (the dep is `undefined` and the ceiling is skipped) — no regression for
 * installs that do not opt in.
 *
 * @module
 */
import { systemNowMs } from "@comis/core";

/** Per-agent hourly USD cost ceiling for video generation (SEC-02). */
export interface VideoCostLimiter {
  /**
   * True if the agent can afford a render whose worst-case cost is `estimateUsd`
   * within the current window — i.e. `(accumulatedSpend + estimateUsd)` is at or
   * under `maxCostPerHourUsd` (the boundary is INCLUSIVE). DIVERGENCE 3: unlike
   * the image limiter this takes the pre-submit estimate, because a video clip is
   * already rendering once submitted (I6) so the gate must run BEFORE the call.
   *
   * BEST-EFFORT under concurrency (WR-01): a read-only check with no reservation
   * — concurrent same-agent calls can each pass before any records, overshooting
   * by up to (concurrency − 1) × per-call cost. Bounded by the count rate limit
   * (`maxPerHour`, checked first). See the module header.
   */
  canSpend(agentId: string, estimateUsd: number): boolean;
  /**
   * Reconcile the agent's current-window bucket to the ACTUAL cost after a
   * successful submit/generation. A negative/NaN value is clamped to 0 (no
   * negative accounting — an attacker must not be able to "credit" the bucket).
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
 * Create a per-agent USD cost limiter for video generation.
 *
 * Uses a simple fixed-window approach: resets the accumulator after one hour
 * from the first activity in the window (mirrors the count rate limiter and the
 * image cost limiter).
 *
 * @param opts - Configuration with the maxCostPerHourUsd ceiling and an optional
 *   clock override (for deterministic tests).
 * @returns VideoCostLimiter instance
 */
export function createVideoCostLimiter(opts: {
  maxCostPerHourUsd: number;
  nowMs?: () => number;
}): VideoCostLimiter {
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
    canSpend(agentId: string, estimateUsd: number): boolean {
      // DIVERGENCE 3: gate the SUM (accumulated + worst-case estimate) against
      // the ceiling, INCLUSIVE. A poisoned (negative/NaN) estimate clamps to 0
      // so it cannot drive the sum below the accumulated spend (no gate bypass).
      const est = Number.isFinite(estimateUsd) ? Math.max(0, estimateUsd) : 0;
      return freshBucket(agentId, nowMs()).spentUsd + est <= opts.maxCostPerHourUsd;
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
