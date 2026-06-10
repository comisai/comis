// SPDX-License-Identifier: Apache-2.0
/**
 * RETR-02/03/05 — the relevance-first eviction seam, extracted from `lcd-assembler.ts`
 * so the assembler stays under the 800-line file-size cap (the "keep the body THIN" rule;
 * mirrors `recall-provenance.ts` / `lcd-store-provenance.ts` extractions). The assembler
 * CALLS {@link evictUnderArbiter} on the relevance-first path and keeps the verbatim
 * `evictHistoryUnderBudget` call on the frontier/mid path (byte-identical, LOCKED #2).
 *
 * This module wraps the pure {@link marginArbitrate} allocator with the assembly-path
 * glue: it separates the S4 security-pinned items (RETR-05) out of the relevance-evictable
 * band as unconditional floors (mirroring `lcd-preflight.ts:114-121`), passes EMPTY LTM/KG
 * candidate lanes (the C2 boundary — the assembler holds no cross-session LTM; the recall
 * path owns LTM ranking), and builds the relevance query for the arbiter.
 *
 * Architecture cuts: lives in `context-engine/`, imports only `@comis/core` types +
 * in-package context-engine modules — never `@comis/memory` (agent↛memory) and never the
 * `rag/` layer (I2). The relevance scorer is INJECTED (`deps.relevanceScorer`); on the C2
 * assembly path the LTM/KG lanes are empty so the scorer is never actually invoked.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isSecurityRelevantMessage } from "./security-context-pinner.js";
import {
  marginArbitrate,
  type ArbiterRelevanceQuery,
  type RelevanceScorerFn,
} from "./margin-arbiter.js";
import type { BudgetItem } from "./lcd-budget-eviction.js";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";
import type { ContextEngineDeps } from "./types.js";

/**
 * Fallback scorer used ONLY when no `relevanceScorer` dep is threaded. On the C2 assembly
 * path the LTM/KG candidate lanes are EMPTY (the recall path owns LTM ranking), so the
 * arbiter never invokes the scorer — the history band is allocated recency-ordered within
 * its slot. The real `scoreRelevance` is injected from `executor/` (which may import the
 * rag layer) for forward-compat when LTM candidates flow to assembly (Phase 174).
 */
const NOOP_RELEVANCE_SCORER: RelevanceScorerFn = () => [];

/** What {@link evictUnderArbiter} returns — only the kept history (the content-free
 *  context:arbitrated event is emitted INSIDE this seam, so the assembler stays thin). */
export interface ArbiterSeamResult {
  /** The kept history messages (floors + discretionary band), in original order. */
  budgeted: AgentMessage[];
}

/**
 * Run the margin arbiter at the eviction seam for a relevance-first class, and emit the
 * content-free `context:arbitrated` Glass-Box event.
 *
 * RETR-05: S4 security-pinned items (detected fail-closed by `isSecurityRelevantMessage`
 * against `deps.securityPinMarkers`) are excluded from the relevance-evictable band and
 * passed as UNCONDITIONAL floors. When no markers are threaded, nothing is pinned here
 * (the pre-flight harder-eviction remains the backstop).
 *
 * RETR-02 event: per-tier kept COUNTS + the discretionary pool TOKENS + the relevanceFirst
 * BOOLEAN + ids/timestamp ONLY — NEVER message/memory/query content (AGENTS.md §2.2/§2.7;
 * T-173-03-04). Reuses the caller's entry-clock read `startMs` (no new ambient clock —
 * the globals gate). Frontier/mid never call this → the event never fires for them.
 *
 * @param deps - the context-engine deps (relevanceScorer, securityPinMarkers, eventBus).
 * @param evictable - the evictable history band (T0/T1/T2) with supplied tokens.
 * @param poolTokens - the discretionary pool (budget.availableHistoryTokens, post-Fix-3).
 * @param liveMessages - the live message array (source of the relevance query).
 * @param startMs - the assembler's entry-clock read, reused for the event timestamp.
 * @returns the kept history (the event is emitted as a side effect).
 */
