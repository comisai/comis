// SPDX-License-Identifier: Apache-2.0
/**
 * Fresh-tail size bounding for the LCD `dag` assembler (B-8 + Issue-1).
 *
 * The fresh tail ships UNCONDITIONALLY (A1/A3) and the dag path runs neither
 * the observation masker nor the dead-content evictor (pipeline-only), so a
 * turn whose last steps carry a huge tool output — or a huge user/assistant
 * message (the Issue-1 session brick: one over-window message rides the fresh
 * tail forever) — would overflow the model window before any budget pass sees
 * it. This module bounds each oversized fresh-tail message via the shared
 * {@link createToolResultSizeGuard} factories (head+tail+honest marker — NOT
 * hand-rolled), with the per-message cap derived from the turn's
 * `availableHistoryTokens` (see {@link computeFreshTailCapChars}).
 *
 * Invariant reconciliation (the lcd-assembler call site enumerates A1/A2/A3):
 * the guards are referential no-ops below the cap; only text CONTENT shrinks
 * (no message removed/reordered, no `toolCallId` touched, non-text blocks
 * pass through); the LCD store keeps the full content losslessly so the
 * masked region stays `ctx_expand`-recoverable.
 *
 * Extracted from lcd-assembler.ts to keep that file under the 800-line cap.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS, CHARS_PER_TOKEN_RATIO } from "./constants.js";
import {
  createToolResultSizeGuard,
  type ContentBlock,
} from "../safety/tool-result-size-guard.js";
import { estimateMessageTokens } from "../safety/token-estimator.js";

/**
 * B-8: the single shared tool-result size guard for the dag assembler's fresh-tail
 * bounding. Built ONCE at module scope (stateless factory) so each
 * `transformContext` reuses it. The default head+tail+marker config is fine; the
 * honest lossless-recovery suffix is appended to the marker via `toolHint` per call
 * (it survives `truncateIfNeeded`'s `Hint:` formatting). Reusing this factory —
 * NOT a hand-rolled truncation — satisfies the AGENTS.md don't-hand-roll rule and
 * keeps the masking identical to the pipeline microcompaction guard.
 */
const FRESH_TAIL_TOOL_RESULT_GUARD = createToolResultSizeGuard();

/**
 * Issue-1 (small-model e2e 2026-06-12 UC-3): the sibling guard for oversized
 * USER/ASSISTANT messages in the fresh tail. Same head+tail+honest-marker
 * masking as the tool-result guard, with message-appropriate marker wording
 * (the default marker's "reduce output size (use --max-lines, …)" remedy is
 * tool-output advice that makes no sense inside a user's pasted document).
 * Without this bound, ONE message larger than the effective window bricks the
 * session permanently: the message rides the UNCONDITIONAL fresh tail, a failed
 * turn appends no assistant step (so the fresh-tail boundary never advances
 * past it), and whole-message eviction cannot shrink a single message — every
 * later turn re-fails the pre-flight with context_exhausted.
 */
const FRESH_TAIL_MESSAGE_GUARD = createToolResultSizeGuard({
  truncationMarker:
    "\n[... ${removed} chars of this oversized message truncated to fit the model's context window.${hint}]\n",
});

/**
 * Issue-1: the fraction of the turn's `availableHistoryTokens` (H = W − S − O −
 * M − R) one fresh-tail message may occupy. Computing the cap from H — not the
 * raw window — is what makes the bound sufficient: H already nets out the
 * system/tool prompt (S), the output reservation (O), and the safety margins
 * (M+R), so a bounded message can never push `S + freshTail` past the
 * pre-flight's `effectiveWindow − outputHeadroom` bound on its own. (A cap of
 * `0.8 × effectiveWindowChars` alone would NOT be: on the live 32K small
 * window, 0.8 × W ≈ 26K tokens + S ≈ 7K still exceeded the window.)
 */
const FRESH_TAIL_MESSAGE_CAP_HISTORY_FRACTION = 0.8;

/**
 * Issue-1: the cap FLOOR. When H collapses to ~0 (everything reserved — a tiny
 * window, or S eating the whole budget) the H-derived cap would bound EVERY
 * fresh-tail message down to the guard's head+tail residue, shredding normal
 * small messages that were never the problem (the fresh tail ships
 * unconditionally BY DESIGN even when H = 0, and the pre-flight is the
 * authority on whether the result fits). Below this floor the head+tail+marker
 * masking saves almost nothing anyway, and a floor-sized message (~3.4K tokens
 * at the 3.5 ratio) was already over ANY window where H ≈ 0 — so for sub-floor
 * messages the behavior is byte-identical to pre-Issue-1.
 */
