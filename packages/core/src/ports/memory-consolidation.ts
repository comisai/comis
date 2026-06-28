// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemoryEntry } from "../domain/memory-entry.js";

/**
 * MemoryConsolidationStore: the SEGREGATED maintenance boundary for the LIVE
 * read + deletion-reconciliation surface over consolidated observation rows
 * (`proof_count IS NOT NULL`, the column-flag model §4.1).
 *
 * Phase 226 (SIMPLIFY-02): TRIMMED to its live surface. The consolidation CRON
 * (the WRITER — clustering raw memories into observations) was retired in phase
 * 225, so its writer methods (`listConsolidationCandidates` / `applyConsolidation`
 * / `foldIntoExisting` / `knnDistances` surprisal-gate / `markReasoned`
 * deductive-drain) + their candidate/plan input types are gone (grep-proven: 0
 * live, non-cron callers). What REMAINS are three methods with live, non-cron
 * consumers that must keep working:
 *   - `listObservations`             — the `comis memory` observation listing
 *                                      (daemon `memory.observations` handler).
 *   - `unlinkDeletedSources`         — DIST-05 deletion reconciliation after
 *   - `purgeConsolidatedDerivedFrom`   `session.reset_conversation --memory`.
 *
 * This is a NEW port — it deliberately does NOT widen the security-reviewed
 * agent-facing `MemoryPort` (store/search/delete). Per design §3.2 that surface
 * is never widened for agent use; new maintenance capabilities arrive as their
 * own segregated port (the same pattern as `MemoryEntityStore` §6.5, guarding
 * against Elevation of Privilege). The sole adapter lives in the memory package
 * (it owns the `db` handle and runs all SQL); the daemon injects the concrete
 * adapter; consumers import this port TYPE only (the agent↛memory build cut).
 *
 * This file is type-only (mirrors the entity-store port): no zod, no
 * cross-package runtime import.
 */

export interface MemoryConsolidationStore {
  /**
   * Existing observations (proof_count IS NOT NULL) in scope, scoped to
   * (tenantId, agentId), capped at `limit`. The LIVE read behind the
   * `comis memory` observation listing (the daemon `memory.observations`
   * handler surfaces a truncated provenance preview to an operator/agent).
   */
  listObservations(
    agentId: string,
    tenantId: string,
    limit: number,
  ): Promise<Result<MemoryEntry[], Error>>;

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
