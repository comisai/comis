// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * MemoryUsefulnessStore: the SEGREGATED hexagonal boundary for the recall-utility
 * feedback loop (FEED-02) — the durable per-memory signal of whether a recalled
 * memory was actually USED (attributed) or IGNORED, so recall can learn from
 * outcomes (the leapfrog Hindsight structurally cannot follow — `access_count`
 * is dead schema there; HINDSIGHT_VS_COMIS.md #7).
 *
 * This is a NEW port — it deliberately does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). Per design §3.2 that surface is never
 * widened for agent use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryConsolidationStore` §6.5 / `MemoryEntityStore`
 * §3.2). The sole adapter is in @comis/memory (it owns the `db` handle and runs
 * all SQL); the agent read path (recall scoring) consumes this port TYPE from
 * @comis/core — it cannot import @comis/memory (the agent↛memory build cut). No
 * new authority is granted beyond a scoped read/write within the caller's own
 * (tenant, agent).
 *
 * This file is type-only (mirrors reranker.ts): no zod, no @comis/memory import.
 */

/**
 * The isolation boundary for every usefulness operation (FEED-02). Every
 * statement in the sole adapter filters on `(tenantId, agentId)` and the table
 * PRIMARY KEY keys on `(tenant_id, agent_id, memory_id)` — this is a
 * load-bearing SECURITY scope in a multi-agent DB, not a nicety: a write under
 * one (tenant, agent) must NEVER be visible to a read under another, even when
 * the `memory_id` is identical.
 */
export interface UsefulnessScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /**
   * Injected epoch ms for `last_useful_at` bookkeeping. NEVER `Date.now()` — the
   * caller supplies it from an injected clock so the write path stays
   * deterministic/testable.
   */
  now: number;
}

/**
 * Per-memory usefulness signal (FEED-02). Counts only — no content ever enters
 * this layer (content-free, like the `memory:*` bus events). A memory id with no
 * persisted row is absent from `readUsefulness`'s Map (→ a neutral factor in
 * score.ts), so these counts only ever start at the values written.
 */
export interface UsefulnessSignal {
  /** Times this memory was recalled AND attributed as used. */
  usedCount: number;
  /** Times recalled but NOT used. */
  ignoredCount: number;
  /** Epoch ms of the last "used" attribution (absent until first use). */
  lastUsefulAt?: number;
}

export interface MemoryUsefulnessStore {
  /**
   * WRITE (FEED-02). Increment `used_count` for `usedIds` and `ignored_count`
   * for `ignoredIds`, upserting the (tenant, agent, memory_id) row; set
   * `last_useful_at = scope.now` for `usedIds`. Idempotent at the row level
   * (INSERT ... ON CONFLICT DO UPDATE) — re-running over the same ids increments,
   * never duplicates rows. Empty `usedIds` AND empty `ignoredIds` → no-op
   * `ok(undefined)` (no transaction). The caller (FEED-01 attribution) produces
   * DISJOINT sets; a stray id appearing in both is touched used-before-ignored.
   */
  recordUsage(
    usedIds: string[],
    ignoredIds: string[],
    scope: UsefulnessScope,
  ): Promise<Result<void, Error>>;

  /**
   * READ (FEED-03). Bulk-fetch the usefulness signal for `memoryIds`, scoped to
   * (tenant, agent). Returns a Map keyed by memory id; ids with no persisted row
   * are ABSENT from the map (→ a neutral 1.0 factor in score.ts). Empty input →
   * empty map, no query.
   */
  readUsefulness(
    memoryIds: string[],
    scope: Omit<UsefulnessScope, "now">,
  ): Promise<Result<Map<string, UsefulnessSignal>, Error>>;
}
