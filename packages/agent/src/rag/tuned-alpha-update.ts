// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE, deterministic, CLAMPED tuned-alpha update rule
 * — the "bandit" math, LLM-free. A bounded deterministic step over the FOUR
 * tunable boost alphas (recency/temporal/proof/usefulness) given the accrued FEED
 * signal, clamped to `[0, 1]`. Pure function over {@link TunedAlphaVector}; imports
 * only @comis/core types — the agent-package production source must not import the
 * memory package (architecture.test.ts "agent -> memory cut"). Precedent for pure
 * ranking math in the agent package: score.ts (the `1 + alpha*(factor-0.5)` boost)
 * + executor/tool-deferral.ts (inline BM25).
 *
 * Called ONLY by the OFFLINE update job (the bandit) — NEVER on the recall
 * hot path. The job reads the FEED signal, aggregates it into the bounded
 * per-alpha gradients of {@link FeedAggregate} (each derived from the bounded
 * used-RATE in [0,1], NOT raw counts — Pitfall 2; the aggregate construction is
 * the job's concern, the SHAPE is defined here), reads the current vector, and
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
 * DETERMINISM: no RNG and no wall-clock read — same input yields a
 * byte-identical output every call, so the keyless learning-lift bench is
 * reproducible. A clock is injected by the JOB (for the store's `updated_at`
 * bookkeeping), never used in this pure math (globals.test.ts bans the wall-clock
 * in src; the determinism source-grep in the co-located test enforces the
 * RNG/clock-free property here too — so their literal API names are deliberately
 * never written in this file).
 *
 * TWO LEARNERS, one clamp/determinism/trust-freeze contract (RANK-03, a FORWARD
 * choice — NOT back-compat, I8):
 *  - {@link computeTunedAlphas} — the conservative `learner:'nudge'` fallback: a
 *    bounded `STEP=0.05` step in the gradient's direction. PRESERVED verbatim.
 *  - {@link computeBanditAlphas} — the DEFAULT `learner:'bandit'`: a deterministic
 *    UCB learner (optimism-under-uncertainty — a `sqrt(ln(n)/n)` confidence-width
 *    exploration bonus, NO RNG) that learns the FULL alpha vector from per-id
 *    outcome attribution (the recency/temporal/proof gradients — hardcoded `0`
 *    under the raw used-rate feed — become computable once an outcome-attributed
 *    reward mean rides the exploit term). UCB (not Thompson) is mandatory: an RNG
 *    sample would break the determinism source-grep + the bench.
 * The job (Plan 06's online-tuning-job) selects between them by
 * `learningTuning.learner`. BOTH share `clampAlpha` `[0,1]` and the trust-freeze
 * (neither names nor returns a trust weight — belts #1/#4).
 *
 * @module
 */

import type { TunedAlphaVector } from "@comis/core";

/**
 * The bounded per-alpha gradient signals the update consumes. Each is
 * derived by the offline job from the bounded used-RATE in [0,1] (the
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
 * ⇒ reproducible bench). Small (0.05) so the loop converges gradually and
 * a single noisy episode cannot swing the ranker.
 */
const STEP = 0.05;

/**
 * Clamp an alpha to `[ALPHA_MIN, ALPHA_MAX]` (the score.ts proofNorm
 * `Math.min(1, Math.max(0, x))` idiom). The runaway guard (Pitfall 2): a
 * pathological gradient can never push the result out of range.
 *
 * TOTAL clamp: a non-finite input (`NaN` / `±Infinity`) is coerced to
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
 * The bounded, deterministic, clamped tuned-alpha step. Returns a NEW
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

/**
 * The accrued outcome-attribution posterior for ONE `(tenant, agent, intent)`
 * bucket — the plain-number substrate the bandit reads. Kept as two scalars (not a
 * store row) so the math stays pure and `@comis/core`-types-only.
 *
 * PROVENANCE (WR-04): in v1 this posterior is derived LIVE by the offline job's
 * `aggregateFeed` from the `memory_usefulness` feed (used/ignored MINUS the WR-03
 * failure term) — it is NOT persisted. The `tuned_alpha.outcome_reward_sum` /
 * `outcome_n` columns are RESERVED/INERT in v1 (written 0, read by nobody) — a
 * forward-compatible slot for a future durable cross-run posterior, NOT the current
 * reward path. Do not read this type's JSDoc as "the bandit reads those columns"; the
 * reward flows through `memory_usefulness`.
 */
export interface BanditPosterior {
  /** Signed sum of outcome-attributed rewards (success → +, failure/corrected → −). */
  rewardSum: number;
  /** Number of outcome attributions accrued (the arm pull count for UCB). */
  n: number;
}

/**
 * The deterministic UCB confidence width — optimism under uncertainty. Shrinks
 * monotonically as `n` grows (a rarely-pulled arm gets a wider exploration
 * bonus). `+1` guards `n=0` (an unseen arm: `sqrt(ln(1)/1) = 0`, so a fresh arm
 * relies on the exploit term — the bonus grows then decays as evidence
 * accumulates). NO randomness — the exploration is this deterministic bonus, NOT a
 * sample (a Thompson sample would break the determinism source-grep + the keyless
 * learning-lift bench; Pitfall 4). A non-finite `n` collapses to `0` so the
 * downstream `clampAlpha` total-clamp keeps every output in range.
 */
function ucbConfidenceWidth(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  const denom = n + 1;
  return Math.sqrt(Math.log(denom) / denom);
}

/**
 * The DEFAULT `learner:'bandit'` (RANK-03): a bounded, deterministic UCB step over
 * the FULL 4-alpha vector. Returns a NEW {@link TunedAlphaVector}; the input is
 * never mutated.
 *
 * For each alpha axis the next value is
 * `clampAlpha(cur.axisAlpha + STEP * (exploit + exploration * confidenceWidth))`
 * where:
 *  - `exploit` = the axis gradient PLUS the outcome-attributed reward mean
 *    (`rewardSum / max(1, n)`). A `success`-attributed reward (positive sum) pushes
 *    every axis UP; a `failure`/`corrected`-attributed reward (negative sum) pushes
 *    DOWN (reward sign correct — ROADMAP criterion 1). This reward mean is what
 *    makes the recency/temporal/proof axes — hardcoded `0` under the bare used-rate
 *    feed — actually MOVE (the full vector becomes learnable from per-id
 *    attribution; the RANK-04 keystone).
 *  - `confidenceWidth` = {@link ucbConfidenceWidth} — the deterministic UCB bonus,
 *    weighted by the `exploration` knob (`learningTuning.exploration`, default 0.1).
 *
 * INVARIANTS (shared with the nudge):
 *  - CLAMP (T-200-09): every output is `clampAlpha`-ed to `[0,1]` (NaN → 0) — a
 *    pathological/poisoned reward can never invert a boost (<0) or run an alpha
 *    away (>1, overturning trust-first via the usefulness factor — score.ts
 *    Pitfall 5).
 *  - TRUST-FREEZE (T-200-08, belts #1/#4): the trust weight is NEVER an input or an
 *    output. This fn takes/returns ONLY the 4-alpha {@link TunedAlphaVector} and the
 *    {@link FeedAggregate} (which has no trust gradient); the trust-weight field name
 *    is deliberately never written here (the grep-0 source belt). The bandit is
 *    STRUCTURALLY unable to move the trust weight.
 *  - DETERMINISM: UCB, no RNG, no wall-clock — same input yields a byte-identical
 *    output (the reproducible bench; an RNG-sampling Thompson is rejected by the
 *    determinism source-grep, Pitfall 4).
 */
export function computeBanditAlphas(
  cur: TunedAlphaVector,
  sig: FeedAggregate,
  posterior: BanditPosterior,
  exploration: number,
): TunedAlphaVector {
  const rewardMean = posterior.rewardSum / Math.max(1, posterior.n);
  const explore = exploration * ucbConfidenceWidth(posterior.n);
  const step = (axisGradient: number): number => STEP * (axisGradient + rewardMean + explore);
  return {
    recencyAlpha: clampAlpha(cur.recencyAlpha + step(sig.recencyGradient)),
    temporalAlpha: clampAlpha(cur.temporalAlpha + step(sig.temporalGradient)),
    proofAlpha: clampAlpha(cur.proofAlpha + step(sig.proofGradient)),
    usefulnessAlpha: clampAlpha(cur.usefulnessAlpha + step(sig.usefulnessGradient)),
  };
}
