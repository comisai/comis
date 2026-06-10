// SPDX-License-Identifier: Apache-2.0
/**
 * prefilterLanes — the RETR-04 pre-fusion security gate, extracted from memory-recall.ts
 * (which is at the 800-line cap; mirrors the recall-provenance / recall-causal-lane
 * extractions). PURE, synchronous helper.
 *
 * RETR-04 / design §17 S6: the unified arbiter (Plan 03) ranks LTM T3/T4 candidates
 * against history by FUSED rank. A trust-excluded OR sub-floor memory must NEVER be
 * resurrected by a high fused rank, so BOTH the trust filter and the R3 baseFloor run
 * UPSTREAM of `fuse()` — on each candidate lane's results BEFORE fusion — not only on the
 * post-fusion ranked list. The downstream trust filter + baseFloor in memory-recall.ts are
 * RETAINED as defense in depth.
 *
 * Why baseFloor MUST be pre-fuse (RESEARCH Pitfall 2, proven by a bypass-attempt test):
 * `fuse()` re-normalizes scores to the RRF rank scale, so a sub-floor candidate that is
 * rank-1 in its lanes emerges with a HIGH fused `score`. The downstream baseFloor reads
 * `ScoreBreakdown.base` (= the post-fuse `result.score`), which the inflation lifts above
 * the floor → the poison survives. The TRUE base relevance is the per-lane adapter score
 * BEFORE fusion, so the floor is enforced HERE against each candidate's pre-fusion
 * `result.score`. The downstream gate (now fail-closed, gated on relevanceFirst) remains as
 * defense in depth on the fused list.
 *
 * DEFAULT-OFF BYTE-IDENTITY: when every lane result is already trust-allowed AND the floor
 * is 0 (frontier/mid recency-first, unconfigured), each lane's results array is returned
 * UNCHANGED (same reference, same order), so fuse() sees exactly the lanes it saw pre-patch
 * and the fused output is byte-identical (LOCKED #2). A lane is rebuilt only when the gate
 * actually drops an entry (a disallowed trust level, or — when a floor is enforced — a
 * sub-floor score).
 *
 * CONTENT-FREE OBSERVABILITY (§2.7): the helper returns the dropped entry IDS only (never
 * content or query text), so the caller's recall trace can record the upstream DROP count /
 * ids the same way the downstream trust filter captures `trustFilteredIds`.
 *
 * Architecture cut (agent↛memory): TYPE-only imports from @comis/core. This file NEVER
 * imports @comis/memory.
 *
 * @module
 */

import type { MemorySearchResult, TrustLevel, ComisLogger } from "@comis/core";
import type { FusionLane } from "./fuse.js";
import type { ScoreBreakdown } from "./score.js";

/**
 * R3 base-score floor decision (T-153-poison mitigation), FAIL-CLOSED (WR-02).
 *
 * A memory survives the floor ONLY when its recorded pre-boost `breakdown.base`
 * is at or above `baseFloor` (boundary inclusive). A memory with NO breakdown
 * (`undefined`) is DROPPED — it cannot be proven above the floor.
 *
 * Why no `r.score` fallback: on the rerank-applied path the entry's `score` is
 * the cross-encoder probability, a different (typically higher) scale than
 * `breakdown.base`. Comparing the floor against that inflated score would let a
 * low-base poisoned memory survive the exact filter meant to drop it. This gate
 * is security-critical, so a missing base fails closed. (The post-fuse defense-in-depth
 * gate in memory-recall.ts uses this; the upstream pre-filter floors raw candidate
 * scores directly via prefilterLanes — see this module's doc.)
 *
 * @internal exported for tests + the recall pipeline.
 */
export function passesBaseFloor(
  breakdown: ScoreBreakdown | undefined,
  baseFloor: number,
): boolean {
  return breakdown !== undefined && breakdown.base >= baseFloor;
}

/**
 * RETR-04 / WR-02 (Phase 173): the class-default base floor enforced when the unified
 * arbiter is active (relevanceFirst) and the operator left baseFloor UNCONFIGURED (0).
 *
 * Mirrors SMALL_NANO_DEFAULT_BASE_FLOOR in scaffold-defaults.ts (the resolver already
 * resolves small/nano to 0.15; this is the recall gate's own fail-closed floor so an
 * unconfigured 0 reaching the gate under the arbiter is NEVER silently skipped). Kept in
 * sync with the resolver via the Phase-153 poison fixture (base=0.12 dropped, 0.40 kept).
 */
export const RELEVANCE_FIRST_DEFAULT_BASE_FLOOR = 0.15 as const;

/**
 * Resolve the effective R3 base floor (WR-02 fail-closed, arbiter-scoped). Pure.
 *
 * Precedence:
 *   • explicit operator floor (configuredBaseFloor > 0) → always wins (every class);
 *   • relevanceFirst (arbiter active) AND unconfigured (0) → the class default 0.15
 *     (an arbiter that ranks LTM against history needs the floor enforced — the WR-02
 *     fail-open closure, design §17 S6);
 *   • otherwise (frontier/mid recency-first, unconfigured) → 0 (filter skipped,
 *     byte-identical to v2.14, LOCKED #2).
 *
 * @returns the floor to enforce; `0` means "no floor — skip the filter".
 */
