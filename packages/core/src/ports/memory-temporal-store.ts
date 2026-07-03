// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemorySearchResult } from "./memory.js";

/**
 * MemoryTemporalStore: the SEGREGATED hexagonal boundary for temporal-spread
 * recall (the "what else happened around then" lane — given the seed memories'
 * event times, surface OTHER memories near those times).
 *
 * This is a deliberately separate port — it does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). That surface is never
 * widened for agent use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryEntityStore` and `MemoryUsefulnessStore`).
 * The sole adapter is in @comis/memory (it owns the `db` handle and
 * runs the windowed SQL over the EXISTING `memories.occurred_at` column — NO new
 * table); the agent-side read path (memory-recall) consumes this port TYPE from
 * @comis/core — it cannot import @comis/memory (the agent↛memory build cut). No
 * new authority is granted beyond a windowed read within the caller's own
 * (tenant, agent) scope.
 *
 * This file is type-only (mirrors reranker.ts / memory-entity-store.ts): no zod,
 * no @comis/memory import.
 */

export interface MemoryTemporalStore {
  /**
   * READ PATH. Given the seed memories' event times
   * (`seedOccurredAts`, epoch ms), return OTHER memories — scoped to
   * (tenant, agent), the seed-time memories themselves excluded — whose
   * `occurred_at` falls within `windowMs` of ANY seed time, HYDRATED as
   * `MemorySearchResult[]` ordered NEAREST-FIRST (the min-distance over all
   * seeds; a candidate near EITHER seed surfaces, no cartesian blow-up).
   *
   * Returns an empty array when there are no seeds or no in-window neighbours
   * (the no-op — the temporal lane is then empty and RRF ranking is
   * unchanged). `cap` bounds the returned row count. Memories with a NULL
   * `occurred_at` (no event time to spread from) are never returned.
   *
   * The (tenant, agent) scope is the load-bearing SQL isolation boundary:
   * two agents (or tenants) whose memories share the same
   * `occurred_at` must NEVER surface each other's rows by event-time
   * coincidence. Does NOT widen `MemoryPort`.
   */
  spreadLane(
    seedOccurredAts: number[],
    scope: { tenantId: string; agentId: string },
    windowMs: number,
    cap: number,
  ): Promise<Result<MemorySearchResult[], Error>>;
}
