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
 *       overlap is de-duped by count so a message present in BOTH the store and
 *       the fresh-tail slice does not double (the fresh tail is authoritative).
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

import { partsToMessage } from "@comis/core";
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

  return {
    lastBreakpointIndex: undefined,
    lastTrimOffset: 0,
    async transformContext(liveMessages: AgentMessage[]): Promise<AgentMessage[]> {
      const startMs = Date.now();

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
      //    `freshTail` (protected suffix) DISTINCT (the 129 seam). De-dup the
      //    overlap so a message in BOTH the store and the fresh tail does not
      //    double; transcript repair (step 6) re-pairs the seam regardless.
      const assembled = [...historyBeforeTail(history, freshTail), ...freshTail];

      // 5. NORMALIZE assistant string content to array blocks.
      const normalized = assembled.map(normalizeAssistantContent);

      // 6. TRANSCRIPT REPAIR — the FINAL step (A2). Provider-valid pairing on
      //    ANY input: out-of-order results re-placed, unpaired calls get a marked
      //    synthesized result, orphan/duplicate results dropped.
      const repaired = sanitizeToolUseResultPairing(normalized, Date.now());

      deps.logger.info(
        {
          step: "lcd-assemble",
          durationMs: Date.now() - startMs,
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
 * The history-prefix NOT covered by the fresh-tail slice. The fresh-tail slice
 * (the live array) is authoritative for its range, so we exclude the reconstructed
 * history rows that overlap it. The live array carries no `seq`, so we reconcile
 * by COUNT: in 128 there is no compaction, so the store history and the live array
 * are 1:1 — `history` covers `[0, history.length - freshTail.length)`. A boundary
 * that lands mid-pair cannot reach the provider unpaired because transcript repair
 * (step 6) re-pairs the final array regardless (T-128-06).
 */
function historyBeforeTail(history: AgentMessage[], freshTail: AgentMessage[]): AgentMessage[] {
  return history.slice(0, Math.max(0, history.length - freshTail.length));
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
