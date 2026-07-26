// SPDX-License-Identifier: Apache-2.0
/**
 * The `fresh_tail_clamped` verdict — the operator's verbatim-tail knob was
 * silently overridden.
 *
 * Sibling of the spend/subagent verdicts (subdir line cap). Pure + deterministic:
 * same signals in → same verdict out, no LLM.
 *
 * WHY this exists (comis-moshe 2026-07-26): the verbatim fresh tail is bounded by
 * STEP COUNT, and the clamp reduced the operator's configured value to a smaller
 * one on every finite window. On a turn with more tool round-trips than the
 * effective bound, the user's ORIGINATING request slid out of verbatim context —
 * and the agent then apologized for work the user had explicitly asked for. Every
 * numeric lens read healthy at that moment: `verdict:"fits"`, `droppedCount:0`,
 * 87,740 of 1,000,000 tokens in use. Nothing in `explain` named the slide, so the
 * diagnosis required a DEBUG-only `lcd fresh tail sliced verbatim` log line.
 *
 * @module
 */

import type { IncidentSignals, IncidentReport } from "@comis/core";

/**
 * Stamp the verdict when the EFFECTIVE verbatim-tail step bound is below the
 * operator-CONFIGURED value.
 *
 * Ranked LAST in the registry: a real tool/breaker/terminal cause is upstream of
 * a context-shaping advisory and must out-rank it. It fires on the otherwise
 * clean session — exactly the case that previously produced no verdict at all.
 *
 * @param s - the folded incident signals.
 * @returns the root-cause verdict, or `null` when the knob was honored (or the
 *   trajectory predates the signal, in which case both fields are absent).
 */
export function freshTailClampedVerdict(
  s: IncidentSignals,
): IncidentReport["likelyRootCause"] | null {
  const b = s.contextBudget;
  if (b === undefined) return null;
  const effective = b.freshTailSteps;
  const configured = b.freshTailStepsConfigured;
  if (effective === undefined || configured === undefined) return null;
  if (effective >= configured) return null;

  const windowUsedPct =
    b.windowTokens > 0 ? Math.round((b.assembledInputTokens / b.windowTokens) * 100) : 0;

  return {
    code: "fresh_tail_clamped",
    detail:
      `the verbatim fresh tail kept only ${String(effective)} trailing steps, but ` +
      `contextEngine.freshTailTurns is configured as ${String(configured)} — the operator's value was ` +
      `clamped. A turn with more than ${String(effective)} tool round-trips slides the user's own ` +
      "request out of verbatim context, so the model can answer as though it was never asked. " +
      `This turn used ${String(b.assembledInputTokens)} of ${String(b.windowTokens)} tokens ` +
      `(${String(windowUsedPct)}% of the window), so the eviction budget was NOT the constraint — ` +
      "the step bound was.",
    suggestedNextSteps: [
      `compare the effective bound (${String(effective)}) against contextEngine.freshTailTurns ` +
        `(${String(configured)}) — a persistent gap means the clamp, not the config, is deciding`,
      "check whether the turn's tool round-trips exceeded the effective bound (the trajectory's " +
        "tool.call records between the user's prompt.submitted and the reply)",
    ],
  };
}
