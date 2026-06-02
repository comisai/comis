// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE, deterministic, CLAMPED tuned-alpha update rule (LEARN-03 / Track H2)
 * — the "bandit" math, LLM-free. A bounded deterministic step over the FOUR
 * tunable boost alphas (recency/temporal/proof/usefulness) given the accrued FEED
 * signal, clamped to `[0, 1]`. Pure function over {@link TunedAlphaVector}; imports
 * only @comis/core types — the agent-package production source must not import the
 * memory package (architecture.test.ts "agent -> memory cut"). Precedent for pure
 * ranking math in the agent package: score.ts (the `1 + alpha*(factor-0.5)` boost)
 * + executor/tool-deferral.ts (inline BM25).
 *
 * Called ONLY by the OFFLINE update job (the bandit, 111-04) — NEVER on the recall
 * hot path. The job reads the FEED signal, aggregates it into the bounded
 * per-alpha gradients of {@link FeedAggregate} (each derived from the bounded
 * used-RATE in [0,1], NOT raw counts — Pitfall 2; the aggregate construction is
 * 111-04's concern, the SHAPE is defined here), reads the current vector, and
 * calls {@link computeTunedAlphas} to produce the next clamped vector.
 *
 * Two structural invariants (the OD2 ship-gate, RED-proven):
 *  1. TRUST-FREEZE (Pitfall 1): the trust-level weight is NEVER an input or an
 *     output. {@link FeedAggregate} has no trust gradient and {@link TunedAlphaVector}
 *     (from @comis/core) has no trust field — the bandit structurally cannot move
 *     the trust weight (REQUIREMENTS "Out of Scope: a bandit that can move the
 *     trust weight"). The literal field name is deliberately never written here
 *     (the grep-0 belt, asserted in tuned-alpha-update.test.ts).
 *  2. CLAMP (Pitfall 2): every output is clamped to `[ALPHA_MIN, ALPHA_MAX]` so a
 *     pathological FEED signal can never push an alpha negative (boost inversion)
 *     or runaway (>1, overturning trust-first via the usefulness factor —
 *     score.ts Pitfall 5).
 *
 * DETERMINISM (LEARN-04): no RNG and no wall-clock read — same input yields a
 * byte-identical output every call, so the keyless learning-lift bench is
 * reproducible. A clock is injected by the JOB (for the store's `updated_at`
 * bookkeeping), never used in this pure math (globals.test.ts bans the wall-clock
 * in src; the determinism source-grep in the co-located test enforces the
 * RNG/clock-free property here too — so their literal API names are deliberately
 * never written in this file).
 *
 * @module
 */

import type { TunedAlphaVector } from "@comis/core";

/**
 * The bounded per-alpha gradient signals the update consumes (LEARN-03). Each is
 * derived by the offline job (111-04) from the bounded used-RATE in [0,1] (the
 * same rate score.ts `usefulnessNorm` uses, NOT raw counts — Pitfall 2), centered
 * so a neutral signal is 0 (no nudge). There is NO trust gradient — trust is
 * never tuned (the OD2 ship-gate, Pitfall 1).
 */
export interface FeedAggregate {
  /** Bounded gradient for the recency boost weight (centered on 0 = neutral). */
  recencyGradient: number;
  /** Bounded gradient for the event-time proximity boost weight. */
  temporalGradient: number;
  /** Bounded gradient for the proof boost weight. */
  proofGradient: number;
  /** Bounded gradient for the usefulness boost weight (from the used-RATE). */
  usefulnessGradient: number;
}

/**
 * The lower clamp bound. Matches the `min(0)` config bound the Zod schema already
 * enforces on every `rag.scoring` alpha — an alpha is never negative (a negative
 * boost weight would INVERT the boost direction).
 */
const ALPHA_MIN = 0;

/**
 * The upper clamp bound. Matches the `max(1)` config bound — an alpha never
 * runs away above 1 (a runaway usefulness weight could overturn trust-first via
 * the bounded usefulness factor — score.ts Pitfall 5).
 */
const ALPHA_MAX = 1;

/**
 * The bounded deterministic per-run delta. A single update nudges each alpha by at
 * most `STEP` in the gradient's direction — NO exploration randomness (deterministic
 * ⇒ reproducible bench, LEARN-04). Small (0.05) so the loop converges gradually and
 * a single noisy episode cannot swing the ranker.
 */
const STEP = 0.05;

/**
 * Clamp an alpha to `[ALPHA_MIN, ALPHA_MAX]` (the score.ts proofNorm
 * `Math.min(1, Math.max(0, x))` idiom). The runaway guard (Pitfall 2): a
 * pathological gradient can never push the result out of range.
 *
 * TOTAL clamp (MR-01): a non-finite input (`NaN` / `±Infinity`) is coerced to
 * `ALPHA_MIN` so the documented `[0, 1]` invariant holds UNCONDITIONALLY. The bare
 * `Math.min(1, Math.max(0, x))` returns `NaN` for a `NaN` input (`Math.max(0, NaN)
 * === NaN`), and a `NaN` alpha collapses the recall score
 * (`base * (1 + NaN*…) → NaN`, sorting ill-defined). `ALPHA_MIN` (0) is the
 * conservative "neutralize the boost" choice — it removes the boost rather than
 * granting a degenerate one (the same direction `-Infinity` already mapped to).
 * No `NaN` reaches here in production (every upstream input source rejects it —
 * `z.number()` read-back, count-derived gradients, config min/max), but the
 * function is exported and the invariant is credited in the module + port JSDoc,
 * so the defense lives in the clamp itself, not only upstream.
 */
function clampAlpha(x: number): number {
  if (!Number.isFinite(x)) return ALPHA_MIN;
  return Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, x));
}

/**
 * The bounded, deterministic, clamped tuned-alpha step (LEARN-03). Returns a NEW
 * {@link TunedAlphaVector} whose four alphas are each `clampAlpha(cur + STEP*gradient)`
 * — a bounded nudge in the gradient's direction, clamped to `[0, 1]`. PURE: no RNG
 * and no wall-clock read (deterministic — the bench reproducibility + the LLM-free/
 * deterministic-hot-path invariant). The input vector is never mutated. The trust
 * weight is NEVER an input or an output (the OD2 ship-gate, Pitfall 1).
 *
 * A zero-gradient aggregate is a no-op (returns a copy equal to `cur`): a neutral
 * FEED signal leaves the ranker unchanged.
 */
export function computeTunedAlphas(cur: TunedAlphaVector, sig: FeedAggregate): TunedAlphaVector {
  return {
    recencyAlpha: clampAlpha(cur.recencyAlpha + STEP * sig.recencyGradient),
    temporalAlpha: clampAlpha(cur.temporalAlpha + STEP * sig.temporalGradient),
    proofAlpha: clampAlpha(cur.proofAlpha + STEP * sig.proofGradient),
    usefulnessAlpha: clampAlpha(cur.usefulnessAlpha + STEP * sig.usefulnessGradient),
  };
}
