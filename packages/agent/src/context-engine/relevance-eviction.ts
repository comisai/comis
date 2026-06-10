// SPDX-License-Identifier: Apache-2.0
/**
 * DEPTH-01 — cache-stable relevance eviction of the evictable middle band.
 *
 * The relevance-ranked replacement for the pure-recency middle-band fill at the
 * `margin-arbiter.ts:296` seam (`evictHistoryUnderBudget(middleBand, remainingPool)`). Where
 * the recency allocator keeps the NEWEST whole steps that fit, {@link rankMiddleBandByRelevance}
 * scores ONLY the unpinned evictable middle band by RELEVANCE, keeps the top set under the
 * pool, and RESTORES chronological order before assembly. The relevance ranking drives
 * SELECTION only — never output order (the downstream assembler assumes chronological order:
 * transcript repair + breakpoint math).
 *
 * Cache stability (the LOCKED #1 / lossless-claw §6.3 mistake to avoid — CONSERVATIVE gate):
 *   - `supportsPromptCache === true` → DO NOT reorder. Return the recency fill
 *     (`evictHistoryUnderBudget`) so the cached prefix is byte-stable. A caching profile keeps
 *     recency above the cache fence; the "re-rank below the fence" sub-case is NOT built (the
 *     dag path has no meaningful fence — `lastBreakpointIndex` is undefined at
 *     `lcd-assembler.ts:146`, and small/nano + caching already resolves `relevanceFirst=false`
 *     upstream, so this pass is reached for a caching profile only via an explicit
 *     `firstByDefault` override, where recency is the safe behavior).
 *   - `supportsPromptCache === false` (the typical local small/nano relevance-first
 *     population) → re-rank the full evictable band freely.
 *
 * Pinned survival (DEPTH-01 success criterion #2 / RETR-05): the middle band ALREADY excludes
 * S4 pins by construction (`margin-arbiter.ts:235`, step-atomic via `expandFloorsToStepIds`),
 * so the band this pass receives is pin-free. As DEFENSE-IN-DEPTH (the S4 suite extends to
 * eviction), if a security-marked message nonetheless reaches the band (markers threaded), it
 * is separated out as an UNCONDITIONAL survivor (mirroring the arbiter's floor handling) and
 * is NEVER subject to the relevance budget — a relevance score can never evict a pin.
 *
 * Degrade floor: an empty band, an absent `contextStore`/`relevanceScorer`, a `degraded`
 * (low-signal) query, or a zero-hit FTS search all fall back to the deterministic recency fill
 * (`evictHistoryUnderBudget`) — never throws. This makes the pass safe-by-construction on every
 * non-relevance-first path it might be reached from.
 *
 * Architecture cuts (this module lives in `context-engine/` and obeys TWO cuts):
 *   - agent↛memory: it imports only `@comis/core` TYPES + in-package context-engine modules —
 *     never `@comis/memory` (forbidden by `test/architecture` "agent → memory"). The store
 *     arrives as the core `ContextStorePort` TYPE only (injected via `deps.contextStore`).
 *   - I2 (context-engine ↮ rag): the shared relevance scorer (`rag/relevance-scorer.ts`) is
 *     NOT imported — it is INJECTED as `deps.relevanceScorer` (DI at the budget boundary), and
 *     the `ArbiterRelevanceQuery`/`RelevanceScorerFn` shapes are the LOCAL structural contracts
 *     declared in `margin-arbiter.ts` (the rag types are structurally compatible). This is the
 *     exact cut that bit 173-03 — the relevance scorer is INJECTED, never imported.
 *
 * Purity: no clock, no globals, no mutation of the input arrays; the ONLY I/O is the injected
 * `contextStore.searchLcd` read. Same input → same output (the FTS read is deterministic for a
 * fixed store + query). The `searchLcd` snippet is UNTRUSTED — it is used ONLY transiently to
 * associate a band message with its BM25 rank position and is NEVER logged or returned
 * (T-174-01-03); only the resulting ordinal rank drives selection.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextStoreScope, LcdSearchHit, MemorySearchResult } from "@comis/core";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import type { ArbiterRelevanceQuery } from "./margin-arbiter.js";
import { isSecurityRelevantMessage } from "./security-context-pinner.js";
import type { ContextEngineDeps } from "./types.js";

/**
 * Rank the evictable middle band by relevance, keep the top set under `poolTokens`, and
 * return the kept messages in CHRONOLOGICAL (input) order — the cache-stable, step-atomic,
 * pin-protecting replacement for the recency `evictHistoryUnderBudget(middleBand, poolTokens)`
 * at the margin-arbiter middle-band seam.
 *
 * @param deps - the context-engine deps (modelProfile, relevanceScorer, contextStore, R4 scope).
 * @param middleBand - the evictable (already pin-free by construction) history band + tokens.
 * @param poolTokens - the discretionary pool the middle band may consume (post-floors).
 * @param liveMessages - the live message array (reserved for query construction at the seam).
 * @param query - the relevance query (degraded → recency floor).
 * @returns the kept middle-band messages in chronological order (selection reorders; output does not).
 */
