// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemoryEntry, TrustLevel } from "../domain/memory-entry.js";

/**
 * MemoryConsolidationStore: the SEGREGATED maintenance boundary for memory
 * consolidation (design §6.5) — clustering repeated/near-duplicate raw memories
 * into a single observation row (`proof_count IS NOT NULL`, the column-flag
 * model §4.1) and marking their sources `consolidated_at`.
 *
 * This is a NEW port — it deliberately does NOT widen the security-reviewed
 * agent-facing `MemoryPort` (store/search/delete). Per design §3.2 that surface
 * is never widened for agent use; new maintenance capabilities arrive as their
 * own segregated port (the same pattern as `MemoryEntityStore` §6.5, threat
 * T-84-03 — Elevation of Privilege). The sole adapter lives in the memory
 * package (it owns the `db` handle and runs all SQL); the consolidation job
 * consumes this port TYPE from core — it cannot import the memory package (the
 * agent↛memory build cut); the daemon injects the concrete adapter.
 *
 * The surface is four methods — list candidates, list existing observations,
 * apply one (create) consolidation, AND fold new corroborating sources into an
 * EXISTING observation (Phase 94, FOLD-01/02). The fold path grows
 * `proof_count`/`source_ids`/`history` + refreshes confidence/occurred_at on a
 * row that already exists instead of creating a second observation — the
 * proof-accrual axis Phase-84's create-only path lacked.
 *
 * This file is type-only (mirrors the entity-store port): no zod, no
 * cross-package runtime import.
 */

/**
 * A consolidation candidate: a raw {@link MemoryEntry} hydrated with its
 * embedding (the adapter LEFT JOINs vec_memories) so the agent-side clusterer
 * can compute cosine proximity. Raw reads do NOT populate embeddings (RESEARCH
 * Pitfall 7), hence the explicit hydration; `embedding` is absent when
 * sqlite-vec is unavailable (the clusterer then degrades to entity/FTS overlap).
 */
export interface ConsolidationCandidate {
  /** The raw memory (proof_count IS NULL, consolidated_at IS NULL). */
  entry: MemoryEntry;
  /** Hydrated embedding vector; absent when sqlite-vec is unavailable. */
  embedding?: number[];
}

/**
 * The atomic unit applied by {@link MemoryConsolidationStore.applyConsolidation}
 * (CONS-03). Either the observation is created AND its sources are marked
 * `consolidated_at`, or NOTHING is — one `db.transaction` (auto-rollback on
 * throw).
 */
export interface ConsolidationPlan {
  /** The new observation MemoryEntry (proofCount/sourceIds/confidence already set by the job). */
  observation: MemoryEntry;
  /** Source memory ids to mark `consolidated_at` (non-destructive — never deleted, CONS-05). */
  markConsolidated: string[];
  /** Isolation scope for the source-mark UPDATE (the V4 access-control boundary). */
  tenantId: string;
  /** Injected-clock epoch ms written to `consolidated_at` (NEVER Date.now). */
  now: number;
}

/**
 * The atomic unit applied by {@link MemoryConsolidationStore.foldIntoExisting}
 * (FOLD-01/02). Grows an EXISTING observation (`proof_count IS NOT NULL`) with
 * new corroborating sources instead of creating a second one. Either the
 * observation grow AND every source-mark commit together, or NOTHING does — one
 * `db.transaction` (auto-rollback on throw).
 *
 * Three invariants the adapter enforces from these fields:
 *   - **Idempotency (FOLD-02):** `proof_count` is recomputed as the CARDINALITY
 *     of `UNION(existing.source_ids, newSourceIds)` — a set recompute, NEVER a
 *     blind `+=`. Re-folding the same (already-present) sources is a no-op.
 *   - **Trust ceiling (FOLD-02, anti-laundering):** `trustLevel` is written
 *     VERBATIM. The job computes `min(existing.trust, minTrust(newSources))`
 *     upstream so a fold can only LOWER trust, never raise it; the adapter has
 *     no path to raise it.
 *   - **Half-life refresh (FOLD-02):** `confidence` + `occurredAt` are refreshed
 *     so the live half-life decay clock resets — accrued proof stays meaningful
 *     in ranking instead of decaying to neutral.
 */
export interface ConsolidationFoldPlan {
  /** The id of the EXISTING observation row to grow (proof_count IS NOT NULL). */
  targetObservationId: string;
  /** New corroborating source ids to UNION into the observation's source_ids. */
  newSourceIds: string[];
  /**
   * Trust ceiling for the GROWN observation = min(existing.trust,
   * minTrust(newSources)), computed in CODE by the job, written verbatim. A fold
   * can only LOWER trust, never raise it (anti-laundering, T-94-01).
   */
  trustLevel: TrustLevel;
  /** Refreshed confidence 0..1 (the job recomputes; default 1 on fold). */
  confidence: number;
  /** Refreshed event time (epoch ms) = max(existing.occurredAt, max(newSources.occurredAt)). */
  occurredAt: number;
  /** Optional new merged content (when the fold re-summarizes); omit to keep existing content (no FTS churn). */
  content?: string;
  /** Isolation scope for every UPDATE (the V4 access-control boundary). */
  tenantId: string;
  /** Injected-clock epoch ms (consolidated_at on sources + history.changedAt). NEVER Date.now. */
  now: number;
}

export interface MemoryConsolidationStore {
  /**
   * Candidates = raw memories (proof_count IS NULL) NOT yet consolidated
   * (consolidated_at IS NULL — a STATE predicate, NOT a time cursor; CONS-04),
   * scoped to (tenantId, agentId), oldest-first, capped at `limit`, with
   * embeddings hydrated for clustering.
   */
  listConsolidationCandidates(
    agentId: string,
    tenantId: string,
    limit: number,
  ): Promise<Result<ConsolidationCandidate[], Error>>;

  /**
   * Existing observations (proof_count IS NOT NULL) in scope — used by the
   * deterministic dedup pre-check (CONS-04) so a re-run does not create a
   * duplicate observation. Capped at `limit`.
   */
  listObservations(
    agentId: string,
    tenantId: string,
    limit: number,
  ): Promise<Result<MemoryEntry[], Error>>;

  /**
   * Apply ONE consolidation atomically (CONS-03): create the observation AND
   * mark its sources `consolidated_at`, both in a single `db.transaction`
   * (auto-rollback on throw — no orphan observation, no lost sources). Returns
   * the stored observation.
   */
  applyConsolidation(plan: ConsolidationPlan): Promise<Result<MemoryEntry, Error>>;

  /**
   * Grow an EXISTING observation atomically (FOLD-01/02) instead of creating a
   * second one: recompute `proof_count` as the CARDINALITY of the UNIONed
   * source-id set (the idempotency key — NOT a blind `+=`), UNION `source_ids`,
   * append a `history` entry (only when content changes), carry the trust
   * ceiling forward (writes `plan.trustLevel` VERBATIM — a fold can only LOWER
   * trust), refresh `confidence` + `occurred_at` (the half-life clock reset),
   * AND mark the new sources `consolidated_at`, all in ONE `db.transaction`
   * (auto-rollback on throw — no torn observation, no orphan mark). Every query
   * is tenant-scoped; a cross-tenant/missing target is a fail-closed `err`.
   * Returns the grown observation.
   */
  foldIntoExisting(plan: ConsolidationFoldPlan): Promise<Result<MemoryEntry, Error>>;
}