export function resolveEffectiveBaseFloor(
  configuredBaseFloor: number | undefined,
  relevanceFirst: boolean | undefined,
): number {
  const explicitFloor = configuredBaseFloor !== undefined && configuredBaseFloor > 0 ? configuredBaseFloor : 0;
  if (explicitFloor > 0) return explicitFloor;
  return relevanceFirst === true ? RELEVANCE_FIRST_DEFAULT_BASE_FLOOR : 0;
}

/** Result of the pre-fusion security gate: the gated lanes + the dropped ids (content-free). */
export interface PrefilterResult {
  /** The lanes with disallowed-trust / sub-floor entries removed. Unchanged refs when no drop. */
  lanes: FusionLane[];
  /** IDs dropped by the upstream TRUST gate (for the recall trace — ids only, no content). */
  trustDroppedIds: string[];
  /** IDs dropped by the upstream BASE-FLOOR gate (for the recall trace — ids only, no content). */
  floorDroppedIds: string[];
}

/**
 * Drop trust-excluded and (when `baseFloor > 0`) sub-floor entries from each candidate
 * lane, BEFORE fusion. Pure: the input lanes are not mutated; a lane is returned by
 * reference when it drops nothing (byte-identity), otherwise a new lane object with a
 * filtered `results` array is returned.
 *
 * The baseFloor is enforced against each candidate's PRE-FUSION `result.score` (the genuine
 * per-lane adapter relevance) — NOT a post-fusion RRF-inflated score — so a sub-floor
 * candidate cannot be resurrected by a high fused rank. A `baseFloor` of 0 (frontier/mid
 * recency-first, unconfigured) disables the floor branch entirely → byte-identical.
 *
 * @param lanes     The candidate lanes about to be fused (the LTM/KG T3/T4 supply).
 * @param allowed   The permitted trust levels (cfg.includeTrustLevels as a Set).
 * @param baseFloor The effective floor (0 = no floor — skip the floor branch).
 */
export function prefilterLanes(
  lanes: FusionLane[],
  allowed: ReadonlySet<TrustLevel>,
  baseFloor: number,
): PrefilterResult {
  const trustDroppedIds: string[] = [];
  const floorDroppedIds: string[] = [];
  const floorActive = baseFloor > 0;
  const gated: FusionLane[] = [];

  for (const lane of lanes) {
    let hasDrop = false;
    for (const r of lane.results) {
      if (r === undefined) continue;
      if (!allowed.has(r.entry.trustLevel)) {
        hasDrop = true;
        trustDroppedIds.push(r.entry.id);
      } else if (floorActive && (r.score ?? 0) < baseFloor) {
        // Trust-allowed but below the floor (genuine pre-fusion relevance). Note: a
        // trust-excluded entry is counted ONLY under trust (the `else if`), so the two
        // dropped-id sets never double-count the same id.
        hasDrop = true;
        floorDroppedIds.push(r.entry.id);
      }
    }
    if (!hasDrop) {
      // Byte-identity: nothing to drop in this lane → keep the SAME reference + order.
      gated.push(lane);
      continue;
    }
    const kept = lane.results.filter(
      (r): r is MemorySearchResult =>
        r !== undefined && allowed.has(r.entry.trustLevel) && (!floorActive || (r.score ?? 0) >= baseFloor),
    );
    gated.push({ results: kept, weight: lane.weight });
  }

  return { lanes: gated, trustDroppedIds, floorDroppedIds };
}

/**
 * A running accumulator of the upstream-dropped ids (content-free) across every gated
 * candidate supply in one recall, fed to the recall trace at the end.
 */
export interface PrefilterAccumulator {
  trustDroppedIds: string[];
  floorDroppedIds: string[];
}

/**
 * Gate `lanes` (trust + baseFloor), PUSH the dropped ids into `acc`, and return the gated
 * lanes. The recall pipeline gates several candidate supplies at their source (the raw
 * fts/vector lanes, the single fallback lane, and the appended KG lanes); this collapses
 * each of those call sites to one line while keeping the dropped-id accounting in one
 * accumulator. Pure w.r.t. the lanes (byte-identity preserved by prefilterLanes); the only
 * effect is the push into `acc`.
 */
export function gateLanes(
  lanes: FusionLane[],
  allowed: ReadonlySet<TrustLevel>,
  baseFloor: number,
  acc: PrefilterAccumulator,
): FusionLane[] {
  const result = prefilterLanes(lanes, allowed, baseFloor);
  acc.trustDroppedIds.push(...result.trustDroppedIds);
  acc.floorDroppedIds.push(...result.floorDroppedIds);
  return result.lanes;
}

/**
 * §2.7 instrumentation for the new pre-fusion security boundary — CONTENT-FREE (counts +
 * booleans only, NEVER memory bodies or query text). DEBUG (N-per-recall internal stage),
 * emitted only when the gate actually dropped a candidate so a clean corpus stays silent.
 * Makes a pre-fusion poisoning drop diagnosable from logs alone.
 */
export function logPrefilterDrops(
  logger: ComisLogger,
  acc: PrefilterAccumulator,
  ctx: { agentId?: string; relevanceFirst: boolean },
): void {
  if (acc.trustDroppedIds.length === 0 && acc.floorDroppedIds.length === 0) return;
  logger.debug(
    {
      agentId: ctx.agentId,
      step: "recall-prefilter",
      trustDropped: acc.trustDroppedIds.length,
      floorDropped: acc.floorDroppedIds.length,
      relevanceFirst: ctx.relevanceFirst,
    },
    "recall security pre-filter dropped candidates upstream of fusion",
  );
}
