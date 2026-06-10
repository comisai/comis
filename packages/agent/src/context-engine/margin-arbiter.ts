// SPDX-License-Identifier: Apache-2.0
/**
 * RETR-02 — the pure tiered margin arbiter.
 *
 * The relevance-first sibling of {@link evictHistoryUnderBudget}. Where the recency
 * allocator keeps the NEWEST whole steps that fit a flat history budget, the arbiter
 * spends the SAME discretionary pool (`budget.availableHistoryTokens`) across multiple
 * candidate TIERS by FUSED RANK, with the unconditional floors guaranteed:
 *
 *   - T0 fresh-tail + S4-pinned items ({@link ArbiterFloors}) are UNCONDITIONAL floors
 *     — always kept, NEVER relevance candidates, regardless of fused rank or pool
 *     contention. They mirror the `lcd-preflight.ts:114-121` harder-eviction exclusion:
 *     a security-pinned item survives even when it dwarfs the pool (the Fix-3 pre-flight
 *     already reserved room for it; the arbiter must not drop it). WR-04 (Phase 173-05):
 *     floors are STEP-ATOMIC — a floor flagged on one message in a step (a pinned
 *     `tool_use` whose `toolResult` is not separately pinned, or vice-versa) promotes the
 *     WHOLE step to a floor, so the inseparable pair is never split and `poolTokensUsed`
 *     bills only the genuinely-discretionary (non-floor) middle band.
 *   - The middle history band (T1/T2) + the cross-session LTM (T3) + KG (T4) candidate
 *     lanes share the remaining DISCRETIONARY pool, allocated by FUSED RANK (RRF via the
 *     Plan-02 scorer — `scoreRelevance`/`fuse`, injected as the `scorer` dep; per-tier
 *     weights default 1.0; NEVER a raw cross-corpus score comparison: `lcd_messages_fts`/
 *     `memory_fts` BM25 stats are incomparable).
 *   - Per-tier minimum slots: each represented tier gets at least one slot when the pool
 *     (after floors) can afford it — so a single high-rank LTM fact is never starved by a
 *     long history band, and vice versa.
 *
 * The arbiter WRAPS, never rewrites, `computeTokenBudgetForProfile`: it consumes the
 * pre-computed `poolTokens` (already post-outputHeadroom — the Fix-3 pre-flight at
 * `lcd-preflight.ts` validated it) and NEVER over-allocates then reclaims. The
 * DISCRETIONARY allocation (non-floor) is bounded `≤ poolTokens` (`poolTokensUsed`);
 * the unconditional floors ride on top (they are a security/A1 guarantee, not a budget
 * line). Step-atomic fill reuses the {@link BudgetItem} token authority — it never splits
 * a `tool_use`/`tool_result` pair (history is kept whole-step, recency-ordered within its
 * slot; the within-history relevance eviction of the middle band is Phase 174 / DEPTH-01
 * — see the C2 boundary note below).
 *
 * Purity (and the architecture cuts): no I/O, no clock, no estimator, no globals; the
 * input arrays (and their items) are NEVER mutated; a new array is returned; same input →
 * same output. This module lives in `context-engine/` and obeys TWO cuts:
 *   - agent↛memory: it imports only `@comis/core` types + in-package context-engine
 *     modules — never `@comis/memory` (forbidden by `test/architecture` "agent → memory").
 *   - I2 (context-engine ↮ rag): the LCD engine and the recall/RAG layer share ZERO code
 *     (`lcd-recall-boundary.test.ts`). So the shared relevance scorer (`rag/relevance-scorer.ts`)
 *     is NOT imported — it is INJECTED as the `scorer` dep (DI at the budget boundary), and
 *     the `FusionLane`/`RelevanceQuery` shapes are declared LOCALLY here as the minimal
 *     STRUCTURAL contract (the rag types are structurally compatible, asserted at the call
 *     site). This keeps the directory cut clean while still allocating by FUSED RANK.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemorySearchResult, ComisLogger } from "@comis/core";
import type { BudgetItem } from "./lcd-budget-eviction.js";
import { evictHistoryUnderBudget } from "./lcd-budget-eviction.js";

/**
 * The minimal STRUCTURAL shape of a fusion lane the arbiter ranks — structurally
 * identical to `rag/fuse.ts`'s `FusionLane`, declared locally to honor the I2
 * context-engine ↮ rag cut (the engine must not import the rag layer). The injected
 * `scorer` (`scoreRelevance`) consumes/returns exactly this shape.
 */
