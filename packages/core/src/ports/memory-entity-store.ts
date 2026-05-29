// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemorySearchResult } from "./memory.js";

/**
 * MemoryEntityStore: the SEGREGATED hexagonal boundary for entity-associative
 * recall (the people/things/topics memories mention, and the one-hop lane that
 * surfaces memories sharing them).
 *
 * This is a NEW port — it deliberately does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). Per design §3.2 that surface is never
 * widened for agent use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryConsolidationStore` §6.5). The sole adapter is in
 * @comis/memory (it owns the `db` handle and runs all SQL); the agent-side
 * write path (memory-review-job) and read path (memory-recall) consume this
 * port TYPE from @comis/core — they cannot import @comis/memory (the
 * agent↛memory build cut). No new authority is granted beyond resolve/link/
 * associate within the caller's own (tenant, agent) scope.
 *
 * This file is type-only (mirrors reranker.ts): no zod, no @comis/memory import.
 */

/**
 * The isolation boundary for every entity operation (ENT-03). Both the resolver
 * UNIQUE index and the lane self-join key on `(tenantId, agentId)` — this is a
 * load-bearing SECURITY scope in a multi-agent DB, not a nicety: two agents (or
 * tenants) must NEVER collapse to one entity row or surface each other's
 * memories even when an entity name is identical.
 */
export interface EntityScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /**
   * Injected wall-clock epoch milliseconds for `first_seen` / `last_seen`
   * bookkeeping. NEVER `Date.now()` — the caller supplies it from an injected
   * clock so the write path stays deterministic/testable.
   */
  now: number;
}

export interface MemoryEntityStore {
  /**
   * WRITE PATH (IN-01). Resolve `name` to an entity scoped to (tenant, agent)
   * — exact `canonical_key` reuse first, else a fuzzy match >= 0.6, else create
   * a new entity — bump its `mention_count` / `last_seen`, and link
   * `memoryId` <-> the resolved entity id (idempotent). Returns the resolved
   * entity id.
   */
  resolveAndLink(memoryId: string, name: string, scope: EntityScope): Promise<Result<string, Error>>;

  /**
   * READ PATH (ENT-02). Given seed memory ids, return OTHER memories — scoped to
   * (tenant, agent), the seeds themselves excluded — that share >= 1 entity,
   * HYDRATED as `MemorySearchResult[]` ordered most-shared-first (OQ-1).
   * Returns an empty array when there are no seeds or no shared entities
   * (ENT-04 — the entity lane is then empty and RRF ranking is unchanged).
   * `cap` bounds the returned row count.
   */
  associativeLane(
    seedIds: string[],
    scope: Omit<EntityScope, "now">,
    cap: number,
  ): Promise<Result<MemorySearchResult[], Error>>;
}