export function evictUnderArbiter(
  deps: ContextEngineDeps,
  evictable: BudgetItem[],
  poolTokens: number,
  liveMessages: AgentMessage[],
  startMs: number,
): ArbiterSeamResult {
  const markers = deps.securityPinMarkers;
  const pinnedItems = markers
    ? evictable.filter((it) =>
        isSecurityRelevantMessage(it.msg as { content?: unknown; role?: string }, markers),
      )
    : [];
  const arbitrated = marginArbitrate({
    historyItems: evictable,
    ltmCandidates: [], // C2: the assembler holds no LTM candidates (recall owns LTM)
    kgCandidates: [], // C2: no KG candidates on the assembly path
    floors: { freshTailItems: [], pinnedItems },
    poolTokens,
    scorer: deps.relevanceScorer ?? NOOP_RELEVANCE_SCORER,
    query: buildAssemblyRelevanceQuery(liveMessages),
  });
  deps.eventBus?.emit("context:arbitrated", {
    agentId: deps.agentId ?? "",
    sessionKey: deps.sessionKey ?? "",
    perTierKept: arbitrated.perTierKept,
    discretionaryPoolTokens: poolTokens,
    relevanceFirst: true,
    timestamp: startMs,
  });
  return { budgeted: arbitrated.kept };
}

/**
 * Emit the EXISTING content-free `context:evicted` event from the LCD eviction seam (O1;
 * parity with the pipeline engine) when eviction actually dropped history — shared by BOTH
 * the recency and the arbiter paths. `evictedChars` is derived ONLY from each dropped item's
 * pre-computed `tokens` (× CHARS_PER_TOKEN_RATIO) — the message text is NEVER read or emitted
 * (AGENTS.md §2.2 / the lossless store). Reuses the caller's entry-clock `startMs` (no new
 * clock read; the globals gate bans ambient time). No-op when nothing was dropped.
 *
 * @param deps - the context-engine deps (eventBus, agentId, sessionKey).
 * @param evictable - the evictable history band (its tail beyond keptCount was dropped).
 * @param keptCount - how many evictable items were kept (the rest are the dropped prefix).
 * @param startMs - the assembler's entry-clock read, reused for the event timestamp.
 */
export function emitEvictedEvent(
  deps: ContextEngineDeps,
  evictable: BudgetItem[],
  keptCount: number,
  startMs: number,
): void {
  const droppedCount = evictable.length - keptCount;
  if (droppedCount <= 0) return;
  const droppedItems = evictable.slice(keptCount);
  const evictedChars = droppedItems.reduce(
    (sum, it) => sum + Math.round(it.tokens * CHARS_PER_TOKEN_RATIO),
    0,
  );
  deps.eventBus?.emit("context:evicted", {
    agentId: deps.agentId ?? "",
    sessionKey: deps.sessionKey ?? "",
    evictedCount: droppedCount,
    evictedChars,
    categories: { lcd_history: droppedCount },
    timestamp: startMs,
  });
}

/**
 * Build the relevance query for the assembly-path arbiter.
 *
 * C2 boundary: on the assembly path the LTM/KG lanes are EMPTY, so the query is not
 * actually consumed by the arbiter (the history band is recency-ordered within its slot;
 * the cross-tier LTM ranking — where the query matters — lives on the recall side). A
 * `degraded` query is therefore both correct and honest here: it signals "no cross-tier
 * relevance ranking on this path." This avoids duplicating the rag tokenizer in the
 * context-engine (the I2 cut forbids importing `rag/relevance-scorer`'s buildRelevanceQuery).
 * When Phase 174 flows LTM candidates to assembly, the real query threads in via a dep.
 */
function buildAssemblyRelevanceQuery(_liveMessages: AgentMessage[]): ArbiterRelevanceQuery {
  return { terms: [], degraded: true };
}