export interface ArbiterFusionLane {
  /** Lane results, most-relevant first (rank 1 = first). */
  results: MemorySearchResult[];
  /** RRF weight for this lane (per-tier weights default 1.0). */
  weight: number;
}

/**
 * The minimal STRUCTURAL shape of the relevance query the scorer consumes —
 * structurally identical to `rag/relevance-scorer.ts`'s `RelevanceQuery`, declared
 * locally for the I2 cut. `degraded` (low-signal) → the scorer falls back to
 * recency-first fusion (a deterministic recency signal).
 */
export interface ArbiterRelevanceQuery {
  /** The de-duplicated content terms (stopwords removed), newest-turn terms first. */
  terms: string[];
  /** True when the query carries too few content terms (low-signal). */
  degraded: boolean;
}

/** The minimal STRUCTURAL options shape the scorer accepts — matches
 *  `rag/relevance-scorer.ts`'s `ScoreRelevanceOptions` (content-free logger + id) so the
 *  real `scoreRelevance` is assignable to {@link RelevanceScorerFn} (parameter variance). */
export interface ArbiterScorerOptions {
  logger?: ComisLogger;
  agentId?: string;
}

/**
 * The default minimum slots a represented tier receives after the floors are reserved
 * (KISS: one slot per tier — enough to guarantee representation without a config knob).
 */
const DEFAULT_MIN_TIER_SLOTS = 1;

/**
 * The signature of the shared relevance scorer the arbiter calls to fuse the cross-tier
 * candidate lanes by RANK (NOT raw score). This is exactly `scoreRelevance` from
 * `rag/relevance-scorer.ts` — passed in (DI) so the arbiter stays pure + testable.
 */
export type RelevanceScorerFn = (
  lanes: ArbiterFusionLane[],
  query: ArbiterRelevanceQuery,
  opts?: ArbiterScorerOptions,
) => MemorySearchResult[];

/**
 * The UNCONDITIONAL arbiter floors (RETR-05). Both are guaranteed to survive
 * arbitration and are NEVER relevance candidates:
 *  - `freshTailItems`: the T0 fresh-tail-protected history items (A1).
 *  - `pinnedItems`: the S4 security-pinned history items (canary / delimiter /
 *    safety / sender-trust — detected fail-closed by `isSecurityRelevantMessage`).
 * Both are subsets of `historyItems` (the caller filters them out of the relevance
 * band and passes them here). Identity-compared against `historyItems` entries.
 */
export interface ArbiterFloors {
  /** T0 fresh-tail-protected history items (unconditional). */
  freshTailItems: BudgetItem[];
  /** S4 security-pinned history items (unconditional; never relevance candidates). */
  pinnedItems: BudgetItem[];
}

