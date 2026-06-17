// SPDX-License-Identifier: Apache-2.0
/**
 * Per-trajectory resolve-dedup guard for the Verified Learning outcome loop
 * (setup-learning.ts). Extracted as its own unit (mirrors setup-learning-skill-trend.ts)
 * so the resolve seam stays under the 800-line file-size cap.
 *
 * Why a daemon-side guard is required (CR / idempotency): `OutcomeSignalPort.resolve()`
 * is a PURE read+fusion — it does NOT mark its rows resolved (sqlite-outcome-store.ts
 * has no "resolved" column), so a second resolve for the same trajectory returns the
 * SAME verdict and re-running the consumer chain would double the reward/promote. A DAG
 * turn fires BOTH `graph:completed` AND `diagnostic:message_processed` (the single-agent
 * path's completion event), so the chain must run exactly ONCE per trajectory.
 *
 * @module
 */

/**
 * The per-trajectory resolve-dedup Set cap. Bounded daemon-side gauge (resets on
 * restart — a post-restart re-resolve is benign, never a correctness loss). 50_000
 * mirrors the corroboration/reaction caps; past it the oldest trajectory id is dropped.
 */
export const MAX_TRACKED_RESOLVED_TRAJECTORIES = 50_000;

/**
 * Mark a trajectory resolved, returning `true` ONLY the FIRST time (the caller then
 * runs the consumer chain) and `false` on every replay. Bounded evict-oldest (Set
 * insertion order is recency — a key is never re-inserted, since a replay returns false
 * before reaching the add). Keying on the bare trajectoryId is safe: the (tenant, agent)
 * scope already gated the call and a trajectoryId (=traceId) is globally unique per turn.
 */
export function markTrajectoryResolved(
  trajectoryId: string,
  resolved: Set<string>,
  maxTracked: number = MAX_TRACKED_RESOLVED_TRAJECTORIES,
): boolean {
  if (resolved.has(trajectoryId)) return false;
  if (resolved.size >= maxTracked) {
    const oldest = resolved.values().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
  resolved.add(trajectoryId);
  return true;
}
