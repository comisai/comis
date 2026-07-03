// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemorySearchResult } from "./memory.js";

/**
 * MemoryPinnedStore: the SEGREGATED hexagonal boundary for pinned-memory recall.
 *
 * This is a deliberately separate port — it does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). That surface is never
 * widened for agent use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryEntityStore`). The sole adapter is in
 * @comis/memory (it owns the `db` handle and runs all SQL); the agent-side
 * read path (memory-recall) consumes this port TYPE from @comis/core — it
 * cannot import @comis/memory (the agent↛memory build cut). No new authority
 * is granted beyond pin/unpin/listPinned within the caller's own (tenant, agent) scope.
 *
 * This file is type-only (mirrors memory-entity-store.ts): no zod, no @comis/memory import.
 */

export interface MemoryPinnedStore {
  /**
   * Mark a memory entry as pinned (always-inject in recall).
   * Idempotent: pin an already-pinned entry is a no-op.
   * Returns true if the row exists (and was pinned or was already pinned),
   * false if the id is not found in the scope.
   * `agentId` further scopes the UPDATE so cross-agent pinning within a tenant is impossible.
   */
  pin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>>;

  /**
   * Unpin a memory entry. Idempotent: unpin of an unpinned entry is a no-op.
   * Returns true if the row exists, false if not found in the scope.
   * `agentId` further scopes the UPDATE so cross-agent unpinning within a tenant is impossible.
   */
  unpin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>>;

  /**
   * List all pinned memory entries for a scope, ordered by created_at DESC,
   * bounded by `limit`. Used exclusively by the recall pipeline's pinned-first
   * lane. Returns an empty array (not an error) when no entries are pinned.
   */
  listPinned(
    scope: { tenantId: string; agentId: string },
    limit: number,
  ): Promise<Result<MemorySearchResult[], Error>>;
}
