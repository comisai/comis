// SPDX-License-Identifier: Apache-2.0
/**
 * RED pre-patch — intentionally WRONG (belt #2 not yet enforced).
 * A naive spread that lets a (type-widened) tuned object override the fifth weight.
 * Replaced by the GREEN config-sourced merge in the next commit.
 * @module
 */

import type { TunedAlphaVector } from "@comis/core";
import type { ScoringAlphas } from "./score.js";

export function buildScoringAlphas(
  configScoring: ScoringAlphas,
  tuned: TunedAlphaVector | undefined,
): ScoringAlphas {
  // RED: a spread that takes ALL fields from `tuned` when present — a smuggled
  // trust weight wins (Test 2 FAILS), and an absent tuned returns a NEW object
  // (Test 3's referential-identity FAILS).
  return { ...configScoring, ...(tuned ?? {}) };
}
