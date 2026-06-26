// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * MemoryLifecyclePort: the SEGREGATED hexagonal boundary for the per-(tenant,
 * agent) memory LIFECYCLE sweep (Track C). A periodic,
 * KEYLESS maintenance pass that, in the LIVE policy, soft-evicts each non-exempt
 * candidate that is DORMANT past `maxDormantDays` OR corroborated-wrong
 * (`failure_count >= failureEvictionFloor`). Tier promote/demote moves remain a
 * deferred step (`promoted`/`demoted` stay 0).
 *
 * This is a NEW port — like MemoryUsefulnessStore /
 * UserRepresentationStore / TripleStorePort it deliberately does NOT widen the
 * security-reviewed `MemoryPort` (store/search/delete). New capabilities arrive
 * as their own segregated port. The sole adapter is in @comis/memory (it owns the
 * `db` handle and runs all SQL over the `memories` table + its additive lifecycle
 * marker, filtered on `(tenant_id, agent_id)`); the daemon wires it into
 * a default-OFF `__MEMORY_LIFECYCLE__` cron. The agent package consumes
 * this port TYPE from @comis/core — it cannot import @comis/memory (the
 * agent↛memory build cut). No new authority is granted beyond a scoped sweep
 * within the caller's own (tenant, agent).
 *
 * LIVE soft eviction (FORGET-01) — when the policy is eviction-enabled (the daemon
 * threads `learningForgetting.eviction.enabled` ∧ `.enabled`), the sweep soft-evicts
 * each non-exempt candidate that is DORMANT past `maxDormantDays` OR corroborated-wrong
 * (`failure_count >= failureEvictionFloor`), where exempt = pinned ∨
 * `trust_level='system'` ∨ high-`proof_count` (FORGET-03), reporting a real `evicted`
 * count. With the eviction behavior OFF (the default) the sweep stays DORMANT — it
 * scans but applies NOTHING (`evicted`/`demoted` = 0; the byte-identity guarantee).
 * Tier demote/promote moves are still deferred (`promoted`/`demoted` stay 0). The
 * default-OFF knob is a behavior gate, NOT a back-compat fallback. The eviction policy
 * is NON-DESTRUCTIVE by design (the `evicted_at` marker — mirror `consolidated_at` —
 * never a hard DELETE of the raw row), and REVERSIBLE via {@link unevict}.
 *
 * The method returns `Promise<Result<…, Error>>` (the MemoryUsefulnessStore Result
 * posture). This file is type-only (mirrors user-representation-store.ts): no zod,
 * no @comis/memory import, no runtime value exports.
 */

/**
 * The lifecycle TIER (durable vs ephemeral) the DEFERRED promote/demote step would
 * assign a row. A closed string-literal union (mirror the `trustWeight` closed switch
 * in score.ts). Tier moves are not applied in this build (`promoted`/`demoted` stay 0
 * in {@link LifecycleSweepReport}); the type is retained for that deferred step.
 */
export type MemoryTier = "durable" | "ephemeral";

/**
 * The PER-CALL eviction-behavior override the daemon threads from each agent's
 * `learningForgetting` config (FORGET-06). The lifecycle store is constructed ONCE and
 * shared across agents, but the eviction policy is PER-AGENT — so the behavior gate rides
 * the sweep CALL (this override), not the constructor: agent A can sweep eviction-on while
 * agent B sweeps DORMANT on the same store. Omitted → the store's constructor policy (the
 * default DORMANT — byte-identity). Counts-only telemetry; carries no memory content.
 */
export interface MemoryLifecycleEvictionOverride {
  /** Activate LIVE soft eviction for THIS sweep (`learningForgetting.eviction.enabled ∧ .enabled`). */
  evictionEnabled?: boolean;
  /**
   * The corroborated-`failure_count` floor at/above which a NON-EXEMPT memory is
   * soft-evicted — the reachable wrongness-eviction path (FORGET-02, the
   * EVI-STRENGTH-FLOOR fix). Each `failure_count` increment is corroboration-gated;
   * the FORGET-03 exemptions (pinned / system / high-proof) still gate it, so an
   * induced-failure attacker cannot evict a well-corroborated memory. Omitted ⇒ the
   * store default.
   */
  failureEvictionFloor?: number;
}

