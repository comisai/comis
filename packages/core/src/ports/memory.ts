// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemoryEntry } from "../domain/memory-entry.js";
import type { SessionKey } from "../domain/session-key.js";

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
  /** Filter by agent ID (when provided, only return memories created by this agent) */
  agentId?: string;
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
  store(entry: MemoryEntry): Promise<Result<MemoryEntry, Error>>;

  /**
   * Search for memory entries using text/vector similarity.
   *
   * @param sessionKey - Session context to scope the search
   * @param query - Text query or embedding vector
   * @param options - Search filters and limits
   * @returns Array of matching entries with scores, or an error
   */
  search(
    sessionKey: SessionKey,
    query: string | number[],
    options?: MemorySearchOptions,
  ): Promise<Result<MemorySearchResult[], Error>>;

  /**
   * Delete a memory entry by its ID.
   *
   * @param id - The UUID of the entry to delete
   * @param tenantId - Tenant scope (defaults to "default")
   * @returns true if deleted, false if not found, or an error
   */
  delete(id: string, tenantId?: string): Promise<Result<boolean, Error>>;
}
