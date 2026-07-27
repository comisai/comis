// SPDX-License-Identifier: Apache-2.0
/** Deterministic verdict for a recorded loss of the originating request. */

import type { IncidentSignals, IncidentReport } from "@comis/core";

export function freshTailOriginLostVerdict(
  s: IncidentSignals,
): IncidentReport["likelyRootCause"] | null {
  const b = s.contextBudget;
  if (b === undefined) return null;
  if (b.originatingRequestRetained !== false) return null;
  const effective = b.freshTailSteps;
  const configured = b.freshTailStepsConfigured;

  const windowUsedPct =
    b.windowTokens > 0 ? Math.round((b.assembledInputTokens / b.windowTokens) * 100) : 0;

  return {
    code: "fresh_tail_origin_lost",
    detail:
      "the context-budget record proves the user's originating request was absent from the " +
      `protected fresh tail after ${String(b.freshTailTrimmedCount ?? 0)} messages were trimmed. ` +
      (effective !== undefined && configured !== undefined
        ? `The effective step bound was ${String(effective)} and contextEngine.freshTailTurns was ${String(configured)}. `
        : "") +
      `This turn used ${String(b.assembledInputTokens)} of ${String(b.windowTokens)} tokens ` +
      `(${String(windowUsedPct)}% of the window).`,
    suggestedNextSteps: [
      "inspect the context.budget record's originatingRequestRetained and freshTailTrimmedCount fields",
      "reduce fixed prompt overhead or the number of retained completed tool segments so the originating request remains protected",
    ],
  };
}
