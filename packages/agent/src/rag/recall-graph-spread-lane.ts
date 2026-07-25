// SPDX-License-Identifier: Apache-2.0
/**
 * appendGraphSpreadLane — the 6th fused recall lane, the file-for-file
 * analog of appendCausalLane. PURE helper: it appends the graph-spread lane to
 * `lanes` IN PLACE and returns the lane's candidate count (0 when the lane has no
 * seeds / the store errored / the lane is empty).
 *
 * Composed LAZILY: the lane runs only when a triple store is injected, the lane
 * is enabled, AND the search produced seeds (the precondition gate is the CALLER's
 * — checked at the memory-recall.ts call site so the disabled path stays
 * synchronous). The store's bounded recursive-CTE walk returns OTHER memories
 * structurally connected (current-truth `subject → object` edges, depth- + fan-out-
 * capped) to the seed subjects (hydrated, depth-scored), which fuse() rebases onto
 * the shared RRF rank scale so a structurally-linked memory can outrank a non-linked
 * one. LLM-free on the hot path.
 *
 * DEFAULT-OFF BYTE-IDENTITY: with `lanes.graphSpread.enabled:false`
 * (the default) the CALLER skips this helper entirely — spreadLane is NEVER called,
 * no lane is pushed, and the fused output is byte-identical to the pre-graphSpread
 * path (the empty-lane no-op reused). Every other no-op path (no seeds / empty lane)
 * returns 0 identically. A lane err is NON-FATAL — recall never fails because the
 * graph-spread lane failed; we WARN and rank WITHOUT it. The CTE SQL lives in the
 * memory package behind the injected TripleStorePort port — this file imports the
 * TYPE only (the agent↛memory build cut).
 *
 * @module
 */

import type { TripleStorePort, SessionKey, ComisLogger } from "@comis/core";
import type { FusionLane } from "./fuse.js";

/**
 * Append the graph-spread lane to `lanes` (in place) and return its candidate count.
 *
 * The PRECONDITION gate (lane enabled + a store injected + a non-empty seed pool) is
 * the CALLER'S responsibility — checked at the memory-recall.ts call site so the
 * disabled path stays synchronous (no extra microtask when off, matching the inline
 * entity/temporal lanes and appendCausalLane). This helper assumes an ACTIVE lane and
 * owns only the query + the post-query no-op / err / push handling. All branches here
 * are reachable from the recall-graph-spread-lane tests.
 *
 * @param lanes         The fusion lanes accumulator (mutated: the spread lane is pushed when non-empty).
 * @param store         The injected TripleStorePort port (TYPE only; the caller proved it defined).
 * @param weight        The graph-spread lane's RRF weight (cfg.lanes.graphSpread.weight).
 * @param maxResults    The per-lane row cap (cfg.maxResults) — the CTE's final LIMIT.
 * @param maxDepth      The recursive-CTE hop cap (cfg.lanes.graphSpread.maxDepth, default 2).
 * @param fanOut        The per-node expansion cap (cfg.lanes.graphSpread.fanOut, default 8).
 * @param seedSubjects  The seed subject strings (the caller sliced the top base hits' content to seedCount).
 * @param sessionKey    The recall session key (tenant scope).
 * @param agentId       The explicitly resolved recall agent scope.
 * @param logger        Structural logger (a non-fatal WARN on lane err).
 * @returns the graph-spread candidate count (0 on the err / empty-lane / no-seed no-op paths).
 */
export async function appendGraphSpreadLane(
  lanes: FusionLane[],
  store: TripleStorePort,
  weight: number,
  maxResults: number,
  maxDepth: number,
  fanOut: number,
  seedSubjects: string[],
  sessionKey: SessionKey,
  agentId: string,
  logger: ComisLogger,
): Promise<number> {
  if (seedSubjects.length === 0) return 0;
  // Scope mirrors the entity/causal/temporal lanes / memoryPort.search: tenant from the
  // session key and agent from the resolved recall authority.
  // The CTE's recursive-arm WHERE enforces this in SQL — the load-bearing isolation.
  const scope = { tenantId: sessionKey.tenantId, agentId };
  const laneRes = await store.spreadLane(seedSubjects, scope, maxDepth, fanOut, maxResults);
  if (!laneRes.ok) {
    logger.warn(
      {
        agentId,
        seedCount: seedSubjects.length,
        errorKind: "internal" as const,
        hint: "graph-spread lane failed; using other lanes only",
      },
      "graph-spread lane fallback",
    );
    return 0;
  }
  // The empty-lane no-op: an empty lane pushes nothing -> fuse() ranking unchanged.
  if (laneRes.value.length === 0) return 0;
  lanes.push({ results: laneRes.value, weight });
  return laneRes.value.length;
}
