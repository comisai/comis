// SPDX-License-Identifier: Apache-2.0
/**
 * LCD `dag`-mode assembly engine (Phase 128 A1/A2/A4 + Phase 129 C3/A3) — the
 * corrected loop fix, now resolving `context_items` and evicting under budget.
 *
 * The deleted `dag-assembler.ts` flattened every assistant `tool_use` and every
 * `tool_result` into `content: [{ type: "text", text }]`, so the model never saw
 * a provider-valid `tool_use`<->`tool_result` pairing for its own prior action
 * and re-issued the same `read` 54 times (124 s). This module is the verbatim
 * replacement wired into the `dag` branch at `context-engine.ts`:
 *
 *  1+2. HISTORY (C3) — resolve the ordered model-facing `context_items` view: a
 *       `message`-ref reconstructs verbatim via the core `partsToMessage` codec
 *       (stable ids, the round-trip the loop bug broke); a `summary`-ref injects
 *       as a plain `user`-role text message behind `summaryRefToMessage` (the ONE
 *       Phase-130 swap point — untrusted by role, never system/assistant). Each
 *       resolved message carries its token authority (the stored `tokenCount`, or
 *       the summary's, Pitfall 2) for the budget pass.
 *  3.   FRESH TAIL — the last N STEPS of the LIVE array (an assistant message
 *       plus the tool results it triggered), sliced VERBATIM as the ORIGINAL
 *       structured blocks (never reconstructed-from-text). Never evicted (A1).
 *  4.   BUDGET + EVICTION (A3) — compute H = W − S − O − M − R via the centralized
 *       `computeTokenBudget`, then `evictHistoryUnderBudget` trims ONLY the
 *       evictable prefix (resolved history minus the items the fresh tail covers)
 *       to fit H; the fresh tail is concatenated UNCONDITIONALLY (A1/A3 — always
 *       included, even when it alone exceeds H). The prefix/fresh-tail boundary is
 *       drop-free and double-free for both L>H (mid-turn, the store lags the live
 *       array — CR-01) and L<=H (a heal shrank the live array — WR-01); transcript
 *       repair (step 6) re-pairs the seam regardless.
 *  5.   NORMALIZE — assistant string content -> `[{ type: "text", text }]`
 *       (pure, non-mutating; tool blocks untouched).
 *  6.   TRANSCRIPT REPAIR — `sanitizeToolUseResultPairing` runs LAST (A2), so the
 *       provider can never receive an unpaired/out-of-order pairing even if the
 *       history/fresh-tail seam landed mid-pair.
 *
 * Keep the body THIN (Pitfall 7): the eviction logic is Plan 04's pure module
 * (`lcd-budget-eviction.ts`) and the leaf summarization is Plan 03's; this
 * assembler only RESOLVES + CALLS them.
 *
 * Architecture cut (agent↛memory): this file imports ONLY the core
 * `ContextStorePort`/`LcdMessage`/`LcdContextItem`/`LcdSummary` TYPES + the core
 * `partsToMessage` runtime codec from `@comis/core`; it NEVER imports
 * `@comis/memory`. The concrete `createLcdStore` is injected by the daemon as
 * `ContextEngineDeps.contextStore`. This module is read-only — it NEVER appends
 * (that is the afterTurn ingest path, Plan 03).
 *
 * @module
 */

import { partsToMessage, systemNowMs } from "@comis/core";
import type {
  ContextStorePort,
  LcdContextItem,
  LcdMessage,
  LcdSummary,
} from "@comis/core";
import type { ContextEngineConfig } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import { computeTokenBudget } from "./token-budget.js";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import type { ContextEngine, ContextEngineDeps } from "./types.js";

/**
 * Build the `dag`-mode LCD `ContextEngine`. The caller (`createContextEngine`'s
 * `dag` branch) only invokes this when `deps.contextStore` AND
 * `deps.conversationId` are both wired, so both are asserted non-null here.
 *
 * @param config - the context engine config (reads `freshTailTurns` = the STEP count)
 * @param deps - the injected deps (`contextStore`, `conversationId`, `logger`, …)
 * @returns a `ContextEngine` whose `transformContext` runs the steps-1-6 assembly
 */
