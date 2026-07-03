// SPDX-License-Identifier: Apache-2.0
/**
 * LCD budget-eviction unit — the PURE step-atomic newest-kept fill.
 *
 * {@link evictHistoryUnderBudget} shrinks ONLY the evictable history prefix at the
 * documented `lcd-assembler.ts` seam: the assembler splits `history`
 * (evictable) from `freshTail` (protected), and this function trims `history`
 * to fit the available token budget while the assembler concatenates the fresh tail
 * unconditionally — so the live tool exchange always ships even when over budget.
 * The seam shape the assembler uses:
 *
 *   const evictable = historyPrefixForTail(history, liveMessages, tailStart);
 *   const budgeted  = evictHistoryUnderBudget(evictableWithTokens, availableHistoryTokens);
 *   const assembled = [...budgeted, ...freshTail];  // fresh tail ALWAYS appended
 *
 * Pair atomicity is the load-bearing rule: a `tool_result`'s tokens are inseparable
 * from the assistant `tool_use` that produced it, so the natural eviction unit is
 * the STEP — an assistant (or a leading user/summary) message plus the `toolResult`
 * messages immediately following it (mirrors `extendHeadForPairSafety` /
 * `freshTailBoundaryIndex` step semantics in `lcd-assembler.ts` /
 * `llm-compaction.ts`). The fill walks steps NEWEST→oldest, keeping a step only
 * while the running sum stays ≤ budget, and STOPS at the first step that would
 * exceed; the kept steps (in original order) are the result. If even the single
 * newest step cannot fit, the WHOLE evictable prefix is dropped (`[]`) — never a
 * half step. This guarantees the kept array never starts with an orphan
 * `toolResult`: the assembler's `sanitizeToolUseResultPairing` (step 6)
 * is the backstop, but this unit's contract is to AVOID the split, which this does.
 *
 * Token authority: tokens are SUPPLIED per message — the assembler
 * sources `tokens` from the stored `LcdMessage.tokenCount` for
 * store-sourced history (which includes thinking tokens) and from `estimateMessageTokens` for
 * live/fresh-tail messages. This function does NOT re-estimate (which would
 * under-count by excluding thinking), keeping it both pure and budget-correct.
 *
 * Purity (and the agent↛memory cut): no input mutation, no I/O, no clock, no
 * estimator call, and NO `@comis/memory` import — a standalone in-memory transform
 * over an already-reconstructed array plus its per-message token counts.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** One evictable message paired with its pre-computed (supplied) token count. */
export interface BudgetItem {
  /** The reconstructed canonical message (kept verbatim in the output). */
  msg: AgentMessage;
  /** Pre-computed token count for this message (the budget authority). */
  tokens: number;
  /**
   * The durable `lcd_messages.id` of a store-resolved message-ref,
   * carried from `resolveContextItem` so the relevance pass can match a `searchLcd`
   * hit to this band item by the hit's STABLE `refId` (= `lcd_messages.id`) instead of a
   * fragile snippet-substring. Absent for live/synthetic items (the fresh tail, a coalesced
   * summary message, a unit fixture) — those simply never id-match and fall to recency, which
   * is the correct floor. The recency fill (`evictHistoryUnderBudget`) NEVER reads this, so
   * the frontier/mid recency path stays byte-identical.
   */
  lcdId?: string;
}

/**
 * Keep the NEWEST whole steps of the evictable history prefix that fit within
 * `budgetTokens` and drop the OLDEST, NEVER splitting a `tool_use`/`tool_result`
 * pair (whole-STEP eviction). The kept messages are the newest contiguous run that
 * fits, returned in their original order.
 *
 * - Under-budget input is returned unchanged (every message kept).
 * - Over budget, the oldest whole steps are dropped until the kept suffix fits.
 * - If even the single newest step exceeds the budget, the entire prefix is
 *   dropped (`[]`) — the fresh tail still ships via the assembler.
 * - `budgetTokens <= 0` returns `[]`.
 *
 * Pure: the input array is not mutated; the return is a new array; no I/O, no
 * clock, no estimator call (tokens are supplied per message).
 *
 * @param evictable - the evictable history prefix paired with per-message tokens
 * @param budgetTokens - the available history-token budget (H, from computeTokenBudget)
 * @returns a NEW array of the kept messages (newest whole steps), in original order
 */
export function evictHistoryUnderBudget(
  evictable: BudgetItem[],
  budgetTokens: number,
): AgentMessage[] {
  // Budget <= 0 (or nothing evictable) drops everything.
  if (budgetTokens <= 0 || evictable.length === 0) return [];

  // 1. Group into STEPS: walk forward; a step starts at an assistant (or a leading
  //    user/summary) message and absorbs the following `toolResult` messages until
  //    the next assistant/user. Each step records [startIndex, endIndex) + its
  //    summed (supplied) tokens. The input is read-only — no mutation.
  const steps = groupIntoSteps(evictable);

  // 2. Walk steps NEWEST→oldest, accumulating the running token sum; keep a step
  //    only while the sum stays ≤ budget; stop at the first step that would exceed.
  //    `keptFromStepIndex` is the OLDEST kept step's index (steps are contiguous).
  let runningTokens = 0;
  let keptFromStepIndex = steps.length; // none kept yet
  for (let s = steps.length - 1; s >= 0; s--) {
    const next = runningTokens + steps[s]!.tokens;
    if (next > budgetTokens) break; // this older step would exceed — stop
    runningTokens = next;
    keptFromStepIndex = s;
  }

  // 3. If even the single newest step could not fit, drop the whole prefix (never
  //    a partial step — the kept array would otherwise start mid-pair).
  if (keptFromStepIndex >= steps.length) return [];

  // The kept steps span [keptFromStepIndex .. last]; their messages, in original
  // order, are evictable[sliceStart .. end). A NEW array (slice copies the range).
  const sliceStart = steps[keptFromStepIndex]!.startIndex;
  return evictable.slice(sliceStart).map((entry) => entry.msg);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Step {
  /** Inclusive start index into the evictable array. */
  startIndex: number;
  /** Exclusive end index into the evictable array. */
  endIndex: number;
  /** Summed (supplied) tokens of the step's messages. */
  tokens: number;
}

/**
 * Partition the evictable prefix into contiguous STEPS. A step begins at any
 * non-`toolResult` message (an assistant, or a leading user/summary message) and
 * absorbs every immediately-following `toolResult` (the inseparable tail of an
 * assistant `tool_use`). A leading run of `toolResult`s with no preceding step in
 * the prefix forms its own step so no message is ever dropped — but it will only be
 * kept as a whole unit, never split. Pure: reads the input, mutates nothing.
 */
function groupIntoSteps(evictable: BudgetItem[]): Step[] {
  const steps: Step[] = [];
  let i = 0;
  while (i < evictable.length) {
    const start = i;
    let tokens = evictable[i]!.tokens;
    i++;
    // Absorb the trailing toolResults bound to this step's tool_use.
    while (i < evictable.length && roleOf(evictable[i]!.msg) === "toolResult") {
      tokens += evictable[i]!.tokens;
      i++;
    }
    steps.push({ startIndex: start, endIndex: i, tokens });
  }
  return steps;
}

/** Read a message's `role` without widening to the concrete pi-ai union. */
function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}
