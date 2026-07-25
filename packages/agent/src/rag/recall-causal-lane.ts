// SPDX-License-Identifier: Apache-2.0
/**
 * appendCausalLane — the 5th fused recall lane, extracted from memory-recall.ts
 * (which crossed the 800-line cap with the 5th lane). PURE helper: it appends the causal lane
 * to `lanes` IN PLACE and returns the lane's candidate count (0 when the lane is off / no store
 * / no seeds / empty / errored). Mirrors the inline entity/temporal lane blocks tier-for-tier.
 *
 * Composed LAZILY: the lane runs only when a causal store is injected, the lane is enabled, AND
 * the search produced seeds. The store's scoped one-hop edge lookup returns OTHER memories
 * causally linked (cause↔effect) to the seeds (hydrated, confidence-first), which fuse() rebases
 * onto the shared RRF rank scale so a causally-linked memory can outrank a non-linked one.
 *
 * DEFAULT-OFF BYTE-IDENTITY: with `enabled:false` (the default) the body is SKIPPED —
 * causalLane is NEVER called, no lane is pushed, and the fused output is byte-identical to the
 * pre-causal-lane path (the empty-lane no-op reused). Every other no-op path (no store / no seeds /
 * empty lane) returns 0 identically. A lane err is NON-FATAL — recall never fails because the
 * causal lane failed; we WARN and rank WITHOUT it. The lane SQL lives in the memory package
 * behind the injected MemoryCausalStore port — this file imports the TYPE only (the agent↛memory
 * build cut).
 *
 * @module
 */

import type { MemoryCausalStore, MemoryRecallScope, ComisLogger } from "@comis/core";
import type { FusionLane } from "./fuse.js";

/**
 * Append the causal lane to `lanes` (in place) and return its candidate count.
 *
 * The PRECONDITION gate (lane enabled + a store injected + a non-empty seed pool) is the
 * CALLER'S responsibility — checked at the memory-recall.ts call site so the disabled path
 * stays synchronous (no extra microtask when off, matching the inline entity/temporal lanes).
 * This helper therefore assumes an ACTIVE lane and owns only the query + the post-query no-op /
 * err / push handling. All branches here are reachable from the recall tests.
 *
 * @param lanes      The fusion lanes accumulator (mutated: the causal lane is pushed when non-empty).
 * @param store      The injected MemoryCausalStore port (TYPE only; the caller proved it defined).
 * @param weight     The causal lane's RRF weight (cfg.lanes.causal.weight).
 * @param maxResults The per-lane row cap (cfg.maxResults).
 * @param seedIds    The seed memory ids (the caller sliced the top base hits to seedCount).
 * @param sessionKey The recall session key (tenant scope).
 * @param agentId    The recall agent (agent scope; falls back to the session key's, else "default").
 * @param logger     Structural logger (a non-fatal WARN on lane err).
 * @returns the causal candidate count (0 on the err / empty-lane no-op paths).
 */
export async function appendCausalLane(
  lanes: FusionLane[],
  store: MemoryCausalStore,
  weight: number,
  maxResults: number,
  seedIds: string[],
  scope: MemoryRecallScope,
  logger: ComisLogger,
): Promise<number> {
  if (seedIds.length === 0) return 0;
  // Scope mirrors the entity/temporal lanes / memoryPort.search: tenant from the session key,
  // agent from the recall arg (else the session key's agent, else "default"). The lane's WHERE
  // enforces this in SQL — the load-bearing isolation.
  const laneRes = await store.causalLane(seedIds, scope, maxResults);
  if (!laneRes.ok) {
    logger.warn(
      { agentId: scope.agentId, seedCount: seedIds.length, errorKind: "internal" as const, hint: "causal lane failed; using other lanes only" },
      "causal lane fallback",
    );
    return 0;
  }
  // The empty-lane no-op: an empty lane pushes nothing -> fuse() ranking unchanged.
  if (laneRes.value.length === 0) return 0;
  lanes.push({ results: laneRes.value, weight });
  return laneRes.value.length;
}
