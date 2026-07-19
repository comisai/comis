// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { MemorySearchResult } from "./memory.js";
import type { MemoryRecallScope } from "../domain/memory-scope.js";

/**
 * MemoryCausalStore: the SEGREGATED hexagonal boundary for causal-edge recall
 * (the cause→effect links between memories, and the one-hop lane that surfaces
 * memories causally connected to the seed hits).
 *
 * This is a deliberately separate port — it does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). That surface is never
 * widened for agent use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryEntityStore`, `MemoryTemporalStore` and
 * `MemoryUsefulnessStore`). The sole adapter is in @comis/memory (it owns the
 * `db` handle and runs all SQL over the additive `memory_causal_edges` table);
 * the agent-side write path (memory-review-job) and read path
 * (memory-recall) consume this port TYPE from @comis/core — they cannot
 * import @comis/memory (the agent↛memory build cut). No new authority is granted
 * beyond link/read within the caller's own (tenant, agent) scope.
 *
 * It carries BOTH a WRITE (`linkCausal`) and a READ (`causalLane`) method — the
 * `MemoryEntityStore` dual-method shape (NOT a split read/write port, NOT the
 * usefulness-feedback bus pattern). The causal edge derives from the extraction
 * the agent already runs, so the agent-side injected-port write is the correct,
 * simpler analog.
 *
 * This file is type-only (mirrors memory-temporal-store.ts / memory-entity-store.ts):
 * no zod, no @comis/memory import.
 */

/**
 * The isolation boundary for every causal-edge operation (the same entity-scope
 * pattern). Both the edge PRIMARY KEY and every read/write WHERE key on
 * `(tenantId, agentId)` — this is a load-bearing SECURITY scope in a multi-agent
 * DB, not a nicety: an edge written under one (tenant, agent) must NEVER be
 * returned for another scope by memory-id coincidence.
 *
 * Unified onto the canonical {@link LearningScope} — the isolation
 * fields are NOT re-declared here (one canonical definition instead of a
 * per-port copy).
 * A thin alias that DERIVES `tenantId`/`agentId` from `LearningScope` and
 * re-narrows the injected clock `now` to REQUIRED (the `linkCausal` write path).
 */
export type CausalScope = MemoryRecallScope & {
  /**
   * Injected wall-clock epoch milliseconds for the edge's `created_at`
   * bookkeeping. REQUIRED on the causal write path. NEVER `Date.now()` — the
   * caller supplies it from an injected clock so the write path stays
   * deterministic/testable.
   */
  now: number;
};

export interface MemoryCausalStore {
  /**
   * WRITE PATH. Record a directed cause→effect edge from
   * `sourceMemoryId` to the memory whose stored content best matches
   * `effectText`, scoped to (tenant, agent). The adapter resolves `effectText`
   * to a stored memory id via the same scoped FTS the review loop uses (top-1
   * match) — `effectText` is untrusted conversation-derived data, never SQL.
   * Idempotent (INSERT OR IGNORE on the scoped PK). Returns the count of edges
   * written (0 when no counterpart memory resolves — non-fatal; the effect
   * referenced a fact not yet stored).
   */
  linkCausal(
    sourceMemoryId: string,
    effectText: string,
    scope: CausalScope,
    confidence: number,
  ): Promise<Result<number, Error>>;

  /**
   * READ PATH (the consuming lane). Given seed memory ids, return OTHER memories
   * linked by a causal edge in EITHER direction (cause→effect or effect→cause;
   * causal influence is bidirectionally relevant even though the edge is
   * directed), scoped to (tenant, agent), the seeds themselves excluded,
   * HYDRATED as `MemorySearchResult[]` ordered by edge confidence. Returns an
   * empty array when there are no seeds or no edges (the no-op case — the
   * causal lane is then empty and RRF ranking is unchanged). `cap` bounds the
   * returned row count.
   */
  causalLane(
    seedMemoryIds: string[],
    scope: Omit<CausalScope, "now">,
    cap: number,
  ): Promise<Result<MemorySearchResult[], Error>>;
}
