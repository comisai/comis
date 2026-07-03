// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { LearningScope } from "./outcome-signal-port.js";

/**
 * MemoryUsefulnessStore: the SEGREGATED hexagonal boundary for the recall-utility
 * feedback loop — the durable per-memory signal of whether a recalled
 * memory was actually USED (attributed) or IGNORED, so recall can learn from
 * outcomes rather than from raw access counts (an access counter alone cannot
 * distinguish a memory that helped from one that was merely fetched).
 *
 * This is a deliberately separate port — it does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). That surface is never widened for agent
 * use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryConsolidationStore` and `MemoryEntityStore`).
 * The sole adapter is in @comis/memory (it owns the `db` handle and runs
 * all SQL); the agent read path (recall scoring) consumes this port TYPE from
 * @comis/core — it cannot import @comis/memory (the agent↛memory build cut). No
 * new authority is granted beyond a scoped read/write within the caller's own
 * (tenant, agent).
 *
 * This file is type-only (mirrors reranker.ts): no zod, no @comis/memory import.
 */

/**
 * The isolation boundary for every usefulness operation. Every
 * statement in the sole adapter filters on `(tenantId, agentId)` and the table
 * PRIMARY KEY keys on `(tenant_id, agent_id, memory_id)` — this is a
 * load-bearing SECURITY scope in a multi-agent DB, not a nicety: a write under
 * one (tenant, agent) must NEVER be visible to a read under another, even when
 * the `memory_id` is identical.
 *
 * Unified onto the canonical {@link LearningScope} — the isolation
 * fields are NOT re-declared here (one canonical definition instead of a
 * per-port copy).
 * A thin alias that DERIVES `tenantId`/`agentId` from `LearningScope`, re-narrows
 * the injected clock `now` to REQUIRED (the `recordUsage`/`recordFailure` write
 * paths), AND carries the usefulness-specific `intent?` per-query bucket key
 * (an ADDITIONAL key, NEVER a relaxation of the (tenant, agent) isolation scope).
 */
export type UsefulnessScope = LearningScope & {
  /**
   * Injected epoch ms for `last_useful_at` bookkeeping. REQUIRED on the
   * usefulness write path. NEVER `Date.now()` — the caller supplies it from an
   * injected clock so the write path stays deterministic/testable.
   */
  now: number;
  /**
   * Optional query-INTENT bucket. When present, the read fetches /
   * the write records the per-intent usefulness signal (a memory's usefulness FOR
   * THAT intent); when OMITTED the adapter resolves the GLOBAL bucket
   * (intent=""). The closed-union value comes from the agent's
   * deterministic `classifyIntent` (LLM-free); typed here as a plain string so
   * @comis/core takes no @comis/agent dependency. NOT a security
   * boundary — (tenantId, agentId) remain the isolation scope; intent is an
   * ADDITIONAL key, never a relaxation.
   *
   * Because `readUsefulness` takes `Omit<UsefulnessScope, "now">`, this optional
   * field flows to BOTH `recordUsage` (the write) AND the read automatically.
   */
  intent?: string;
};

/**
 * Per-memory usefulness signal. Counts only — no content ever enters
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
  /**
   * Outcome-attributed task FAILURE count — surfaced ONLY when > 0
   * (absent for a clean memory, like `lastUsefulAt`). It is the NEGATIVE-reward signal
   * the OFFLINE bandit feed consumes (a memory in the `recalled_ids` of a `failure`/
   * `corrected` trajectory accrues it, corroboration-gated). The recall HOT PATH
   * (`score.ts` `usefulnessNorm`) reads ONLY `usedCount`/`ignoredCount` and IGNORES this
   * field, so projecting it is byte-identical for recall ranking — it exists for the
   * bandit's posterior, not the live score.
   */
  failureCount?: number;
}

export interface MemoryUsefulnessStore {
  /**
   * WRITE. Increment `used_count` for `usedIds` and `ignored_count`
   * for `ignoredIds`, upserting the (tenant, agent, memory_id) row; set
   * `last_useful_at = scope.now` for `usedIds`. Idempotent at the row level
   * (INSERT ... ON CONFLICT DO UPDATE) — re-running over the same ids increments,
   * never duplicates rows. Empty `usedIds` AND empty `ignoredIds` → no-op
   * `ok(undefined)` (no transaction). The caller (the attribution path) produces
   * DISJOINT sets; a stray id appearing in both is touched used-before-ignored.
   */
  recordUsage(
    usedIds: string[],
    ignoredIds: string[],
    scope: UsefulnessScope,
  ): Promise<Result<void, Error>>;

  /**
   * READ. Bulk-fetch the usefulness signal for `memoryIds`, scoped to
   * (tenant, agent). Returns a Map keyed by memory id; ids with no persisted row
   * are ABSENT from the map (→ a neutral 1.0 factor in score.ts). Empty input →
   * empty map, no query.
   */
  readUsefulness(
    memoryIds: string[],
    scope: Omit<UsefulnessScope, "now">,
  ): Promise<Result<Map<string, UsefulnessSignal>, Error>>;

  /**
   * WRITE. Accrue an outcome-attributed task FAILURE for `memoryId`
   * — increment `failure_count` on the (tenant, agent, memory_id, intent) bucket
   * (first touch INSERTs failure_count=1). `failure_count` is a DISTINCT signal
   * from `ignored_count`: a correct-but-unused memory accrues `ignored_count`
   * (recalled-but-not-cited), NEVER `failure_count`; only a memory in the
   * `recalled_ids` of a `failure`/`corrected` trajectory accrues here — and the
   * caller (the daemon reward seam) gates that on the anti-induced-eviction
   * corroboration rule. Idempotent at the row level
   * (INSERT ... ON CONFLICT DO UPDATE). The (tenant, agent) filter is the
   * load-bearing isolation boundary; `intent` is an ADDITIONAL key.
   */
  recordFailure(memoryId: string, scope: UsefulnessScope): Promise<Result<void, Error>>;
}
