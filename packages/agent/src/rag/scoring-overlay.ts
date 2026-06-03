// SPDX-License-Identifier: Apache-2.0
/**
 * The deterministic apply overlay (RESEARCH RQ5, Pattern 1): merges a
 * learned 4-tuple onto the static `ScoringAlphas` at the single recall apply site
 * (`prompt-assembly.ts` — the `scoring:` arg into `createMemoryRecall`).
 *
 * PURE + deterministic — no clock, no LLM, no randomness. The recall hot path stays
 * deterministic + LLM-free (the milestone's binding constraint #1): this is a read +
 * merge, never a model call and never a per-request roll.
 *
 * Trust-freeze, the second structural belt (the OD2 ship-gate, RESEARCH Pitfall 1):
 *   - The fifth weight (the trust-level boost) is sourced ONLY from `configScoring`.
 *     The learned 4-tuple has no such field BY TYPE ({@link TunedAlphaVector}, belt #1),
 *     and this explicit `configScoring`-sourced read is belt #2 — the learned vector
 *     can never raise the trust weight, even if a future type-widened caller smuggles
 *     one onto the tuned object. The trust weight from config is
 *     NON-NEGOTIABLE.
 *
 * Default-OFF byte-identity (RESEARCH Pitfall 3): when `tuned` is absent (tuning off,
 * or no learned row yet), the early return hands back `configScoring` UNCHANGED — the
 * same object reference — so recall is byte-identical to today and no boost shifts.
 *
 * @module
 */

import type { TunedAlphaVector } from "@comis/core";
import type { ScoringAlphas } from "./score.js";

/**
 * Overlay the learned 4-tuple onto the static config alphas; the fifth (trust) weight
 * is ALWAYS taken from `configScoring`, never from `tuned` (belt #2). When `tuned` is
 * `undefined`, returns `configScoring` unchanged (the default-OFF byte-identity no-op).
 *
 * @param configScoring - the static `rag.scoring` alphas (the sole trust-weight source).
 * @param tuned - the learned 4-tuple, or `undefined` when tuning is off / no row exists.
 * @returns a `ScoringAlphas` with the four non-trust weights from `tuned` (when present)
 *   and the trust weight from `configScoring`; or `configScoring` itself when `tuned` is absent.
 */
export function buildScoringAlphas(
  configScoring: ScoringAlphas,
  tuned: TunedAlphaVector | undefined,
): ScoringAlphas {
  if (tuned === undefined) return configScoring; // default-OFF byte-identity (Pitfall 3)
  return {
    recencyAlpha: tuned.recencyAlpha,
    temporalAlpha: tuned.temporalAlpha,
    proofAlpha: tuned.proofAlpha,
    usefulnessAlpha: tuned.usefulnessAlpha,
    // belt #2 (the OD2 ship-gate): the trust weight is read EXPLICITLY from config,
    // NEVER from `tuned` — the learned vector cannot move trust.
    trustAlpha: configScoring.trustAlpha,
    // The FadeMem decay weight is likewise config-sourced, NEVER tuned — the
    // learned 4-tuple has no such dimension (TunedAlphaVector, belt #1) and the bandit
    // never reads/writes it (online-tuning-job's baseline is the four non-trust weights).
    // So the overlay passes it through from config unchanged (a stale memory's decay is an
    // operator knob, not a learned one) — keeping buildScoringAlphas total over ScoringAlphas.
    forgetAlpha: configScoring.forgetAlpha,
  };
}
