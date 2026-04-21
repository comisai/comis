// SPDX-License-Identifier: Apache-2.0
/**
 * Token budget algebra for the context engine pipeline.
 *
 * Computes available history token budget using the formula:
 * H = W - S - O - M - R
 *
 * Where:
 * - W = model context window (tokens)
 * - S = system prompt + tools estimate (tokens)
 * - O = output reserve (tokens)
 * - M = safety margin (percentage-based with absolute floor)
 * - R = context rot buffer (percentage-based)
 *
 * This is a pure function with zero side effects. All constants come from
 * the centralized constants module (not user config, per locked decision).
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
 * Per user decision: negative budget clamps to zero. The caller should
 * log a WARN when `availableHistoryTokens === 0` (degraded fresh-turn behavior).
 *
 * @param contextWindow - Model context window size in tokens (W)
 * @param systemTokensEstimate - Estimated tokens for system prompt + tool definitions (S)
 * @param cacheFenceIndex - Message index at or below which content must not be modified (-1 = no fence)
 * @returns Token budget breakdown with all components
 */
export function computeTokenBudget(
  contextWindow: number,
  systemTokensEstimate: number,
  cacheFenceIndex: number = -1,
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

  // H: available history -- clamp to zero (not negative)
  const H = Math.max(0, W - S - O - M - R);

  return {
    windowTokens: W,
    systemTokens: S,
    outputReserveTokens: O,
    safetyMarginTokens: M,
    contextRotBufferTokens: R,
    availableHistoryTokens: H,
    cacheFenceIndex,
  };
}
