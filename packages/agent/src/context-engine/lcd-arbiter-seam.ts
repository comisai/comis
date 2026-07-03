// SPDX-License-Identifier: Apache-2.0
/**
 * The relevance-first eviction seam, extracted from `lcd-assembler.ts`
 * so the assembler stays under the 800-line file-size cap (the "keep the body THIN" rule;
 * mirrors `recall-provenance.ts` / `lcd-store-provenance.ts` extractions). The assembler
 * CALLS {@link evictUnderArbiter} on the relevance-first path and keeps the verbatim
 * `evictHistoryUnderBudget` call on the frontier/mid path (a locked byte-identical contract).
 *
 * This module wraps the pure {@link marginArbitrate} allocator with the assembly-path
 * glue: it separates the security-pinned items out of the relevance-evictable
 * band as unconditional floors (mirroring `lcd-preflight.ts:114-121`), passes EMPTY LTM/KG
 * candidate lanes (the assembler holds no cross-session LTM; the recall
 * path owns LTM ranking), and builds the relevance query for the arbiter.
 *
 * Architecture cuts: lives in `context-engine/`, imports only `@comis/core` types +
 * in-package context-engine modules — never `@comis/memory` (agent↛memory) and never the
 * `rag/` layer (the context-engine ↮ rag cut). The relevance scorer is INJECTED
 * (`deps.relevanceScorer`); on the
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
import { rankMiddleBandByRelevance } from "./relevance-eviction.js";
import type { BudgetItem } from "./lcd-budget-eviction.js";
import { CHARS_PER_TOKEN_RATIO } from "./constants.js";
import type { ContextEngineDeps } from "./types.js";

/**
 * The absent-dep fallback scorer: an empty-result identity used ONLY when no `relevanceScorer`
 * dep is threaded. The real injected `scoreRelevance` IS reachable —
 * the middle-band relevance pass (`rankMiddleBandByRelevance`, injected below as the
 * `middleBandRanker`) calls it over the FTS-the-band lane to re-rank the evictable middle band.
 * This noop remains the safe fallback for the (unit / mis-wired) case where the scorer dep is
 * absent: `rankMiddleBandByRelevance` ALSO degrades to the recency fill when `relevanceScorer`
 * is undefined, so a missing scorer can never break assembly. On the assembly path the
 * LTM/KG candidate lanes are still EMPTY (the recall path owns LTM ranking), so the per-tier
 * `length > 0` guards keep the scorer out of the LTM/KG lanes — its live caller is the
 * middle-band pass, not the cross-session tiers.
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
 * content-free `context:arbitrated` observability event.
 *
 * Security-pinned items (detected fail-closed by `isSecurityRelevantMessage`
 * against `deps.securityPinMarkers`) are excluded from the relevance-evictable band and
 * passed as UNCONDITIONAL floors. When no markers are threaded, nothing is pinned here
 * (the pre-flight harder-eviction remains the backstop).
 *
 * The event carries per-tier kept COUNTS + the discretionary pool TOKENS (OFFERED via
 * `discretionaryPoolTokens` AND CONSUMED via `poolTokensUsed`) + the floor-token
 * weight + the kept LTM/KG ids + the relevanceFirst BOOLEAN + a timestamp ONLY —
 * NEVER message/memory/query content (AGENTS.md §2.2/§2.7; ids are opaque
 * memory keys). Reuses the caller's entry-clock read `startMs` (no new ambient clock —
 * the globals gate). Frontier/mid never call this → the event never fires for them.
 *
 * @param deps - the context-engine deps (relevanceScorer, securityPinMarkers, eventBus).
 * @param evictable - the evictable history band (T0/T1/T2) with supplied tokens.
 * @param poolTokens - the discretionary pool (budget.availableHistoryTokens).
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
  // Build the live relevance query from the last ~3 user turns of liveMessages
  // (the within-history relevance signal) and inject the cache-stable middle-band ranker.
  const query = buildAssemblyRelevanceQuery(liveMessages);
  const arbitrated = marginArbitrate({
    historyItems: evictable,
    ltmCandidates: [], // the assembler holds no LTM candidates (recall owns LTM)
    kgCandidates: [], // no KG candidates on the assembly path
    floors: { freshTailItems: [], pinnedItems },
    poolTokens,
    scorer: deps.relevanceScorer ?? NOOP_RELEVANCE_SCORER,
    query,
    // The within-history relevance pass. evictUnderArbiter holds `deps` +
    // `liveMessages`, so it constructs the ranker here and passes it as an injected dep —
    // keeping marginArbitrate PURE and the context-engine ↮ rag cut intact (the relevance
    // scorer is INJECTED into rankMiddleBandByRelevance via deps.relevanceScorer, never
    // imported by it).
    middleBandRanker: (band, pool) => rankMiddleBandByRelevance(deps, band, pool, liveMessages, query),
  });
  deps.eventBus?.emit("context:arbitrated", {
    agentId: deps.agentId ?? "",
    sessionKey: deps.sessionKey ?? "",
    perTierKept: arbitrated.perTierKept,
    // discretionaryPoolTokens = OFFERED; poolTokensUsed = CONSUMED. The arbiter
    // already computes both + the floor weight + the cross-tier winner ids — surface them
    // all (content-free) instead of dropping them at the emit boundary.
    discretionaryPoolTokens: poolTokens,
    poolTokensUsed: arbitrated.poolTokensUsed,
    floorTokens: arbitrated.floorTokensUsed,
    keptLtmIds: arbitrated.keptLtmIds,
    keptKgIds: arbitrated.keptKgIds,
    relevanceFirst: true,
    timestamp: startMs,
  });
  return { budgeted: arbitrated.kept };
}

/**
 * Emit the EXISTING content-free `context:evicted` event from the LCD eviction seam
 * (parity with the pipeline engine) when eviction actually dropped history — shared by BOTH
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
 * Build the within-history relevance query for the assembly-path middle-band pass.
 *
 * The query is the content terms of the last ~{@link RELEVANCE_TURN_WINDOW} USER turns of the
 * live message array (the live intent the middle-band relevance ranking matches against), with
 * a small deictic stopword set dropped and the newest turn's terms first. It is `degraded`
 * (low-signal → the ranker falls back to recency) when fewer than 2 content terms remain.
 *
 * The context-engine ↮ rag cut forbids importing `rag/relevance-scorer`'s
 * `buildRelevanceQuery`, so the minimal tokenize+stopword is replicated LOCALLY here (pure
 * string work, the same carve-out as the local `ArbiterRelevanceQuery` structural type). The
 * scorer's own low-signal fallback (the injected `scoreRelevance`) covers a degraded query, and
 * `rankMiddleBandByRelevance` short-circuits to recency on `degraded`, so a thin query is safe.
 * The LTM/KG lanes remain EMPTY on the assembly path, so this query feeds ONLY the
 * middle-band relevance pass (the cross-tier LTM ranking lives on the recall side).
 */
