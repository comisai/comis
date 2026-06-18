// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * TunedAlphaStore: the SEGREGATED hexagonal boundary for the per-(tenant, agent)
 * LEARNED ranking weights. A tuned row is a
 * 4-tuple of the recency/temporal/proof/usefulness boost alphas, updated OFFLINE
 * by the LLM-free deterministic bandit from the accrued feedback signal and
 * read DETERMINISTICALLY at the recall apply site to overlay the static
 * `rag.scoring` config alphas.
 *
 * This is a NEW port — like MemoryUsefulnessStore / UserRepresentationStore /
 * TripleStorePort it deliberately does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). New capabilities arrive as their own
 * segregated port. The sole adapter is in @comis/memory (it owns the `db` handle
 * and runs all SQL over the additive `tuned_alpha` table, keyed
 * `(tenant_id, agent_id)`); the agent-side apply path (the deterministic
 * overlay) and the offline update job consume this port TYPE from @comis/core —
 * they cannot import @comis/memory (the agent↛memory build cut). No new authority
 * is granted beyond a scoped write/read within the caller's own (tenant, agent).
 *
 * It carries the WRITE (`upsert`) and the scoped READ (`read`) — the dual
 * write+read shape of UserRepresentationStore / MemoryCausalStore (NOT a split
 * read/write port).
 *
 * This file is type-only (mirrors user-representation-store.ts /
 * memory-usefulness-store.ts): no zod, no @comis/memory import, no runtime value
 * exports.
 */

/**
 * The 4 TUNABLE alphas. The FIFTH `ScoringAlphas` boost weight (the
 * trust-level weight) is STRUCTURALLY ABSENT here — trust is frozen under tuning
 * (the ship-gate); it is sourced ONLY from static config at the
 * apply site (buildScoringAlphas). The store table likewise has no fifth
 * (trust-weight) column. This 4-tuple is NON-NEGOTIABLE (out of scope: a bandit
 * that can move the trust weight): a bandit must never
 * be able to move the trust weight, so it cannot even be NAMED on the type the
 * bandit reads and writes — its literal field name is therefore deliberately
 * never written in this file (the grep-0 trust-freeze belt, asserted in
 * tuned-alpha-store.test.ts). Each alpha is a multiplicative boost weight clamped
 * to `[0, 1]` (matching the min(0)/max(1) config bound the Zod schema already
 * enforces on every `rag.scoring` alpha) by the pure `computeTunedAlphas` step.
 */
export interface TunedAlphaVector {
  /** Recency boost weight (live via createdAt) — tunable. */
  recencyAlpha: number;
  /** Event-time proximity boost weight — tunable. */
  temporalAlpha: number;
  /** Proof boost weight — tunable. */
  proofAlpha: number;
  /** Usefulness boost weight (bounded used-rate) — tunable. */
  usefulnessAlpha: number;
}

/**
 * The isolation boundary for every tuned-alpha operation. Every
 * statement in the sole adapter filters on `(tenantId, agentId)` and the table
 * PRIMARY KEY keys on `(tenant_id, agent_id)` — this is a load-bearing SECURITY
 * scope in a multi-agent DB, not a nicety: a tuned vector written under one
 * (tenant, agent) must NEVER be returned for another scope.
 */
export interface TunedAlphaScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /**
   * Injected wall-clock epoch milliseconds for the write's `updated_at`
   * bookkeeping. NEVER `Date.now()` — the caller supplies it from an injected
   * clock so the write path stays deterministic/testable (globals.test.ts bans
   * the wall-clock in src). The READ does not need it (mirror
   * UserRepresentationStore.read's `Omit<…, "now">`).
   */
  now: number;
  /**
   * Optional query-INTENT bucket (RANK-02). When present, the read fetches /
   * the write records the per-intent tuned vector (the learned ranking weights
   * FOR THAT intent); when OMITTED the adapter resolves the GLOBAL bucket
   * (intent="") — byte-identical to the prior behaviour. The closed-union value
   * comes from the agent's deterministic `classifyIntent` (LLM-free); typed here
   * as a plain string so @comis/core takes no @comis/agent dependency. NOT a
   * security boundary — (tenantId, agentId) remain the isolation scope; intent is
   * an ADDITIONAL key, never a relaxation. Because `read` takes
   * `Omit<TunedAlphaScope, "now">`, this optional field flows to BOTH the write
   * AND the read automatically.
   */
  intent?: string;
}

export interface TunedAlphaStore {
  /**
   * WRITE PATH. Upsert the tuned alpha vector for the caller's
   * (tenant, agent) scope. The adapter binds every value as a `?` parameter and
   * is idempotent (INSERT ... ON CONFLICT DO UPDATE — one row per scope); the
   * `updated_at` timestamp comes from `scope.now`. Called ONLY by the offline
   * update job (the bandit) — never on the recall hot path.
   *
   * NOTE: this is the type contract only. The SQLite adapter and the offline
   * bandit job that produces vectors land in later cuts.
   */
  upsert(vector: TunedAlphaVector, scope: TunedAlphaScope): Promise<Result<void, Error>>;

  /**
   * READ PATH. The deterministic apply-site read: the tuned alpha
   * vector for the caller's (tenant, agent) scope ONLY. Takes
   * `Omit<TunedAlphaScope, "now">` — no clock is needed to read (mirror
   * UserRepresentationStore.read). Returns `undefined` when no tuned row exists
   * for `(tenant, agent)` — the apply site then falls back to the static config
   * alphas (the default-OFF byte-identity no-op). This is the
   * deterministic, LLM-free read the overlay consumes — the recall
   * hot path stays deterministic + LLM-free (the milestone's #1 binding
   * constraint).
   *
   * NOTE: this is the type contract only; the scoped SELECT is
   * implemented in a later cut.
   */
  read(scope: Omit<TunedAlphaScope, "now">): Promise<Result<TunedAlphaVector | undefined, Error>>;
}
