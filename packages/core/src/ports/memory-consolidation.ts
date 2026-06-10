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
 * own segregated port (the same pattern as `MemoryEntityStore` §6.5, guarding
 * against Elevation of Privilege). The sole adapter lives in the memory
 * package (it owns the `db` handle and runs all SQL); the consolidation job
 * consumes this port TYPE from core — it cannot import the memory package (the
 * agent↛memory build cut); the daemon injects the concrete adapter.
 *
 * The surface is four methods — list candidates, list existing observations,
 * apply one (create) consolidation, AND fold new corroborating sources into an
 * EXISTING observation. The fold path grows
 * `proof_count`/`source_ids`/`history` + refreshes confidence/occurred_at on a
 * row that already exists instead of creating a second observation — the
 * proof-accrual axis the earlier create-only path lacked.
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
 * The atomic unit applied by {@link MemoryConsolidationStore.applyConsolidation}.
 * Either the observation is created AND its sources are marked
 * `consolidated_at`, or NOTHING is — one `db.transaction` (auto-rollback on
 * throw).
 */
export interface ConsolidationPlan {
  /** The new observation MemoryEntry (proofCount/sourceIds/confidence already set by the job). */
  observation: MemoryEntry;
  /** Source memory ids to mark `consolidated_at` (non-destructive — never deleted). */
  markConsolidated: string[];
  /** Isolation scope for the source-mark UPDATE (the V4 access-control boundary). */
  tenantId: string;
  /** Injected-clock epoch ms written to `consolidated_at` (NEVER Date.now). */
  now: number;
}