function buildAssemblyRelevanceQuery(liveMessages: AgentMessage[]): ArbiterRelevanceQuery {
  const userTexts: string[] = [];
  for (const m of liveMessages) {
    if ((m as { role?: string }).role !== "user") continue;
    userTexts.push(extractUserText((m as { content?: unknown }).content));
  }
  const window = userTexts.slice(-RELEVANCE_TURN_WINDOW);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (let i = window.length - 1; i >= 0; i--) {
    for (const tok of tokenizeQuery(window[i] ?? "")) {
      if (ASSEMBLY_STOPWORDS.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      terms.push(tok);
    }
  }
  return { terms, degraded: terms.length < 2 };
}

/** The number of most-recent user turns the within-history query draws from (mirrors the rag
 *  scorer's RELEVANCE_TURN_WINDOW; replicated locally for the context-engine ↮ rag cut). */
const RELEVANCE_TURN_WINDOW = 3;

/**
 * A small deictic/filler stopword set (the rag scorer's compact set, replicated for the
 * context-engine ↮ rag cut — bounded static map, not a generated stoplist). All lowercase.
 *
 * SOURCE OF TRUTH: `STOPWORDS` in `packages/agent/src/rag/relevance-scorer.ts`
 * is the canonical stoplist. This is a DELIBERATE carve-out copy (the context-engine must NOT
 * import the rag tokenizer), so the two lists can drift; keep this subset in sync
 * with the rag one when changing either, and prefer the rag list as the reference. This list is
 * the one feeding the LIVE FTS query (terms OR-joined into `lcd_messages_fts MATCH`).
 *
 * FTS5 OPERATOR GUARD: `near` / `and` / `or` / `not` are stopped UNCONDITIONALLY so the
 * OR-join (`relevance-eviction.ts:132`) can never splice a bare FTS5 operator keyword into the
 * MATCH query (which could subtly alter FTS5 parsing). `tokenizeQuery` already strips quotes +
 * non-`\p{L}\p{N}`, so this stoplist is the remaining FTS5-safety surface.
 */
const ASSEMBLY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those", "it", "is", "are", "was", "were", "be",
  "do", "does", "did", "can", "could", "will", "would", "should", "but", "if",
  "so", "of", "to", "in", "on", "at", "by", "for", "with", "from", "yes", "no", "ok",
  "please", "just", "now", "here", "there", "what", "which", "how", "you", "i", "me", "my",
  // FTS5 operator keywords — stopped so a bare operator can never reach the MATCH query.
  "near", "and", "or", "not",
]);

/** Lowercase + Unicode-aware tokenize (the buildFtsQuery shape; replicated for the
 *  context-engine ↮ rag cut). */
function tokenizeQuery(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/"/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Extract plain text from a user message's content (string or array of blocks). Pure. */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block !== null && typeof block === "object") {
          const b = block as { text?: unknown };
          if (typeof b.text === "string") return b.text;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}