/** The arbiter input (a single object so the seam call stays readable). */
export interface MarginArbitrateInput {
  /** The evictable history band (T0/T1/T2) — BudgetItem[] with supplied tokens. */
  historyItems: BudgetItem[];
  /** Cross-session LTM candidate lanes (T3) — fused by rank. Empty on the assembly path. */
  ltmCandidates: ArbiterFusionLane[];
  /** Knowledge-graph candidate lanes (T4) — fused by rank. Empty on the assembly path. */
  kgCandidates: ArbiterFusionLane[];
  /** The unconditional floors (T0 fresh-tail + S4 pins). */
  floors: ArbiterFloors;
  /** The discretionary pool (budget.availableHistoryTokens — already post-outputHeadroom). */
  poolTokens: number;
  /** The shared relevance scorer (scoreRelevance) — fuses lanes by rank, never raw score. */
  scorer: RelevanceScorerFn;
  /** The relevance query (from buildRelevanceQuery). Degraded → recency-first fusion. */
  query: ArbiterRelevanceQuery;
  /** Optional per-LTM-candidate token cost for the discretionary accounting. Default 0
   *  (assembly path holds no LTM tokens; recall side owns the LTM budget). */
  ltmTokensPerCandidate?: number;
  /** Optional per-KG-candidate token cost. Default 0 (see ltmTokensPerCandidate). */
  kgTokensPerCandidate?: number;
  /** Optional minimum slots per represented tier (default 1). */
  minTierSlots?: number;
  /** Optional content-free logger forwarded to the scorer's degraded log. */
  scorerOptions?: ArbiterScorerOptions;
}

/** The arbiter result. Pure — a fresh object over fresh arrays. */
export interface MarginArbitrateResult {
  /** The kept history messages (floors + discretionary middle band), in original order. */
  kept: AgentMessage[];
  /** Per-tier kept counts (content-free observability): { history, ltm, kg }. */
  perTierKept: { history: number; ltm: number; kg: number };
  /** Discretionary (non-floor) tokens allocated from the pool — always ≤ poolTokens. */
  poolTokensUsed: number;
  /** The kept LTM candidate ids (fused-rank winners that fit the pool). */
  keptLtmIds: string[];
  /** The kept KG candidate ids (fused-rank winners that fit the pool). */
  keptKgIds: string[];
}

/**
 * Reference-identity membership: is `item` one of the entries in `set`? (The caller
 * passes the SAME BudgetItem objects in `floors` that appear in `historyItems`.)
 */
function isMember(item: BudgetItem, set: readonly BudgetItem[]): boolean {
  for (const f of set) {
    if (f === item) return true;
  }
  return false;
}

/**
 * Allocate the discretionary history pool across tiers by fused rank, with the T0
 * fresh-tail + S4-pinned floors unconditional. See the module doc for the full contract.
 *
 * @param input - the tiered candidates + floors + pool + scorer (see {@link MarginArbitrateInput}).
 * @returns the kept messages + per-tier counts + the discretionary tokens used.
 */
