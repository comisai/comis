// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemoryEntry } from "../domain/memory-entry.js";
import type { MemoryRecallScope, MemoryWriteScope } from "../domain/memory-scope.js";

export type MemoryWriteEntry = Omit<MemoryEntry, "tenantId" | "agentId" | "userId" | "visibility">;

/**
 * Options for searching memory entries.
 */
export interface MemorySearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Minimum similarity threshold (0-1) for vector search */
  minScore?: number;
  /** Filter by trust level */
  trustLevel?: "system" | "learned" | "external";
  /** Filter by tags (entries must have ALL specified tags) */
  tags?: string[];
  /** Read-side NL temporal-range filter. Epoch ms; ANDed onto the ALREADY-scoped
   *  query (tenant_id = ? AND agent_id = ? AND occurred_at BETWEEN ? AND ?) — it can only
   *  NARROW, never widen scope. Absent → no range filter (recall unchanged). Both
   *  `search` and `searchLanes` carry MemorySearchOptions, so this threads to both with no
   *  signature change; the SQLite WHERE clause is added in hybrid-search.ts. */
  occurredAtRange?: { start: number; end: number };
}

/**
 * A search result with relevance score.
 */
export interface MemorySearchResult {
  entry: MemoryEntry;
  /** Similarity score (0-1), present when vector search is used */
  score?: number;
}

/**
 * MemoryPort: The hexagonal architecture boundary for persistent memory.
 *
 * Every memory backend (SQLite + sqlite-vec, PostgreSQL + pgvector, etc.)
 * must implement this interface. The port handles both exact retrieval
 * and semantic (vector) search.
 *
 * All operations are scoped to a tenant via SessionKey or explicit tenantId.
 * Trust levels are enforced at the port boundary to prevent memory poisoning.
 */
export interface MemoryPort {
  /**
   * Store a new memory entry.
   *
   * @param entry - The memory entry to persist (id must be set by caller)
   * @returns The stored entry, or an error
   */
  store(entry: MemoryWriteEntry, scope: MemoryWriteScope): Promise<Result<MemoryEntry, Error>>;

  /**
   * Search for memory entries using text/vector similarity.
   *
   * @param sessionKey - Session context to scope the search
   * @param query - Text query or embedding vector
   * @param options - Search filters and limits
   * @returns Array of matching entries with scores, or an error
   */
  search(
    scope: MemoryRecallScope,
    query: string | number[],
    options?: MemorySearchOptions,
  ): Promise<Result<MemorySearchResult[], Error>>;

  /**
   * OPTIONAL: search returning the FTS-ranked and vector-ranked
   * candidate lists SEPARATELY — the un-fused split.
   *
   * Where {@link search} fuses the FTS + vector lanes INTERNALLY (RRF, weights
   * 1.0/1.5) and returns ONE merged scored list, `searchLanes` returns the two
   * ranked lists UN-fused so a downstream layer (the agent's `fuse()`) can fuse
   * them with OPERATOR-TUNABLE per-lane weights and report TRUE per-lane
   * candidate counts. It is the SAME search over the SAME tenant-scoped rows,
   * just un-fused — NOT a new authority surface.
   *
   * Contract for an implementer:
   * - Over-fetch the SAME `limit * 2` per lane that the fused `search` path
   *   over-fetches, so the candidate pools entering fusion match the fused path.
   * - Return RAW hydrated lanes — do NOT apply `minScore` (that filter moves to
   *   the fusion/recall layer, applied AFTER fusion).
   * - Resolve the embedding exactly as `search` does; an absent/zero-length
   *   embedding (or no vector backend) yields an EMPTY `vector` lane.
   * - Each lane is ordered most-relevant-first (rank 1 = first).
   *
   * This method is OPTIONAL: an adapter MAY omit it. Callers that find it absent
   * MUST fall back to {@link search} (the single-lane path) — this is a
   * graceful-degrade, not a compatibility toggle.
   *
   * Lane isolation: a vector-lane failure (e.g. a vec-table/embedder drift)
   * MUST NOT fail the whole call — the implementer returns the FTS lane with an
   * empty `vector` lane plus `vectorLaneDegraded` naming the failure class, so
   * text recall survives a broken vector backend and the caller can surface the
   * degradation. Only a failure that breaks BOTH lanes returns `err`.
   *
   * @param sessionKey - Session context to scope the search (tenant isolation)
   * @param query - Text query or embedding vector
   * @param options - Search filters and limits (minScore is IGNORED here)
   * @returns The two ranked, hydrated candidate lists, or an error
   */
  searchLanes?(
    scope: MemoryRecallScope,
    query: string | number[],
    options?: MemorySearchOptions,
  ): Promise<
    Result<
      {
        fts: MemorySearchResult[];
        vector: MemorySearchResult[];
        /** Present when the vector lane failed and was degraded to empty
         *  (the FTS lane above is still authoritative). */
        vectorLaneDegraded?: { errorKind: string };
      },
      Error
    >
  >;

  /**
   * Delete a memory entry by its ID.
   *
   * @param id - The UUID of the entry to delete
   * @param scope - Required tenant-agent authority scope
   * @returns true if deleted, false if not found, or an error
   */
  delete(
    id: string,
    scope: { tenantId: string; agentId: string },
  ): Promise<Result<boolean, Error>>;

  /**
   * Delete all memory entries matching a session key
   * + tenant+agent scope. Covers BOTH paired-conversation memories and
   * LCD-distilled episodic memories (both store source_session_key on the
   * memories row). The ON DELETE CASCADE on lcd_memory_provenance.memory_id
   * handles provenance row cleanup automatically.
   *
   * Isolation-scoped: scope.tenantId + scope.agentId are REQUIRED — never
   * deletes cross-tenant or cross-agent rows. Returns count of deleted
   * memories rows, or an error.
   *
   * OPTIONAL: a MemoryPort implementation MAY omit this method.
   * The session-archive.ts handler gates on `deps.memoryPort.deleteBySessionKey`.
   */
  deleteBySessionKey?(
    sessionKey: string,
    scope: { tenantId: string; agentId: string },
  ): Promise<Result<number, Error>>;

  /**
   * List the memory ids for a (sessionKey, tenant,
   * agent) scope WITHOUT deleting them. Called by the
   * `session.reset_conversation --memory` handler BEFORE `deleteBySessionKey`
   * runs, so the captured ids can be passed to
   * `purgeConsolidatedDerivedFrom(..., thisSessionIds)` — making the
   * `--purge-derived` sweep match "observations derived from THIS session" rather
   * than the coarse "any observation with a dangling source id" (which would
   * over-delete unrelated observations that already had a prior dangling source).
   *
   * Isolation-scoped: filters on `source_session_key` AND `tenant_id` AND
   * `agent_id`, matching `deleteBySessionKey`'s scope exactly. Returns the ids
   * (possibly empty), or an error.
   *
   * OPTIONAL: the handler gates on `deps.memoryPort.listMemoryIdsBySessionKey`;
   * when absent, the purge falls back to its coarse session-agnostic behavior.
   */
  listMemoryIdsBySessionKey?(
    sessionKey: string,
    scope: { tenantId: string; agentId: string },
  ): Promise<Result<string[], Error>>;
}