/**
 * The isolation boundary for every lifecycle sweep. Every statement
 * in the sole adapter filters on `(tenantId, agentId)` — this is a load-bearing
 * SECURITY scope in a multi-agent DB, not a nicety: a sweep run under one
 * (tenant, agent) must NEVER touch (promote/demote/evict) another scope's rows.
 * Mirrors `TunedAlphaScope`.
 */
export interface MemoryLifecycleScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /**
   * Injected wall-clock epoch milliseconds — the `now` the sweep uses for its
   * event-age / dormancy bookkeeping (e.g. `nowMs − occurredAt > T_max`). NEVER
   * `Date.now()` — the caller supplies it from an injected clock so the sweep
   * stays deterministic/testable (globals.test.ts bans the wall-clock in src),
   * mirroring `TunedAlphaScope.now`.
   */
  now: number;
  /**
   * PER-CALL eviction-behavior override (FORGET-06). The daemon threads the per-agent
   * `learningForgetting` eviction policy here so the shared store evicts per-agent. When
   * present its fields take precedence over the store's constructor policy for THIS sweep;
   * when omitted the constructor policy applies (DORMANT by default — byte-identical).
   */
  policy?: MemoryLifecycleEvictionOverride;
}

/**
 * The counts-only summary of one lifecycle sweep. Ids/counts only —
 * NEVER memory bodies or query text (AGENTS.md §2.7). `evicted` is real under an
 * eviction-enabled policy (0 when DORMANT — the default); `promoted`/`demoted`
 * are still always 0 (tier moves are a deferred step); `scanned` reflects the
 * candidate rows the sweep considered. This shape is what the daemon cron
 * logs/emits as a single counts-only event.
 */
export interface LifecycleSweepReport {
  /** How many candidate rows the sweep scanned for this (tenant, agent). */
  scanned: number;
  /** How many rows were promoted to the durable tier. DORMANT scaffold → 0. */
  promoted: number;
  /** How many rows were demoted to the ephemeral tier. DORMANT scaffold → 0. */
  demoted: number;
  /** How many rows were (non-destructively) soft-evicted (`evicted_at` set). Real
   *  under an eviction-enabled policy; 0 when DORMANT (the default). */
  evicted: number;
}

export interface MemoryLifecyclePort {
  /**
   * MAINTENANCE PATH. Run one lifecycle sweep for the caller's
   * (tenant, agent) scope ONLY: scan the candidate rows and — in the LIVE policy —
   * soft-evict each NON-exempt candidate that is DORMANT past `maxDormantDays`
   * (disuse — days since last recall) OR corroborated-wrong (`failure_count >=
   * failureEvictionFloor`), NON-DESTRUCTIVELY via the `evicted_at` marker column.
   * Returns a counts-only {@link LifecycleSweepReport}. Called ONLY by the daemon's
   * default-OFF `__MEMORY_LIFECYCLE__` cron — never on the recall hot path.
   *
   * LIVE soft eviction is gated on an eviction-enabled policy
   * (`learningForgetting`): when ON, the two-disjunct candidacy (dormancy OR the
   * corroborated-failure floor), minus the FORGET-03 exemptions, is soft-evicted
   * (`evicted` is real); when OFF (the default) the sweep scans but applies NOTHING
   * (`evicted`/`demoted` 0 — byte-identity). Tier moves remain deferred
   * (`promoted`/`demoted` 0). With the cron knob off it is not even registered (a
   * default agent runs no sweep → byte-identical).
   *
   * NOTE: the SQLite adapter implements this; the daemon cron
   * wiring land in the implementation phases that follow.
   */
  runLifecycleSweep(scope: MemoryLifecycleScope): Promise<Result<LifecycleSweepReport, Error>>;

  /**
   * REVERSAL PATH (FORGET-04). Un-evict a previously soft-evicted memory on
   * renewed usefulness: clears its `evicted_at` marker (back to NULL) so the row
   * returns to recall. Soft eviction is reversible by design — the raw row was
   * never deleted, only marked. Scoped to the caller's `(tenant, agent)` ONLY:
   * an un-evict under one scope can NEVER clear another scope's marker (the same
   * load-bearing isolation boundary as the sweep). Idempotent — un-evicting a
   * live (or absent) row is a no-op `ok(...)`. Called by the daemon reward seam
   * when a previously-evicted memory becomes useful again (a later plan wires the
   * caller); the store exposes the capability here.
   */
  unevict(memoryId: string, scope: MemoryLifecycleScope): Promise<Result<void, Error>>;
}