export function marginArbitrate(input: MarginArbitrateInput): MarginArbitrateResult {
  const {
    historyItems,
    ltmCandidates,
    kgCandidates,
    floors,
    poolTokens,
    scorer,
    query,
    ltmTokensPerCandidate = 0,
    kgTokensPerCandidate = 0,
    minTierSlots = DEFAULT_MIN_TIER_SLOTS,
    scorerOptions,
  } = input;

  // -------------------------------------------------------------------------
  // 1. Reserve the UNCONDITIONAL floors (T0 fresh-tail + S4 pins).
  //
  // These survive regardless of the pool: a security-pinned / fresh-tail item is
  // NEVER a relevance candidate and is kept even when it exceeds the pool (the Fix-3
  // pre-flight already reserved room for it — mirrors lcd-preflight.ts:114-121). They
  // do NOT consume the DISCRETIONARY pool budget (poolTokensUsed), so the discretionary
  // fill below stays bounded ≤ poolTokens (no over-allocate-then-reclaim).
  // -------------------------------------------------------------------------
  const isMessageFloor = (it: BudgetItem): boolean =>
    isMember(it, floors.freshTailItems) || isMember(it, floors.pinnedItems);

  // WR-04 (Phase 173-05): expand floors to STEP granularity. A floor flagged on a single
  // message inside a step (e.g. a pinned assistant `tool_use` whose `toolResult` is NOT
  // separately pinned, or a pinned `toolResult` whose `tool_use` is not) would otherwise
  // leave the rest of that step in the relevance-evictable middle band, where the step
  // grouper (lcd-budget-eviction.groupIntoSteps) mis-binds the orphaned half to the
  // neighbouring message — splitting the inseparable pair and mis-billing poolTokensUsed.
  // Mirror lcd-preflight.ts:114-121: when ANY message in a step is a floor, the WHOLE step
  // is a floor (kept unconditionally, never a relevance candidate). stepFloorIds holds the
  // identity of every BudgetItem in a floor-containing step.
  const stepFloorIds = expandFloorsToStepIds(historyItems, isMessageFloor);
  const isFloor = (it: BudgetItem): boolean => stepFloorIds.has(it);

  // The non-floor history band (the relevance-evictable middle, T1/T2) — fed to the
  // step-atomic recency fill within its slot. NB (C2 boundary / Open Question 3): the
  // WITHIN-history relevance eviction of this middle band is Phase 174 (DEPTH-01); here
  // the arbiter ALLOCATES the discretionary pool across tiers by fused rank with the
  // floors guaranteed and keeps the history slot RECENCY-ordered. Do NOT relevance-evict
  // the middle band here. Because floors are STEP-atomic (above), middleBand contains only
  // WHOLE non-floor steps — groupIntoSteps over it reproduces the true history grouping.
  const middleBand = historyItems.filter((it) => !isFloor(it));

  // -------------------------------------------------------------------------
  // 2. Allocate the discretionary pool across tiers.
  //
  // Per-tier minimum slots: reserve a slot for each REPRESENTED tier (history middle
  // band, LTM, KG) so a single high-rank LTM fact is never starved by a long history
  // band, and the recent-history slot is never starved by a flood of LTM candidates.
  // The pool is split into per-tier sub-budgets that NEVER sum above poolTokens.
  // -------------------------------------------------------------------------
  let remainingPool = Math.max(0, poolTokens);
  let poolTokensUsed = 0;

  // --- Tier: LTM (T3) — fused by rank (RRF), never raw score. ---
  const keptLtmIds: string[] = [];
  if (ltmCandidates.length > 0 && remainingPool > 0) {
    const fusedLtm = scorer(ltmCandidates, query, scorerOptions); // RRF rank order
    let ltmSlots = 0;
    for (const cand of fusedLtm) {
      const cost = ltmTokensPerCandidate;
      // Per-tier minimum slot: always admit at least `minTierSlots` if any pool remains;
      // beyond that, admit only while the running cost stays within the pool.
      const withinSlotFloor = ltmSlots < minTierSlots;
      if (cost <= remainingPool || (withinSlotFloor && cost === 0)) {
        if (cost > remainingPool) break; // cannot fit even the slot-floor candidate
        keptLtmIds.push(cand.entry.id);
        remainingPool -= cost;
        poolTokensUsed += cost;
        ltmSlots++;
      } else {
        break; // fused-rank order: once one does not fit, neither do the lower ranks
      }
    }
  }

  // --- Tier: KG (T4) — fused by rank (RRF). ---
  const keptKgIds: string[] = [];
  if (kgCandidates.length > 0 && remainingPool > 0) {
    const fusedKg = scorer(kgCandidates, query, scorerOptions);
    let kgSlots = 0;
    for (const cand of fusedKg) {
      const cost = kgTokensPerCandidate;
      const withinSlotFloor = kgSlots < minTierSlots;
      if (cost <= remainingPool || (withinSlotFloor && cost === 0)) {
        if (cost > remainingPool) break;
        keptKgIds.push(cand.entry.id);
        remainingPool -= cost;
        poolTokensUsed += cost;
        kgSlots++;
      } else {
        break;
      }
    }
  }

  // --- Tier: history middle band (T1/T2) — recency-ordered, step-atomic fill. ---
  // REUSE evictHistoryUnderBudget (the tested pure step-atomic allocator) over the
  // REMAINING pool so the kept history is the newest whole steps that fit AND a
  // tool_use/tool_result pair is never split (the load-bearing pair-atomicity rule).
  // History is the FINAL tier — it consumes whatever pool the LTM/KG tiers left, so
  // `remainingPool` is not decremented again after this (it is the last reader).
  const keptMiddle = evictHistoryUnderBudget(middleBand, remainingPool);
  // WR-04 (Phase 173-05): bill the kept middle band from ACTUAL set membership, not the
  // positional `sumKeptTokens(band, count)` shortcut. With STEP-atomic floors (above) the
  // two now agree, but membership is the honest accounting (it sums the tokens of the exact
  // BudgetItems whose msg is in keptMiddle) and cannot drift if step boundaries ever shift —
  // so `poolTokensUsed` always equals the true discretionary consumption (the RETR-02 claim).
  const keptMiddleSetForTokens = new Set<AgentMessage>(keptMiddle);
  const keptMiddleTokens = middleBand.reduce(
    (sum, it) => (keptMiddleSetForTokens.has(it.msg) ? sum + it.tokens : sum),
    0,
  );
  poolTokensUsed += keptMiddleTokens;

  // -------------------------------------------------------------------------
  // 3. Stitch the kept history back together in ORIGINAL order: every floor item
  //    (unconditional) plus the kept middle-band items, preserving historyItems order
  //    (so the budget/eviction overlap math and transcript repair downstream stay
  //    coherent). Floors that were excluded from the relevance band are re-admitted here.
  // -------------------------------------------------------------------------
  const keptMiddleSet = new Set<AgentMessage>(keptMiddle);
  const kept: AgentMessage[] = [];
  let historyKeptCount = 0;
  for (const it of historyItems) {
    if (isFloor(it) || keptMiddleSet.has(it.msg)) {
      kept.push(it.msg);
      historyKeptCount++;
    }
  }

  return {
    kept,
    perTierKept: {
      history: historyKeptCount,
      ltm: keptLtmIds.length,
      kg: keptKgIds.length,
    },
    poolTokensUsed,
    keptLtmIds,
    keptKgIds,
  };
}