export function createLcdContextEngine(
  config: ContextEngineConfig,
  deps: ContextEngineDeps,
): ContextEngine {
  // Guaranteed present by the caller branch (context-engine.ts dag seam).
  const store = deps.contextStore as ContextStorePort;
  const conversationId = deps.conversationId as string;
  // Injected wall-clock (the daemon threads its ClockPort via setupContextEngine).
  // Production never reads the wall clock directly (the globals gate); `systemNowMs`
  // is the sanctioned system-clock wrapper for the no-injected-clock unit case.
  const now = (): number => (deps.clock ? deps.clock.now() : systemNowMs());

  return {
    lastBreakpointIndex: undefined,
    lastTrimOffset: 0,
    async transformContext(liveMessages: AgentMessage[]): Promise<AgentMessage[]> {
      const startMs = now();

      // 1+2. HISTORY: resolve the ordered model-facing `context_items` view (C3)
      //      into canonical messages, each paired with its token authority.
      //      `getContextItems` returns the dense, gap-free order (lazy-seeded 1:1
      //      from `lcd_messages` on first read); a `message`-ref reconstructs
      //      verbatim via the core `partsToMessage` codec (the round-trip the loop
      //      bug broke), a `summary`-ref injects as a plain user-role text message
      //      behind `summaryRefToMessage` (the ONE 130 swap point — untrusted by
      //      role, never system/assistant; T-129-14). Token authority (Pitfall 2):
      //      a message-ref carries its STORED `tokenCount` (counts F3 thinking); a
      //      summary-ref carries the summary's `tokenCount`.
      const contextItems: LcdContextItem[] = store.getContextItems(conversationId);
      const rows: LcdMessage[] = store.getMessages(conversationId);
      const rowById = new Map<string, LcdMessage>(rows.map((row) => [row.id, row]));
      const summaryById = new Map<string, LcdSummary>(
        store.getSummaries(conversationId).map((s) => [s.summaryId, s]),
      );
      const resolved: BudgetItem[] = [];
      let resolvedSummaryCount = 0;
      for (const item of contextItems) {
        const entry = resolveContextItem(item, rowById, summaryById);
        if (entry === undefined) continue; // a dangling ref (drift) is skipped, not fatal
        if (item.refKind === "summary") resolvedSummaryCount++;
        resolved.push(entry);
      }
      deps.logger.debug(
        {
          step: "lcd-resolve",
          conversationId,
          historyCount: resolved.length,
          messageRefs: resolved.length - resolvedSummaryCount,
          summaryRefs: resolvedSummaryCount,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd context_items resolved from store",
      );

      // 3. FRESH TAIL: the last N STEPS of the LIVE array, VERBATIM (original
      //    structured blocks — never reconstructed-from-text). A1.
      const tailStart = freshTailBoundaryIndex(liveMessages, config.freshTailTurns);
      const freshTail = liveMessages.slice(tailStart);
      deps.logger.debug(
        {
          step: "lcd-fresh-tail",
          freshTailSteps: config.freshTailTurns,
          freshTailCount: freshTail.length,
          tailStart,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd fresh tail sliced verbatim",
      );

      // 4. BUDGET + EVICTION (A3) at the documented seam. Compute H from the model
      //    window (W) and the system-tokens estimate (S) via the centralized
      //    `computeTokenBudget` (Pitfall 1 — never recompute W−S−O−M−R by hand),
      //    then evict the EVICTABLE PREFIX under H while the fresh tail ships
      //    UNCONDITIONALLY (A1/A3 — always included, even when the fresh tail alone
      //    exceeds H).
      //
      //    The evictable prefix is the resolved history MINUS the trailing items
      //    the fresh tail already covers. The fresh tail covers `live[tailStart..]`;
      //    the trailing `overlapCount = max(0, persistedMsgCount − tailStart)`
      //    resolved items are raw message-refs for those same recent messages
      //    (summaries only ever collapse the OLDEST run, so the tail of
      //    `context_items` is always raw). Excluding exactly those is drop-free and
      //    double-free for BOTH L>H (mid-turn: the store lags the live array by the
      //    in-flight delta, so `overlapCount` < freshTail.length and the in-flight
      //    tail rides only via `freshTail` — CR-01) and L<=H (a heal shrank the live
      //    array — WR-01). Transcript repair (step 6) re-pairs the seam regardless.
      const persistedMsgCount = rows.length;
      const overlapCount = Math.max(0, persistedMsgCount - tailStart);
      const evictable = resolved.slice(0, Math.max(0, resolved.length - overlapCount));

      const W = deps.getModel().contextWindow;
      const S = deps.getSystemTokensEstimate?.() ?? 0;
      const budget = computeTokenBudget(W, S);
      const budgeted = evictHistoryUnderBudget(evictable, budget.availableHistoryTokens);
      deps.logger.debug(
        {
          step: "lcd-evict",
          budgetTokens: budget.availableHistoryTokens,
          windowTokens: W,
          systemTokens: S,
          evictableCount: evictable.length,
          keptCount: budgeted.length,
          droppedCount: evictable.length - budgeted.length,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd history evicted under budget",
      );

      // The fresh tail is concatenated UNCONDITIONALLY (A1/A3) — never evicted.
      const assembled = [...budgeted, ...freshTail];

      // 5. NORMALIZE assistant string content to array blocks.
      const normalized = assembled.map(normalizeAssistantContent);

      // 6. TRANSCRIPT REPAIR — the FINAL step (A2). Provider-valid pairing on
      //    ANY input: out-of-order results re-placed, unpaired calls get a marked
      //    synthesized result, orphan/duplicate results dropped.
      const repaired = sanitizeToolUseResultPairing(normalized, now());

      deps.logger.info(
        {
          step: "lcd-assemble",
          durationMs: now() - startMs,
          historyCount: budgeted.length,
          freshTailCount: freshTail.length,
          assembledCount: repaired.length,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd context assembled",
      );
      return repaired;
    },
  };
}

/**
 * The index in `messages` where the fresh tail begins: the position of the Nth-
 * from-last ASSISTANT message (a STEP = one assistant message + the tool results
 * it triggered, A1 — NOT user-turns). Everything at index >= the result is the
 * verbatim fresh tail. Returns 0 when the array has fewer than N assistant
 * messages (the whole array is the fresh tail).
 *
 * @param messages - the live message array
 * @param freshTailSteps - the number of trailing STEPS to keep verbatim
 * @returns the slice-start index for the fresh tail
 */
export function freshTailBoundaryIndex(messages: AgentMessage[], freshTailSteps: number): number {
  let stepsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === "assistant") {
      stepsSeen++;
      if (stepsSeen === freshTailSteps) return i; // include this assistant + everything after
    }
  }
  return 0; // fewer than N steps — the whole array is the fresh tail
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve one ordered `context_items` row into a canonical message paired with
 * its token authority (Pitfall 2), or `undefined` when the ref dangles (drift —
 * skipped, never fatal):
 *
 *  - a `"message"`-ref reconstructs verbatim via the core `partsToMessage` codec
 *    (stable ids, the round-trip the loop bug broke) and carries the row's STORED
 *    `tokenCount` (which counts the F3 thinking a re-estimate would under-count);
 *  - a `"summary"`-ref injects via {@link summaryRefToMessage} and carries the
 *    summary's pre-computed `tokenCount`.
 *
 * Closed discriminator (AGENTS.md §2.8): the `refKind` switch is exhaustive over
 * the `"message" | "summary"` union.
 */
function resolveContextItem(
  item: LcdContextItem,
  rowById: Map<string, LcdMessage>,
  summaryById: Map<string, LcdSummary>,
): BudgetItem | undefined {
  switch (item.refKind) {
    case "message": {
      const row = rowById.get(item.refId);
      if (row === undefined) return undefined; // dangling message-ref (drift) — skip.
      return { msg: partsToMessage(row) as AgentMessage, tokens: row.tokenCount };
    }
    case "summary": {
      const summary = summaryById.get(item.refId);
      if (summary === undefined) return undefined; // dangling summary-ref (drift) — skip.
      return { msg: summaryRefToMessage(summary), tokens: summary.tokenCount };
    }
    default: {
      const _exhaustive: never = item.refKind;
      return _exhaustive;
    }
  }
}

/**
 * Inject a leaf summary as a plain `user`-role text message — the ONE seam Phase
 * 130 swaps for the honest `trust="untrusted"` XML wrapper (P1/P2). 129 does NOT
 * claim to mitigate injection (T-129-14): it only avoids ELEVATING summary text
 * to a privileged role — a summary derived from possibly-untrusted history is
 * carried as `user` (untrusted by role), NEVER `system`/`assistant`. The
 * injection-stripping wrapper + taint-escape are Phase 130/132. Keep this the
 * single resolution point so that swap touches one function.
 */
function summaryRefToMessage(summary: LcdSummary): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: summary.content }],
  } as unknown as AgentMessage;
}

/**
 * Step 5: if an assistant message's `content` is a string, return a NEW message
 * whose content is `[{ type: "text", text }]`; otherwise return the message
 * unchanged. Pure + non-mutating; tool blocks (array content) are never touched.
 */
function normalizeAssistantContent(m: AgentMessage): AgentMessage {
  if (roleOf(m) !== "assistant") return m;
  const content = (m as unknown as { content?: unknown }).content;
  if (typeof content !== "string") return m;
  return { ...(m as object), content: [{ type: "text", text: content }] } as unknown as AgentMessage;
}

/** Read a message's `role` without widening to the concrete pi-ai union. */
function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}
