// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * MemoryEmbeddingStore: the SEGREGATED hexagonal boundary for the MMR diversity
 * re-rank — a bulk, (tenant, agent)-scoped read of the embedding VECTORS
 * for an already-ranked candidate id set, so the agent-side `mmrRerank` can run
 * `λ·rel − (1−λ)·maxCosineToSelected` over the candidates' ACTUAL embeddings (not
 * a lexical proxy — the locked decision #3).
 *
 * This is a NEW port — it deliberately does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). Per design §3.2 that surface is never
 * widened for agent use; new capabilities arrive as their own segregated port
 * (the same pattern as `MemoryUsefulnessStore` / `MemoryTemporalStore` /
 * `MemoryConsolidationStore` §6.5). The sole adapter is in
 * @comis/memory (it owns the `db` handle and runs all SQL); the agent read path
 * (recall MMR) consumes this port TYPE from @comis/core — it cannot import
 * @comis/memory (the agent↛memory build cut). No new authority is granted beyond
 * a scoped read within the caller's own (tenant, agent).
 *
 * This file is type-only (mirrors reranker.ts / memory-temporal-store.ts): no
 * zod, no @comis/memory import.
 */
export interface MemoryEmbeddingStore {
  /**
   * Bulk-read the embedding vectors for `ids`, scoped to (tenant, agent). The
   * adapter LEFT JOINs vec_memories (raw reads do NOT populate embeddings — the
   * hydrate-on-demand precedent). Returns
   * id→vector; an id with no embedding (sqlite-vec off, not yet indexed) is
   * ABSENT from the map (→ MMR treats it as having no diversity signal; < 2
   * embedded candidates → MMR no-ops, byte-identical recall).
   *
   * Scope is the load-bearing SQL isolation (V4 access control, §5.2). Because
   * this returns the raw VECTORS for a caller-supplied id set (not non-identifying
   * distance scalars), the adapter MUST filter `tenant_id = ? AND agent_id = ?`
   * (JOINing `memories`) — a vector under one (tenant, agent) must NEVER be
   * visible to a read under another, even when the `id` is identical. Bound `?`
   * params, never string concat.
   *
   * Empty input → empty map, no query. A failed read returns `err` (the caller
   * degrades NON-FATALLY: WARN + rank without MMR, never fail recall).
   */
  readEmbeddings(
    ids: string[],
    scope: { tenantId: string; agentId: string },
  ): Promise<Result<ReadonlyMap<string, number[]>, Error>>;
}
