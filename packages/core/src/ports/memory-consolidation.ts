// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemoryEntry } from "../domain/memory-entry.js";

/**
 * MemoryConsolidationStore: the SEGREGATED maintenance boundary for the LIVE
 * read + deletion-reconciliation surface over consolidated observation rows
 * (`proof_count IS NOT NULL` is the column flag marking a consolidated row).
 *
 * The port is deliberately limited to this read/maintenance surface — there is
 * no consolidation-writer surface (no clustering of raw memories into
 * observations). Its three methods each have a live consumer that must keep
 * working:
 *   - `listObservations`             — the `comis memory` observation listing
 *                                      (daemon `memory.observations` handler).
 *   - `unlinkDeletedSources`         — deletion reconciliation after
 *   - `purgeConsolidatedDerivedFrom`   `session.reset_conversation --memory`.
 *
 * This is a SEPARATE port — it deliberately does NOT widen the security-reviewed
 * agent-facing `MemoryPort` (store/search/delete). That surface
 * is never widened for agent use; new maintenance capabilities arrive as their
 * own segregated port (the same pattern as `MemoryEntityStore`, guarding
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
   * Unlink the given session's memory ids from all
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
   * Scoped on `tenant_id` AND `agent_id` — matching
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
   * Nuclear escalation — delete EVERY consolidated
   * observation derived from THIS session's deleted memory ids. Use ONLY when
   * `--purge-derived` is explicitly requested — it is destructive (an observation
   * corroborated by OTHER sessions is STILL deleted when it also cites a
   * this-session source) and cannot be undone.
   *
   * Session-scoped, not coarse: the predicate is
   * `source_ids ∩ thisSessionIds ≠ ∅` — an observation is purged ONLY if it
   * references one of THIS session's memory ids (captured BEFORE the delete via
   * `MemoryPort.listMemoryIdsBySessionKey`). An UNRELATED observation that merely
   * has a PRIOR dangling source id (from an earlier admin delete / TTL / another
   * session's purge) is NOT touched. When `thisSessionIds` is empty, nothing is
   * purged.
   *
   * Scoped on `tenant_id` AND `agent_id` — a cross-tenant or
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