export function rankMiddleBandByRelevance(
  deps: ContextEngineDeps,
  middleBand: BudgetItem[],
  poolTokens: number,
  _liveMessages: AgentMessage[],
  query: ArbiterRelevanceQuery,
): AgentMessage[] {
  // --- Cache gate (CONSERVATIVE — LOCKED #1): a caching profile keeps recency. ---
  // Reordering above the cache fence shreds the KV cache (the lossless-claw §6.3 mistake).
  // Returning the recency fill keeps the cached prefix byte-stable.
  if (deps.modelProfile?.supportsPromptCache === true) {
    return evictHistoryUnderBudget(middleBand, poolTokens);
  }

  // --- Degrade floor: empty band / no store / no scorer / degraded query → recency. ---
  const store = deps.contextStore;
  const scorer = deps.relevanceScorer;
  if (middleBand.length === 0 || store === undefined || scorer === undefined || query.degraded) {
    return evictHistoryUnderBudget(middleBand, poolTokens);
  }

  // --- Pinned survival (DEFENSE-IN-DEPTH, RETR-05): separate any security-marked item out
  //     of the relevance-evictable set as an UNCONDITIONAL survivor (never budget-evicted).
  //     The band is already pin-free by construction (margin-arbiter.ts:235); this is the
  //     S4-extends-to-eviction backstop. Identity-tracked so the chronological restore re-admits
  //     it regardless of the relevance budget. ---
  const markers = deps.securityPinMarkers;
  const pinnedMsgs = new Set<AgentMessage>();
  const evictableBand: BudgetItem[] = [];
  for (const it of middleBand) {
    if (
      markers !== undefined &&
      isSecurityRelevantMessage(it.msg as { content?: unknown; role?: string }, markers)
    ) {
      pinnedMsgs.add(it.msg);
    } else {
      evictableBand.push(it);
    }
  }

  // --- FTS-the-band: rank the evictable band by BM25 relevance. ---
  // The R4 scope is built from the same deps the assembler uses (WR-02 agent/tenant isolation).
  // searchLcd returns BM25-`rank`ed hits best-first; the per-item rank is the position of the
  // first hit whose (untrusted) snippet contains the band item's rendered text. Unmatched items
  // rank WORST (after every matched item) — they fall back to recency within the chronological
  // restore. NB: the snippet is read ONLY for this transient association, never logged/returned.
  const scope: ContextStoreScope = {
    conversationId: deps.conversationId ?? "",
    agentId: deps.agentId ?? "",
    tenantId: deps.tenantId ?? "",
    sessionKey: deps.sessionKey ?? deps.conversationId ?? "",
  };
  // OR-join the (already alphanumeric, stopworded) terms so ANY term match ranks a message
  // (FTS5 MATCH of space-separated terms is implicit AND — an AND of the whole query almost
  // never matches a single historical message, which would silently degrade the pass to
  // recency, the CR-01 no-op trap). The terms come from buildAssemblyRelevanceQuery's
  // tokenizer (quotes + non-\p{L}\p{N} already stripped), so the bare ` OR ` is FTS5-safe.
  const ftsQuery = query.terms.join(" OR ");
  const result = store.searchLcd(scope, ftsQuery, {
    limit: Math.max(1, evictableBand.length),
    scope: "messages",
  });
  const hits = result.hits;
  if (hits.length === 0) {
    // No FTS signal → deterministic recency floor over the FULL band (pins included).
    return evictHistoryUnderBudget(middleBand, poolTokens);
  }

  // Per-item relevance ordinal: lower = more relevant (best-first hit position). Unmatched →
  // a large sentinel so matched items always outrank them; ties broken by chronological index
  // so the order is total + deterministic.
  const relevanceOrdinal = (it: BudgetItem): number => matchHitPosition(it.msg, hits);

  // Project the evictable band into a SINGLE FTS lane (MemorySearchResult-shaped), ordered
  // best-first by the FTS ordinal, keyed by a synthetic per-band index id. The INJECTED scorer
  // fuses the single lane (single-lane identity preserves order + reuses the BM25/RRF floor) —
  // we never re-implement BM25 and never import rag. We then map the fused ids back to band
  // items to get the relevance SELECTION order.
  const idToItem = new Map<string, BudgetItem>();
  const lane: MemorySearchResult[] = evictableBand
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const ra = relevanceOrdinal(a.it);
      const rb = relevanceOrdinal(b.it);
      if (ra !== rb) return ra - rb; // more relevant first
      return a.idx - b.idx; // tie → chronological (stable, deterministic)
    })
    .map(({ it, idx }) => {
      const id = `band-${idx}`;
      idToItem.set(id, it);
      // content is intentionally empty — the scorer ranks the pre-ordered single FTS lane by
      // position (single-lane identity), it does not re-tokenize content here (I2 cut clean).
      return { entry: { id, content: "" } as MemorySearchResult["entry"], score: undefined };
    });

  const fused = scorer([{ results: lane, weight: 1 }], query, {
    logger: deps.logger,
    agentId: deps.agentId,
  });

  // --- Select under budget by relevance order. Admit EVICTABLE items greedily while the
  //     running token estimate ≤ pool (pins do NOT consume the pool — they ride on top). ---
  const admittedEvictable = new Set<AgentMessage>();
  let used = 0;
  const tokensByMsg = new Map<AgentMessage, number>(evictableBand.map((it) => [it.msg, it.tokens]));
  for (const cand of fused) {
    const it = idToItem.get(cand.entry.id);
    if (it === undefined) continue;
    const cost = tokensByMsg.get(it.msg) ?? 0;
    if (used + cost > poolTokens) continue; // skip what does not fit; a smaller later item may
    admittedEvictable.add(it.msg);
    used += cost;
  }

  // --- Enforce STEP atomicity over the budget-selected EVICTABLE set (load-bearing). ---
  // Build the chronological subsequence of the FULL middle band whose WHOLE step contains a
  // budget-admitted evictable message (so a tool_use/tool_result pair is kept-or-dropped
  // together — never a lone toolResult), then feed it back through evictHistoryUnderBudget so
  // the kept evictable set is pair-atomic AND ≤ pool.
  const chronoAdmitted = wholeStepsContaining(middleBand, admittedEvictable);
  const keptEvictable = new Set<AgentMessage>(evictHistoryUnderBudget(chronoAdmitted, poolTokens));

  // --- Stitch the kept history in ORIGINAL order: pins (UNCONDITIONAL, ride on top of the
  //     pool — a relevance score can never evict a pin, RETR-05) PLUS the kept evictable set,
  //     preserving middleBand order. The relevance pass drove SELECTION; output is chronological. ---
  const kept: AgentMessage[] = [];
  for (const it of middleBand) {
    if (pinnedMsgs.has(it.msg) || keptEvictable.has(it.msg)) {
      kept.push(it.msg);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Internals (pure)
// ---------------------------------------------------------------------------

/**
 * The relevance ordinal for a band message: the position (0-based, best-first) of the FIRST
 * FTS hit whose snippet contains the message's rendered text. Returns a large sentinel when no
 * hit matches (so matched items always outrank unmatched ones). The snippet is the message's
 * FTS-rendered text on the FTS path (`lcd-fts.ts` `content AS snippet`) — used here ONLY for
 * the transient match (never logged/returned). A blank rendering never matches (→ sentinel).
 */
function matchHitPosition(msg: AgentMessage, hits: LcdSearchHit[]): number {
  const text = renderMessageText(msg).trim();
  if (text.length === 0) return Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < hits.length; i++) {
    const snippet = hits[i]!.snippet;
    if (snippet.length > 0 && snippet.includes(text)) return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Render a message's content to plain text for the FTS-hit association (mirrors the
 * `security-context-pinner.extractText` shape — string content, or the concatenated `text`/
 * `content` fields of an array of blocks). Pure; never throws.
 */
function renderMessageText(msg: AgentMessage): string {
  const content = (msg as unknown as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block !== null && typeof block === "object") {
          const b = block as { text?: unknown; content?: unknown };
          if (typeof b.text === "string") return b.text;
          if (typeof b.content === "string") return b.content;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

/**
 * Walk `middleBand` into STEPS (a step starts at any non-`toolResult` message and absorbs the
 * immediately-following `toolResult`s — the inseparable result tail of an assistant `tool_use`,
 * mirroring `lcd-budget-eviction.groupIntoSteps`) and return, in chronological order, every
 * BudgetItem of a step that contains at least one admitted message. This guarantees the final
 * `evictHistoryUnderBudget` over the result never sees a lone `toolResult` (step atomicity) and
 * preserves the input order. Pure: reads the input, mutates nothing.
 */
function wholeStepsContaining(
  middleBand: BudgetItem[],
  admitted: ReadonlySet<AgentMessage>,
): BudgetItem[] {
  const out: BudgetItem[] = [];
  let i = 0;
  while (i < middleBand.length) {
    const start = i;
    i++;
    while (i < middleBand.length && roleOf(middleBand[i]!.msg) === "toolResult") {
      i++;
    }
    let stepAdmitted = false;
    for (let j = start; j < i; j++) {
      if (admitted.has(middleBand[j]!.msg)) {
        stepAdmitted = true;
        break;
      }
    }
    if (stepAdmitted) {
      for (let j = start; j < i; j++) out.push(middleBand[j]!);
    }
  }
  return out;
}

/** Read a message's `role` without widening to the concrete pi-ai union. */
function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}
