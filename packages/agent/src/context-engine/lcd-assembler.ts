// SPDX-License-Identifier: Apache-2.0
/**
 * LCD `dag`-mode assembly engine (Phase 128, A1/A2/A4) — the corrected loop fix.
 *
 * The deleted `dag-assembler.ts` flattened every assistant `tool_use` and every
 * `tool_result` into `content: [{ type: "text", text }]`, so the model never saw
 * a provider-valid `tool_use`<->`tool_result` pairing for its own prior action
 * and re-issued the same `read` 54 times (124 s). This module is the verbatim
 * replacement wired into the `dag` branch at `context-engine.ts`:
 *
 *  1+2. HISTORY — faithfully reconstructed from the LCD store via the core
 *       `partsToMessage` codec (verbatim `metadata.raw` blocks, stable ids), so
 *       the round-trip drops no field and tool calls pair by id.
 *  3.   FRESH TAIL — the last N STEPS of the LIVE array (an assistant message
 *       plus the tool results it triggered), sliced VERBATIM as the ORIGINAL
 *       structured blocks (never reconstructed-from-text). Never evicted (A1).
 *  4.   CONCAT — NO compaction in 128 (full history + verbatim fresh tail).
 *       `history` (the evictable prefix) and `freshTail` (the protected suffix)
 *       stay DISTINCT variables: the Phase-129 budget pass slots a
 *       `compactHistoryUnderBudget(history, …)` call between steps 2 and 4 and
 *       touches ONLY `history`, never `freshTail` (the A3 structural seam). The
 *       history prefix is bounded by the LIVE array's own fresh-tail boundary
 *       (`tailStart`), reconstructed-from-store where a row exists — drop-free
 *       and double-free whether the live array leads the store (the normal
 *       mid-turn case) or has been shrunk by a heal (the fresh tail is
 *       authoritative for its range).
 *  5.   NORMALIZE — assistant string content -> `[{ type: "text", text }]`
 *       (pure, non-mutating; tool blocks untouched).
 *  6.   TRANSCRIPT REPAIR — `sanitizeToolUseResultPairing` runs LAST (A2), so the
 *       provider can never receive an unpaired/out-of-order pairing even if the
 *       history/fresh-tail seam landed mid-pair.
 *
 * Architecture cut (agent↛memory): this file imports ONLY the core
 * `ContextStorePort`/`LcdMessage` TYPES + the core `partsToMessage` runtime codec
 * from `@comis/core`; it NEVER imports `@comis/memory`. The concrete
 * `createLcdStore` is injected by the daemon as `ContextEngineDeps.contextStore`
 * (wired in Plans 03/05). This module is read-only — it NEVER appends (that is
 * the afterTurn ingest path, Plan 03).
 *
 * @module
 */

import { partsToMessage, systemNowMs } from "@comis/core";
import type { ContextStorePort, LcdMessage } from "@comis/core";
import type { ContextEngineConfig } from "@comis/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
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
  // Production never calls Date.now() directly (the globals gate); `systemNowMs`
  // is the sanctioned system-clock wrapper for the no-injected-clock unit case.
  const now = (): number => (deps.clock ? deps.clock.now() : systemNowMs());

  return {
    lastBreakpointIndex: undefined,
    lastTrimOffset: 0,
    async transformContext(liveMessages: AgentMessage[]): Promise<AgentMessage[]> {
      const startMs = now();

      // 1+2. HISTORY: faithful reconstruction from the STORE via the core codec.
      //      `getMessages` returns rows ordered by seq (F2); `partsToMessage`
      //      rebuilds each canonical block from its verbatim `metadata.raw`
      //      (parts-codec.ts) — the round-trip the loop bug broke.
      const rows: LcdMessage[] = store.getMessages(conversationId);
      const history = rows.map((row) => partsToMessage(row)) as AgentMessage[];
      deps.logger.debug(
        {
          step: "lcd-resolve",
          conversationId,
          historyCount: history.length,
          agentId: deps.agentId,
          sessionKey: deps.sessionKey,
        },
        "lcd history reconstructed from store",
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

      // 4. CONCAT — NO compaction in 128. Keep `history` (evictable prefix) and
      //    `freshTail` (protected suffix) DISTINCT (the 129 seam). The fresh tail
      //    covers live[tailStart..]; the history prefix is live[0..tailStart),
      //    reconstructed-from-store where a row exists. Bounding off the LIVE
      //    array's own boundary (not a count subtraction against a differently-
      //    sized store) is drop-free and double-free for BOTH L>H (mid-turn: the
      //    store lags the live array by the in-flight turn's delta — CR-01) and
      //    L<=H (a heal/compaction shrank the live array — WR-01). Transcript
      //    repair (step 6) re-pairs the seam regardless.
      const assembled = [...historyPrefixForTail(history, liveMessages, tailStart), ...freshTail];

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
          historyCount: history.length,
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
 * The history prefix NOT covered by the fresh-tail slice, bounded by the LIVE
 * array's own boundary (`tailStart`) rather than a count subtraction against a
 * differently-sized store.
 *
 * The fresh tail covers `live[tailStart..]`; this prefix is `live[0..tailStart)`,
 * reconstructed-from-store (verbatim codec, stable ids) where a row exists for
 * that index, falling back to the live message when the store has not yet
 * persisted it. Keying off the live boundary (not `history.length − freshTail.length`)
 * is what makes the seam drop-free and double-free regardless of how `live.length`
 * relates to `store.length`:
 *
 *  - **L > H (the normal mid-turn case, CR-01):** `transformContext` runs before
 *    every LLM call but the store is written only at afterTurn, so the live array
 *    leads the store by the in-flight turn's not-yet-persisted delta. The store
 *    rows cover `[0, history.length)`; indices in `[history.length, tailStart)`
 *    fall back to the live message — no contiguous mid-history block is dropped.
 *  - **L <= H (a heal/compaction shrank the live array, WR-01):** the loop runs
 *    only up to `tailStart < live.length`, so the store's EXTRA tail rows are
 *    never over-included and nothing doubles at the seam.
 *
 * Positional alignment assumption: `live[0..tailStart)` lines up with
 * `store[0..tailStart)` while the store is strictly append-only and the live
 * prefix is the persisted prefix (the WR-01 shrink guard on the ingest side keeps
 * the store from advancing past a shrunk live array). A boundary that lands
 * mid-pair cannot reach the provider unpaired because transcript repair (step 6)
 * re-pairs the final array regardless (T-128-06).
 */
function historyPrefixForTail(
  history: AgentMessage[],
  liveMessages: AgentMessage[],
  tailStart: number,
): AgentMessage[] {
  const prefix: AgentMessage[] = [];
  for (let i = 0; i < tailStart; i++) {
    // Store row if persisted for this index, else the live message (the store
    // lags the live array mid-turn). `as AgentMessage` narrows the reconstructed
    // codec row, identical to step 1+2's `history` typing.
    prefix.push((i < history.length ? history[i] : liveMessages[i]) as AgentMessage);
  }
  return prefix;
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
