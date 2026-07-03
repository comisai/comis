// SPDX-License-Identifier: Apache-2.0
/**
 * Token budget algebra for the context engine pipeline.
 *
 * Computes available history token budget using the formula:
 * H = W - S - O - M - R - P
 *
 * Where:
 * - W = model context window (tokens)
 * - S = system prompt + tools estimate (tokens)
 * - O = output reserve (tokens)
 * - M = safety margin (percentage-based with absolute floor)
 * - R = context rot buffer (percentage-based)
 * - P = fresh-tail preamble estimate (the WHOLE `dynamicPreamble` + `inlineMemory`
 *   block envelope-wrapper prepends into the latest user message) — a SEPARATE
 *   subtrahend, NEVER folded into S
 *
 * `P` is the WHOLE injected fresh-tail preamble, not just the recalled
 * memory. `dynamicPreamble` accumulates the date/time lines, inbound metadata,
 * channel context, verbosity guidance, the recalled memory block, active-skill
 * content, sender-trust lines, the role block, MCP server instructions, deferred-
 * tools context, the canary, BOOT/BOOTSTRAP, etc. — recalled memory is just ONE
 * part. Counting the whole preamble here is DELIBERATE and load-bearing: the fresh
 * tail (which carries this preamble inside the latest user message) ships
 * UNCONDITIONALLY in the LCD assembler (`[...budgeted, ...freshTail]`) and is
 * reserved NOWHERE else — S is `systemPrompt + toolDefOverhead` only (the preamble
 * is relocated OUT of `systemPrompt` for cache stability) and O/M/R are
 * constants/percentages. So subtracting the whole preamble here is the ONLY thing
 * that reserves window headroom for it; measuring only the recalled bytes would
 * UNDER-reserve H and risk a fresh-tail overflow on a heavy-skills / many-MCP
 * agent. The over-reservation is conservative (it over-reserves H, never
 * under-reserves) and preserves the design intent: recalled memory is a strict SUBSET of
 * the preamble, so a heavier recall block still grows `P` and compacts older
 * history harder.
 *
 * This is a pure function with zero side effects. All constants come from
 * the centralized constants module (deliberately not operator-configurable).
 *
 * @module
 */

import {
  SAFETY_MARGIN_PERCENT,
  MIN_SAFETY_MARGIN_TOKENS,
  OUTPUT_RESERVE_TOKENS,
  CONTEXT_ROT_BUFFER_PERCENT,
} from "./constants.js";
import type { TokenBudget } from "./types.js";

/**
 * Compute available history token budget.
 *
 * Negative budget clamps to zero by design. The caller should
 * log a WARN when `availableHistoryTokens === 0` (degraded fresh-turn behavior).
 *
 * @param contextWindow - Model context window size in tokens (W)
 * @param systemTokensEstimate - Estimated tokens for system prompt + tool definitions (S)
 * @param cacheFenceIndex - Message index at or below which content must not be modified (-1 = no fence)
 * @param freshTailPreambleTokensEstimate - Estimated tokens for the WHOLE fresh-tail
 *   preamble block (the `dynamicPreamble` + `inlineMemory` prepended into the latest
 *   user message by envelope-wrapper). NOT just recalled memory — see the module
 *   doc: it covers skills XML, MCP instructions, deferred-tools context,
 *   date/channel lines, recalled memory, etc., because that whole blob rides the
 *   UNCONDITIONALLY-shipped fresh tail and is reserved nowhere else. A SEPARATE
 *   subtrahend of H — never folded into S — so a heavier preamble (and recalled
 *   memory is a strict subset of it) compacts older history harder. Defaults to 0 for
 *   callers that do not pass it (storeless / no-preamble callers are unchanged).
 *   Clamped to `>= 0` (a negative estimate never adds to H).
 * @returns Token budget breakdown with all components
 */
export function computeTokenBudget(
  contextWindow: number,
  systemTokensEstimate: number,
  cacheFenceIndex: number = -1,
  freshTailPreambleTokensEstimate: number = 0,
): TokenBudget {
  const W = contextWindow;
  const S = systemTokensEstimate;

  // O: output reserve (capped at constant; future override possible via wrapper)
  const O = OUTPUT_RESERVE_TOKENS;

  // M: safety margin -- percentage with absolute floor for small-context models
  const M = Math.max(
    Math.ceil(W * SAFETY_MARGIN_PERCENT / 100),
    MIN_SAFETY_MARGIN_TOKENS,
  );

  // R: context rot buffer -- percentage of window
  const R = Math.ceil(W * CONTEXT_ROT_BUFFER_PERCENT / 100);

  // P: fresh-tail preamble estimate -- the WHOLE dynamicPreamble +
  // inlineMemory blob that rides the unconditionally-shipped fresh tail, a SEPARATE
  // subtrahend clamped to >= 0 so a negative estimate never widens H. NOT folded
  // into S (preserves the recall-dag-budget-partition invariant) and deliberately
  // the whole preamble, not just recall (the only window reservation for it).
  const P = Math.max(0, freshTailPreambleTokensEstimate);

  // TOKEN-AUTHORITY DECISION (deliberate, do NOT "align"):
  // The S and P this function subtracts are produced at the executor call sites
  // (executor-tool-assembly.ts:518-519 / :530-531) by dividing CHARS by
  // CHARS_PER_TOKEN_RATIO = 3.5, whereas the LCD history items the resulting H
  // bounds carry their STORED tokenCount computed by estimateMessageTokens (4:1 for
  // text, 3:1 for structured). This is a real unit mismatch, but its direction is
  // CONSERVATIVE and intentional: for the SAME text, ÷3.5 yields MORE tokens than
  // ÷4, so S and P OVER-reserve relative to how that text would be counted as
  // history → H below comes out SMALLER (the ceiling is TIGHTER), and the assembled
  // prompt stays UNDER the real free window. The intuition "H larger than
  // the true free budget → overflow" reads the direction BACKWARDS.
  // Moving S/P from 3.5 → 4 would make
  // them SMALLER and WIDEN H — the UNSAFE direction, and exactly what the
  // recall-dag-budget-partition invariant guards against. So the 3.5 ratio at the
  // call sites is kept on purpose. Executable proof + regression guard:
  // executor/prompt-runner/lcd-token-authority-characterization.test.ts.
  //
  // H: available history -- clamp to zero (not negative)
  const H = Math.max(0, W - S - O - M - R - P);

  return {
    windowTokens: W,
    // Profile-unaware base: no capability-class cap is applied here, so the
    // window IS the raw window. computeTokenBudgetForProfile overrides these
    // two when its class cap actually clamps W (cap provenance).
    rawContextWindowTokens: W,
    windowCapSource: "none",
    systemTokens: S,
    outputReserveTokens: O,
    safetyMarginTokens: M,
    contextRotBufferTokens: R,
    freshTailPreambleTokens: P,
    availableHistoryTokens: H,
    cacheFenceIndex,
  };
}
