// SPDX-License-Identifier: Apache-2.0
/**
 * Corroboration gate — the anti-induced-eviction SECURITY control shared
 * by the learned-skill demote path and the memory failure-accrual path in
 * `setup-learning.ts`. Extracted to its own leaf (zero imports from setup-learning.ts
 * → no cycle) to keep `setup-learning.ts` under the 800-line cap. `setup-learning.ts`
 * re-exports these for the existing importers (setup-learning.test.ts).
 *
 * @module
 */

/** The DETERMINISTIC fused-verdict sources — a single one of these satisfies the corroboration gate. */
const DETERMINISTIC_FUSION_SOURCES: ReadonlySet<string> = new Set(["tool", "pipeline"]);
/** Independent (distinct-session) failures required to corroborate a NON-deterministic failure. */
export const CORROBORATION_MIN_INDEPENDENT = 2;

/**
 * Bound on the corroboration tally — the max distinct memoryIds the
 * `failureCorroborationTally` Map tracks before evicting the oldest. The tally is a
 * daemon-lifetime in-process gauge (resets on restart); without a cap a busy system (or
 * an adversary on rotating session keys) grows it unbounded. 50_000 mirrors the
 * reaction/session trajectory maps' `maxEntries`. Past it the oldest-touched id is
 * dropped — a soft forget of the stalest corroboration state, never a correctness loss.
 */
export const MAX_TRACKED_FAILURE_MEMORIES = 50_000;

/**
 * Anti-induced-eviction corroboration gate (a SECURITY control). A
 * `failure_count` accrual is permitted ONLY when corroborated:
 *  - (a) the fused verdict has a DETERMINISTIC source (`tool`/`pipeline`) — one
 *    suffices (it cannot be spoofed by an external sender), OR
 *  - (b) the daemon has seen ≥2 INDEPENDENT failures (distinct sessions) for this
 *    memory within the subscriber's lifetime.
 * Below the gate → no accrual (Defer ≠ Retry — a single low-trust/`external` failure
 * is benign). Daemon-side half of the two-layer control; the high-proof/system/pinned
 * EVICTION exemption is store-side, so the daemon reads NO per-memory
 * proof/trust/pinned here (`ResolvedOutcome` carries none — no hot-path DB read).
 *
 * Mutates `tally` (memoryId → distinct sessionIds seen failing it) so the across-call
 * distinct-session count accumulates. Returns true when the accrual should fire.
 *
 * BOUNDED (two caps, no daemon-lifetime growth): (1) the inner per-memory Set
 * STOPS growing at `CORROBORATION_MIN_INDEPENDENT` (past the gate the exact count is
 * irrelevant); (2) the outer Map is capped at `maxTracked` (default
 * {@link MAX_TRACKED_FAILURE_MEMORIES}) and evicts the OLDEST-touched memoryId
 * (insertion order = recency via delete-before-set). Both keep the gate decision
 * byte-identical for any realistic workload — the caps only bite the adversarial case.
 */
export function failureCorroborated(
  memoryId: string,
  sessionId: string,
  sources: ReadonlyArray<string>,
  tally: Map<string, Set<string>>,
  maxTracked: number = MAX_TRACKED_FAILURE_MEMORIES,
): boolean {
  // Record this failure's session BEFORE the decision so the distinct-session
  // count includes the current occurrence (the 2nd distinct session corroborates).
  let sessions = tally.get(memoryId);
  if (sessions === undefined) {
    // Cap the number of tracked memoryIds: when a NEW memoryId would exceed the cap,
    // evict the OLDEST-touched one (the first key — Map insertion order is recency
    // because a re-touch deletes-before-re-sets below).
    if (tally.size >= maxTracked) {
      const oldestKey = tally.keys().next().value;
      if (oldestKey !== undefined) tally.delete(oldestKey);
    }
    sessions = new Set<string>();
    tally.set(memoryId, sessions);
  } else {
    // Refresh recency: delete-before-set moves this memoryId to the Map's tail so the
    // evict-oldest (first key) above stays the genuine least-recently-touched id.
    tally.delete(memoryId);
    tally.set(memoryId, sessions);
  }
  // Stop growing the inner Set once the corroboration floor is reachable — past
  // CORROBORATION_MIN_INDEPENDENT the precise count never changes the gate decision.
  if (sessions.size < CORROBORATION_MIN_INDEPENDENT) sessions.add(sessionId);
  if (sources.some((s) => DETERMINISTIC_FUSION_SOURCES.has(s))) return true;
  return sessions.size >= CORROBORATION_MIN_INDEPENDENT;
}