/**
 * Read a message's `role` without widening to the concrete pi-ai union (mirrors
 * `lcd-budget-eviction.roleOf` — the step grouper's role accessor).
 */
function roleOf(it: BudgetItem): string | undefined {
  return (it.msg as unknown as { role?: string }).role;
}

/**
 * WR-04 (Phase 173-05): expand a per-MESSAGE floor predicate to STEP granularity. Walks
 * `historyItems` into the SAME steps the eviction step grouper uses (a step starts at any
 * non-`toolResult` message and absorbs the immediately-following `toolResult`s — the
 * inseparable result tail of an assistant `tool_use`), and returns the identity set of EVERY
 * BudgetItem belonging to a step that contains at least one message-level floor. Mirrors
 * `lcd-preflight.ts:114-121` (a pinned item makes its whole step survive harder eviction)
 * and `lcd-budget-eviction.groupIntoSteps`. Pure: reads the input, mutates nothing.
 */
function expandFloorsToStepIds(
  historyItems: BudgetItem[],
  isMessageFloor: (it: BudgetItem) => boolean,
): Set<BudgetItem> {
  const stepFloorIds = new Set<BudgetItem>();
  let i = 0;
  while (i < historyItems.length) {
    const start = i;
    i++;
    // Absorb the trailing toolResults bound to this step's leading message.
    while (i < historyItems.length && roleOf(historyItems[i]!) === "toolResult") {
      i++;
    }
    // The step spans [start, i). If ANY message in it is a message-level floor, the
    // WHOLE step is a floor (kept whole; never a relevance candidate).
    let stepHasFloor = false;
    for (let j = start; j < i; j++) {
      if (isMessageFloor(historyItems[j]!)) {
        stepHasFloor = true;
        break;
      }
    }
    if (stepHasFloor) {
      for (let j = start; j < i; j++) stepFloorIds.add(historyItems[j]!);
    }
  }
  return stepFloorIds;
}