const FRESH_TAIL_MESSAGE_CAP_FLOOR_CHARS = 12_000;

/**
 * Honest taint/marker suffix appended to every bounded fresh-tail message via
 * the guard's `toolHint`. Masking fresh-tail content is acceptable ONLY
 * because the LCD store keeps the full content losslessly and `ctx_expand`
 * recovers it — parity with the deterministic-fallback note wording
 * (lcd-leaf-summarizer.ts:582). Content-free by construction (no message text).
 */
const FRESH_TAIL_BOUND_RECOVERY_HINT =
  "the full content is preserved losslessly in the LCD store and is recoverable";

/**
 * The per-message char cap for this turn's fresh-tail bounding:
 * `max(FLOOR, min(B-8 constant, 0.8 × H in chars))`. For frontier/mid H is
 * huge, so the cap degrades to the historical 100K-char B-8 constant —
 * byte-identical behavior there.
 */
export function computeFreshTailCapChars(availableHistoryTokens: number): number {
  return Math.max(
    FRESH_TAIL_MESSAGE_CAP_FLOOR_CHARS,
    Math.min(
      LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS,
      Math.floor(
        availableHistoryTokens * FRESH_TAIL_MESSAGE_CAP_HISTORY_FRACTION * CHARS_PER_TOKEN_RATIO,
      ),
    ),
  );
}

/**
 * B-8 + Issue-1: bound oversized messages inside the unconditional fresh tail.
 * Pure + non-mutating — for each fresh-tail message whose total TEXT exceeds
 * `cap`, run the matching shared {@link createToolResultSizeGuard} factory
 * (head+tail+honest marker) and return a NEW message carrying the truncated
 * content; every message that fits passes through REFERENTIALLY unchanged (A1
 * preserved for what fits). The guard's marker carries the lossless-recovery
 * hint via `toolHint`, so the model is honestly told the full content is
 * recoverable.
 *
 * Covered roles:
 *  - `toolResult` (the original B-8 class — huge file reads / command dumps),
 *    via the default-marker guard;
 *  - `user` / `assistant` (the Issue-1 session-brick class — one pasted
 *    document larger than the effective window), via the message-marker
 *    guard. String-shorthand content is bounded by round-tripping through a
 *    single text block and restored to string shape.
 *
 * Only text CONTENT shrinks here — no message is removed/reordered, no
 * `toolCallId` is touched, and non-text blocks (toolCall, image, …) pass
 * through the guard untouched — so the later `sanitizeToolUseResultPairing`
 * (A2) still re-pairs every result with its `tool_use`.
 *
 * @param freshTail - the verbatim fresh-tail slice (the last N steps of the live array)
 * @param cap - the per-message char cap from {@link computeFreshTailCapChars}
 * @returns the bounded fresh tail + counts (results/messages bounded, chars removed) for the content-free DEBUG
 */
export function boundFreshTailMessages(
  freshTail: AgentMessage[],
  cap: number,
): {
  freshTail: AgentMessage[];
  boundedResults: number;
  boundedMessages: number;
  charsRemoved: number;
} {
  let boundedResults = 0;
  let boundedMessages = 0;
  let charsRemoved = 0;
  const bounded = freshTail.map((m) => {
    const role = (m as unknown as { role?: string }).role;
    const isToolResult = role === "toolResult";
    const isTextMessage = role === "user" || role === "assistant";
    if (!isToolResult && !isTextMessage) return m;
    const guard = isToolResult ? FRESH_TAIL_TOOL_RESULT_GUARD : FRESH_TAIL_MESSAGE_GUARD;
    const content = (m as unknown as { content?: unknown }).content;

    // String-shorthand content (the common user-message shape): round-trip
    // through a single text block so the SAME guard logic applies, then restore
    // the string shape (the bound must not change the message's content form).
    if (isTextMessage && typeof content === "string") {
      const result = guard.truncateIfNeeded(
        [{ type: "text", text: content }],
        cap,
        FRESH_TAIL_BOUND_RECOVERY_HINT,
      );
      if (!result.truncated) return m; // fits below the cap — byte-identical (A1).
      boundedMessages++;
      charsRemoved += (result.metadata?.originalChars ?? 0) - (result.metadata?.truncatedChars ?? 0);
      return { ...(m as object), content: result.content[0]?.text ?? "" } as unknown as AgentMessage;
    }

    // A toolResult with non-array content (string shorthand / absent) cannot carry
    // an oversized text-block payload through the guard's block API — leave it
    // verbatim (A1). The guard only bounds array-of-blocks content.
    if (!Array.isArray(content)) return m;
    // The guard's `toolHint` carries the honest lossless-recovery marker suffix (not
    // the tool name — tool names are not the signal the model needs here; the
    // recoverability of the masked content is).
    const result = guard.truncateIfNeeded(
      content as ContentBlock[],
      cap,
      FRESH_TAIL_BOUND_RECOVERY_HINT,
    );
    if (!result.truncated) return m; // fits below the cap — byte-identical (A1).
    if (isToolResult) boundedResults++;
    else boundedMessages++;
    charsRemoved += (result.metadata?.originalChars ?? 0) - (result.metadata?.truncatedChars ?? 0);
    // Return a NEW message with ONLY the content replaced (non-mutating, like
    // normalizeAssistantContent) — the role, toolCallId, toolName, etc. are intact.
    return { ...(m as object), content: result.content } as unknown as AgentMessage;
  });
  return { freshTail: bounded, boundedResults, boundedMessages, charsRemoved };
}

