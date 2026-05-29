// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemoryEntry } from "../domain/memory-entry.js";

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
 * Create-only this phase (§Open Q6): the surface is exactly three methods — list
 * candidates, list existing observations, apply one consolidation. There is NO
 * update/fold-into-existing method — that is deferred.
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
}
