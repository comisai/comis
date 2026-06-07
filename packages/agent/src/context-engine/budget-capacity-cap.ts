// SPDX-License-Identifier: Apache-2.0
/**
 * computeTokenBudgetForProfile — ModelProfile-aware token budget.
 *
 * C1: handles both 8K starvation (effectiveO = min(O, profile.maxOutputTokens))
 * and 256K overfill (effectiveWindow = min(contextWindow, cap-by-class)).
 * Frontier/mid class: byte-identical to computeTokenBudget (no behavioral change).
 *
 * @module
 */
import type { TokenBudget } from "./types.js";
import type { ModelProfile } from "../executor/model-profile.js";

export function computeTokenBudgetForProfile(
  profile: ModelProfile,
  systemTokensEstimate: number,
  freshTailPreambleTokensEstimate?: number,
  cacheFenceIndex?: number,
  effectiveContextCapSmall?: number,
  effectiveContextCapNano?: number,
): TokenBudget {
  throw new Error("computeTokenBudgetForProfile: not yet implemented (Plan 02)");
}