/** Read a message's `role` without widening to the concrete pi-ai union. */
function roleOf(m: AgentMessage): string | undefined {
  return (m as unknown as { role?: string }).role;
}

/**
 * ISSUE #1 (2026-06-22): bound the PROTECTED fresh tail's TOTAL tokens to
 * `residualTokens` by dropping the OLDEST whole STEP at a time, keeping the newest
 * contiguous run that fits. The fresh tail ships UNCONDITIONALLY (the eviction cannot
 * trim it), and {@link boundFreshTailMessages} (B-8) bounds only individual oversized
 * MESSAGES — not the SUM across turns — so on a tiny window where the system prompt
 * dominates, a handful of small recent turns accumulate past the residual and overflow
 * the window (the live nano failure: freshTail grew 1438→2369→3488…→exhaust). This
 * enforces the total directly.
 *
 * Operates on the ALREADY per-message-bounded fresh tail (call AFTER
 * boundFreshTailMessages) so a single oversized message B-8 shrank to fit is counted at
 * its bounded size, NOT dropped (Issue1-A/D). ALWAYS keeps the LAST step (the current
 * live turn ships even when it alone exceeds the residual — the pre-flight then degrades
 * it honestly as oversized_input, never silently). A STEP is a leading non-`toolResult`
 * message plus its immediately-following `toolResult`s (mirrors
 * lcd-budget-eviction.groupIntoSteps / freshTailBoundaryIndex) so a tool_use/tool_result
 * pair is never split. Pure: reads the input, returns a NEW array (or the same ref when
 * nothing is dropped — the A1 no-op for everything that fits).
 *
 * @param freshTail - the per-message-bounded fresh-tail messages (B-8 output).
 * @param residualTokens - the room the protected tail may occupy (≈ window − S − floorHeadroom − preamble).
 * @returns the newest contiguous fresh-tail steps that fit (≥ the last step).
 */
export function boundFreshTailTotalToResidual(
  freshTail: AgentMessage[],
  residualTokens: number,
): AgentMessage[] {
  if (freshTail.length === 0) return freshTail;
  // Step START indices within the fresh tail (a step begins at a non-toolResult msg).
  const stepStarts: number[] = [];
  for (let i = 0; i < freshTail.length; i++) {
    if (roleOf(freshTail[i]!) !== "toolResult") stepStarts.push(i);
  }
  if (stepStarts.length <= 1) return freshTail; // one step (or all toolResults) — keep whole.
  const tokensFrom = (from: number): number => {
    let sum = 0;
    for (let i = from; i < freshTail.length; i++) {
      sum += estimateMessageTokens(freshTail[i] as unknown as Message);
    }
    return sum;
  };
  // Advance past the oldest steps while the remaining tail exceeds the residual; NEVER
  // drop the last step (stepStarts.at(-1) is the current turn — always kept).
  let s = 0;
  while (s < stepStarts.length - 1 && tokensFrom(stepStarts[s]!) > residualTokens) {
    s++;
  }
  if (s === 0) return freshTail; // nothing dropped — A1 no-op (same reference).
  return freshTail.slice(stepStarts[s]!);
}
