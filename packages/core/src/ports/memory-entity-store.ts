// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemorySearchResult } from "./memory.js";
import type { LearningScope } from "./outcome-signal-port.js";

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
 * The isolation boundary for every entity operation. Both the resolver
 * UNIQUE index and the lane self-join key on `(tenantId, agentId)` — this is a
 * load-bearing SECURITY scope in a multi-agent DB, not a nicety: two agents (or
 * tenants) must NEVER collapse to one entity row or surface each other's
 * memories even when an entity name is identical.
 *
 * SIMPLIFY-02: UNIFIED onto the canonical {@link LearningScope} (`{tenantId,
 * agentId, now?}`) — the isolation fields are NOT re-declared here (that was the
 * 15× per-port repetition the collapse kills). This is a thin alias that DERIVES
 * `tenantId`/`agentId` from `LearningScope` and re-narrows the injected clock
 * `now` to REQUIRED (the entity write path — `resolveAndLink` — bookkeeps
 * `first_seen`/`last_seen` from it; NEVER `Date.now()`).
 */
export type EntityScope = LearningScope & {
  /**
   * Injected wall-clock epoch milliseconds for `first_seen` / `last_seen`
   * bookkeeping. REQUIRED on the entity write path. NEVER `Date.now()` — the
   * caller supplies it from an injected clock so the write path stays
   * deterministic/testable.
   */
  now: number;
};

/**
 * A single entity row for the entity-graph diagnostic. Counts +
 * bookkeeping timestamps only — `name` is the canonical display name the
 * admin-gated diagnostic surfaces to an operator (NOT exposed on the bus
 * `memory:entities_linked` event, which stays counts-only). `firstSeen` /
 * `lastSeen` are epoch milliseconds and optional (a freshly-created row may
 * not yet have both populated by the adapter).
 */
export interface EntityRow {
  /** Stable entity id. */
  id: string;
  /** Canonical display name (operator-facing diagnostic only). */
  name: string;
  /** How many memories reference this entity within the scope. */
  mentionCount: number;
  /** Epoch ms of the first mention (optional). */
  firstSeen?: number;
  /** Epoch ms of the most recent mention (optional). */
  lastSeen?: number;
}

export interface MemoryEntityStore {
  /**
   * WRITE PATH. Resolve `name` to an entity scoped to (tenant, agent)
   * — exact `canonical_key` reuse first, else a fuzzy match >= 0.6, else create
   * a new entity — bump its `mention_count` / `last_seen`, and link
   * `memoryId` <-> the resolved entity id (idempotent). Returns the resolved
   * entity id.
   */
  resolveAndLink(memoryId: string, name: string, scope: EntityScope): Promise<Result<string, Error>>;

  /**
   * READ PATH. Given seed memory ids, return OTHER memories — scoped to
   * (tenant, agent), the seeds themselves excluded — that share >= 1 entity,
   * HYDRATED as `MemorySearchResult[]` ordered most-shared-first.
   * Returns an empty array when there are no seeds or no shared entities
   * (the entity lane is then empty and RRF ranking is unchanged).
   * `cap` bounds the returned row count.
   */
  associativeLane(
    seedIds: string[],
    scope: Omit<EntityScope, "now">,
    cap: number,
  ): Promise<Result<MemorySearchResult[], Error>>;

  /**
   * DIAGNOSTIC READ PATH. List the entities scoped to a single
   * `(tenantId, agentId)` partition, ordered most-mentioned-first, bounded by
   * `limit`. This is the entity-graph diagnostic's surface — a NON-seed read,
   * distinct from the seed-based `associativeLane` (which needs memory seeds to
   * traverse). Bakes the SAME `(tenant, agent)` SQL isolation as the resolver
   * UNIQUE index and the lane self-join — two agents/tenants must
   * never surface each other's entity rows even when a name is identical. The
   * sole adapter is in @comis/memory; called only from the daemon
   * (`memory.entities` handler). No new authority beyond a scoped read
   * within the caller's own (tenant, agent).
   */
  listEntities(
    agentId: string,
    tenantId: string,
    limit: number,
  ): Promise<Result<EntityRow[], Error>>;
}
