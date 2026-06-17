// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * MemoryLifecyclePort: the SEGREGATED hexagonal boundary for the per-(tenant,
 * agent) memory LIFECYCLE sweep (Track C). A periodic,
 * KEYLESS maintenance pass that computes each memory's importance-decayed
 * strength + its hysteresis-banded tier and (in the LIVE policy) promotes,
 * demotes, or evicts rows accordingly.
 *
 * This is a NEW port — like TunedAlphaStore / MemoryUsefulnessStore /
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
 * SCAFFOLD per gap-report OD4 — the sweep computes strengths/tiers but
 * its demote/evict step performs NOTHING (`promoted`/`demoted`/`evicted` stay 0)
 * until an operator enables it; live eviction is the deferred operator step.
 * The default-OFF `MemoryLifecycleConfigSchema` knob is a behavior gate, NOT a
 * back-compat fallback (mirror the schema-memory-online-tuning framing); even when
 * the cron is enabled the DORMANT adapter evicts/demotes nothing. The
 * eviction policy is NON-DESTRUCTIVE by design (a marker column — mirror
 * `consolidated_at` — never a hard DELETE of the raw row).
 *
 * The method returns `Promise<Result<…, Error>>` (the TunedAlphaStore Result
 * posture). This file is type-only (mirrors tuned-alpha-store.ts /
 * user-representation-store.ts): no zod, no @comis/memory import, no runtime value
 * exports.
 */

/**
 * The lifecycle TIER (FadeMem Eq.6 / hysteresis bands). A closed string-literal
 * union (mirror the `trustWeight` closed switch in score.ts) — the tier selects
 * the per-type decay shape β (durable → slow-tail 0.8 / ephemeral → sharp-drop
 * 1.2). The hysteresis dead-band (θ_promote 0.7 > θ_demote 0.3) is what moves a
 * row between these two tiers without flapping; the bands themselves live on
 * `MemoryLifecycleConfigSchema` as the dormant policy constants.
 */
export type MemoryTier = "durable" | "ephemeral";

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
}

/**
 * The counts-only summary of one lifecycle sweep. Ids/counts only —
 * NEVER memory bodies or query text (AGENTS.md §2.7). For the SCAFFOLD-DORMANT
 * adapter `promoted`/`demoted`/`evicted` are always 0 (the demote/evict
 * step is the deferred live policy); `scanned` reflects the candidate rows the
 * sweep considered. This shape is what the daemon cron logs/emits as a single
 * counts-only event.
 */
export interface LifecycleSweepReport {
  /** How many candidate rows the sweep scanned for this (tenant, agent). */
  scanned: number;
  /** How many rows were promoted to the durable tier. DORMANT scaffold → 0. */
  promoted: number;
  /** How many rows were demoted to the ephemeral tier. DORMANT scaffold → 0. */
  demoted: number;
  /** How many rows were (non-destructively) evicted/marked. DORMANT scaffold → 0. */
  evicted: number;
}

export interface MemoryLifecyclePort {
  /**
   * MAINTENANCE PATH. Run one lifecycle sweep for the caller's
   * (tenant, agent) scope ONLY: scan the candidate rows, compute each one's
   * importance-decayed strength + its hysteresis-banded tier (θ_promote 0.7 >
   * θ_demote 0.3 dead-band; the bands + capacity caps + dormancy come from
   * `MemoryLifecycleConfigSchema`), and — in the LIVE policy — promote/demote/
   * evict accordingly (lowest-strength-first, usefulness-feedback-aware,
   * NON-DESTRUCTIVE via a marker column). Returns a counts-only
   * {@link LifecycleSweepReport}. Called ONLY by the daemon's default-OFF
   * `__MEMORY_LIFECYCLE__` cron — never on the recall hot path.
   *
   * SCAFFOLD-DORMANT (OD4): the sole adapter computes strengths/tiers but
   * its demote/evict step performs NOTHING — `promoted`/`demoted`/`evicted` are 0;
   * live eviction is the deferred operator step. With the knob off the cron
   * is not even registered (a default agent runs no sweep → byte-identical).
   *
   * NOTE: this is the type contract only. The SQLite adapter and the daemon cron
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