/**
 * The atomic unit applied by {@link MemoryConsolidationStore.foldIntoExisting}.
 * Grows an EXISTING observation (`proof_count IS NOT NULL`) with
 * new corroborating sources instead of creating a second one. Either the
 * observation grow AND every source-mark commit together, or NOTHING does — one
 * `db.transaction` (auto-rollback on throw).
 *
 * Three invariants the adapter enforces from these fields:
 *   - **Idempotency:** `proof_count` is recomputed as the CARDINALITY
 *     of `UNION(existing.source_ids, newSourceIds)` — a set recompute, NEVER a
 *     blind `+=`. Re-folding the same (already-present) sources is a no-op.
 *   - **Trust ceiling (anti-laundering):** `trustLevel` is written
 *     VERBATIM. The job computes `min(existing.trust, minTrust(newSources))`
 *     upstream so a fold can only LOWER trust, never raise it; the adapter has
 *     no path to raise it.
 *   - **Half-life refresh:** `confidence` + `occurredAt` are refreshed
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
   * can only LOWER trust, never raise it (anti-laundering).
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
   * (consolidated_at IS NULL — a STATE predicate, NOT a time cursor),
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
   * deterministic dedup pre-check so a re-run does not create a
   * duplicate observation. Capped at `limit`.
   */
  listObservations(
    agentId: string,
    tenantId: string,
    limit: number,
  ): Promise<Result<MemoryEntry[], Error>>;

  /**
   * Apply ONE consolidation atomically: create the observation AND
   * mark its sources `consolidated_at`, both in a single `db.transaction`
   * (auto-rollback on throw — no orphan observation, no lost sources). Returns
   * the stored observation.
   */
  applyConsolidation(plan: ConsolidationPlan): Promise<Result<MemoryEntry, Error>>;

  /**
   * Grow an EXISTING observation atomically instead of creating a
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

  /**
   * READ (the surprisal-gate engine). The k nearest-neighbour cosine
   * DISTANCES for one embedding. Backed by the shipped sqlite-vec searchByVector
   * (hybrid-search.ts). Returns the distances sorted ASCENDING (closer first);
   * `ok([])` when sqlite-vec is unavailable (graceful degrade — the caller's
   * missing-embedding policy then applies).
   *
   * ## Surprisal novelty is CORPUS-RELATIVE by design
   * The `agentId`/`tenantId` parameters are RESERVED — they are NOT currently
   * applied. The shipped `vec_memories` vec0 table is GLOBAL (no tenant/agent
   * column), so this read ranks the embedding against the ENTIRE multi-tenant
   * corpus, and a cross-tenant near-duplicate intentionally INFLUENCES this
   * candidate's surprisal ranking. This is the sanctioned design (risk-accepted):
   * the threat model is distances-only
   * — ONLY scalar float distances are read, NEVER ids or content, so no other
   * scope's memory body crosses the boundary; it is a side-channel on the
   * per-agent SELECTION decision, never an exfiltration. A future filtered-vec
   * variant (V4 access control) can JOIN `memories` and apply the carried
   * `(agentId, tenantId)` to make the read scope-isolated — the parameters are
   * threaded now so that change needs no signature break. Do NOT assume the
   * isolation the signature might imply: it is corpus-wide today.
   */
  knnDistances(
    embedding: number[],
    k: number,
    agentId: string,
    tenantId: string,
  ): Promise<Result<number[], Error>>;

  /**
   * Mark source memories `consolidated_at` WITHOUT creating an observation
   * (the deductive-only drain). `applyConsolidation` marks sources
   * only as a side effect of creating an inductive observation row; a scope that
   * yields ONLY a deductive triple (no inductive pattern) has no observation to
   * create, yet its sources must still leave the candidate pool — otherwise the
   * `consolidated_at IS NULL AND proof_count IS NULL` candidate predicate
   * re-selects them and re-feeds the paid reasoning seam over unchanged evidence
   * on every run. This is the no-observation counterpart of `applyConsolidation`'s
   * source-mark step: NON-DESTRUCTIVE (sets `consolidated_at` only, never deletes),
   * scoped to `tenantId` (a cross-tenant id is a fail-closed no-op), parameterized,
   * and idempotent (re-marking an already-marked source is a harmless re-write).
   * Returns the number of source rows actually marked.
   */
  markReasoned(
    sourceIds: string[],
    tenantId: string,
    now: number,
  ): Promise<Result<number, Error>>;

  /**
   * Phase 172 (DIST-05): Unlink the given session's memory ids from all
   * consolidated observations after those source memories were deleted by
   * `session.reset_conversation --memory`.
   *
   * For each observation (`proof_count IS NOT NULL`) in scope whose `source_ids`
   * JSON array contains any memory id from the given session: remove those ids.
   * If `source_ids` becomes empty (the observation was derived ONLY from this
   * session — an orphan) → DELETE the observation. A multi-source observation
   * (still has surviving source ids from other sessions) → KEEP it with the
   * reduced `source_ids` (unlink-only — never over-delete).
   *
   * NOTE: this is the cleanup AFTER the source rows are already gone, so it
   * re-derives the deleted session's memory ids from the
   * `lcd_memory_provenance.source_session_key` rows (which survive via
   * ON DELETE CASCADE only when the memory row is dropped — so by the time this
   * runs the provenance rows are gone too). It therefore matches by re-scanning
   * the surviving `source_ids` against the still-present memory rows: any
   * source id no longer present in `memories` for this tenant is treated as
   * deleted. See the adapter for the exact predicate.
   *
   * R4 (WR-05): scoped on `tenant_id` AND `agent_id` — matching
   * `deleteBySessionKey`'s (tenant, agent) scope exactly. A cross-tenant OR
   * cross-agent observation is a fail-closed no-op (never touched). Returns the
   * count of orphan observations deleted.
   *
   * @param sessionKey - The session key whose memories were deleted (source_session_key match)
   * @param tenantId - Tenant scope (never crosses tenants)
   * @param agentId - Agent scope (never crosses agents) — matches the delete scope
   * @returns Count of orphan observations deleted, or an error
   */
  unlinkDeletedSources(
    sessionKey: string,
    tenantId: string,
    agentId: string,
  ): Promise<Result<number, Error>>;

  /**
   * Phase 172 (DIST-05): Nuclear escalation — delete EVERY consolidated
   * observation derived from THIS session's deleted memory ids. Use ONLY when
   * `--purge-derived` is explicitly requested — it is destructive (an observation
   * corroborated by OTHER sessions is STILL deleted when it also cites a
   * this-session source) and cannot be undone.
   *
   * WR-02 (session-scoped, not coarse): the predicate is
   * `source_ids ∩ thisSessionIds ≠ ∅` — an observation is purged ONLY if it
   * references one of THIS session's memory ids (captured BEFORE the delete via
   * `MemoryPort.listMemoryIdsBySessionKey`). An UNRELATED observation that merely
   * has a PRIOR dangling source id (from an earlier admin delete / TTL / another
   * session's purge) is NOT touched. When `thisSessionIds` is empty, nothing is
   * purged.
   *
   * R4 (WR-05): scoped on `tenant_id` AND `agent_id` — a cross-tenant or
   * cross-agent observation is a fail-closed no-op. Returns the count purged.
   *
   * @param sessionKey - The session key to purge derived observations for (audit)
   * @param tenantId - Tenant scope (never crosses tenants)
   * @param agentId - Agent scope (never crosses agents) — matches the delete scope
   * @param thisSessionIds - The memory ids deleted for THIS session (the purge oracle)
   * @returns Count of observations deleted, or an error
   */
  purgeConsolidatedDerivedFrom(
    sessionKey: string,
    tenantId: string,
    agentId: string,
    thisSessionIds: string[],
  ): Promise<Result<number, Error>>;
}
