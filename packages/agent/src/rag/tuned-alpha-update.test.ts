// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE, deterministic, CLAMPED
 * `computeTunedAlphas` update rule (the "bandit" math, LLM-free).
 *
 * Load-bearing RED-first assertions (the OD2 ship-gate at the math layer):
 * - CLAMP holds: a PATHOLOGICAL FeedAggregate (every gradient = ±1e9) yields
 *   every output ∈ [0,1]. FAILS on a pre-patch unclamped `cur + STEP*grad`
 *   (Pitfall 2 — a runaway/negative alpha that could overturn trust-first or
 *   invert the boost).
 * - DETERMINISTIC: the same (current vector, signal) input yields a
 *   deep-equal output every call; the source has NO Math.random and NO
 *   Date.now/new Date (no wall-clock — reproducibility is the bench
 *   requirement).
 * - DIRECTIONAL + BOUNDED: a positive usefulnessGradient raises
 *   usefulnessAlpha by at most STEP; a zero-signal aggregate is a no-op
 *   (returns the input unchanged).
 * - TRUST NEVER NAMED: the input (FeedAggregate) and output (TunedAlphaVector)
 *   have NO trust field — a compile-time @ts-expect-error restates belt #1 at
 *   the math layer; the source-grep is grep-0 for the trust-weight literals +
 *   @comis/memory (the agent↛memory cut).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { TunedAlphaVector } from "@comis/core";
import {
  computeTunedAlphas,
  computeBanditAlphas,
  type FeedAggregate,
} from "./tuned-alpha-update.js";

const here = dirname(fileURLToPath(import.meta.url));
const updateSrc = readFileSync(resolve(here, "./tuned-alpha-update.ts"), "utf8");

/** A mid-range starting vector (every alpha at 0.5 — room to move both ways). */
function midVector(): TunedAlphaVector {
  return { recencyAlpha: 0.5, temporalAlpha: 0.5, proofAlpha: 0.5, usefulnessAlpha: 0.5 };
}

/** A FeedAggregate with all four gradients set to the same value. */
function uniformSignal(grad: number): FeedAggregate {
  return {
    recencyGradient: grad,
    temporalGradient: grad,
    proofGradient: grad,
    usefulnessGradient: grad,
  };
}

describe("computeTunedAlphas — pure clamped deterministic update", () => {
  it("CLAMP holds: a pathological +1e9 gradient keeps EVERY output in [0,1]", () => {
    // RED on an unclamped `cur + STEP*grad`: 0.5 + 0.05*1e9 = 5e7 ≫ 1.
    const out = computeTunedAlphas(midVector(), uniformSignal(1e9));
    for (const [k, v] of Object.entries(out)) {
      expect(v, `${k} must be ≤ 1 under a +1e9 gradient (clamp)`).toBeLessThanOrEqual(1);
      expect(v, `${k} must be ≥ 0 under a +1e9 gradient (clamp)`).toBeGreaterThanOrEqual(0);
    }
    // The runaway is clamped exactly to the max.
    expect(out).toEqual({
      recencyAlpha: 1,
      temporalAlpha: 1,
      proofAlpha: 1,
      usefulnessAlpha: 1,
    });
  });

  it("CLAMP holds: a pathological -1e9 gradient cannot push an alpha negative", () => {
    // RED on an unclamped step: 0.5 + 0.05*(-1e9) ≪ 0 (boost inversion — Pitfall 2).
    const out = computeTunedAlphas(midVector(), uniformSignal(-1e9));
    for (const [k, v] of Object.entries(out)) {
      expect(v, `${k} must be ≥ 0 under a -1e9 gradient (no boost inversion)`).toBeGreaterThanOrEqual(0);
      expect(v, `${k} must be ≤ 1`).toBeLessThanOrEqual(1);
    }
    expect(out).toEqual({
      recencyAlpha: 0,
      temporalAlpha: 0,
      proofAlpha: 0,
      usefulnessAlpha: 0,
    });
  });

  it("CLAMP is TOTAL: a NaN gradient keeps EVERY output finite and in [0,1] (no degenerate ranker)", () => {
    // RED on the pre-patch `Math.min(1, Math.max(0, x))` clamp: Math.max(0, NaN)
    // === NaN and Math.min(1, NaN) === NaN, so a NaN gradient propagates a NaN
    // alpha. A NaN alpha collapses the recall score (base * (1 + NaN*…) → NaN) and
    // makes sorting ill-defined — violating the module/port JSDoc invariant that
    // "every output is clamped to [0,1]". The clamp must coerce a non-finite input
    // to a safe in-range floor so the invariant holds UNCONDITIONALLY, not just
    // under the finite ±1e9 the existing tests cover.
    const out = computeTunedAlphas(midVector(), uniformSignal(NaN));
    for (const [k, v] of Object.entries(out)) {
      expect(Number.isFinite(v), `${k} must be finite under a NaN gradient`).toBe(true);
      expect(v, `${k} must be ≥ 0 under a NaN gradient (clamp)`).toBeGreaterThanOrEqual(0);
      expect(v, `${k} must be ≤ 1 under a NaN gradient (clamp)`).toBeLessThanOrEqual(1);
    }
  });

  it("CLAMP is TOTAL: a +Infinity gradient keeps EVERY output finite and in [0,1]", () => {
    // +Infinity already clamped to 1 by the pre-patch min/max, but assert the
    // total-clamp contract explicitly so the chosen non-finite handling is pinned.
    const out = computeTunedAlphas(midVector(), uniformSignal(Number.POSITIVE_INFINITY));
    for (const [k, v] of Object.entries(out)) {
      expect(Number.isFinite(v), `${k} must be finite under a +Infinity gradient`).toBe(true);
      expect(v, `${k} must be in [0,1]`).toBeGreaterThanOrEqual(0);
      expect(v, `${k} must be in [0,1]`).toBeLessThanOrEqual(1);
    }
  });

  it("CLAMP is TOTAL: a NaN in the CURRENT vector cannot leak a NaN alpha into the output", () => {
    // The other non-finite ingress: a NaN reaching `cur` (a future relaxed schema
    // or a direct unit consumer). `cur.recencyAlpha + STEP*0` is NaN on the
    // pre-patch clamp → a NaN output. The total clamp neutralizes it to an in-range
    // value, keeping the ranker well-defined.
    const cur: TunedAlphaVector = {
      recencyAlpha: NaN,
      temporalAlpha: 0.5,
      proofAlpha: 0.5,
      usefulnessAlpha: 0.5,
    };
    const out = computeTunedAlphas(cur, uniformSignal(0));
    for (const [k, v] of Object.entries(out)) {
      expect(Number.isFinite(v), `${k} must be finite even when cur carries a NaN`).toBe(true);
      expect(v, `${k} must be in [0,1]`).toBeGreaterThanOrEqual(0);
      expect(v, `${k} must be in [0,1]`).toBeLessThanOrEqual(1);
    }
  });

  it("CLAMP holds at the boundary: a +grad on an already-1.0 alpha stays 1.0 (not >1)", () => {
    const cur: TunedAlphaVector = {
      recencyAlpha: 1,
      temporalAlpha: 1,
      proofAlpha: 1,
      usefulnessAlpha: 1,
    };
    const out = computeTunedAlphas(cur, uniformSignal(1));
    expect(out).toEqual(cur); // already at max → clamp pins it
  });

  it("is DETERMINISTIC: identical inputs yield deep-equal outputs every call", () => {
    const cur = midVector();
    const sig: FeedAggregate = {
      recencyGradient: 0.3,
      temporalGradient: -0.7,
      proofGradient: 0.1,
      usefulnessGradient: 0.9,
    };
    const a = computeTunedAlphas(cur, sig);
    const b = computeTunedAlphas(cur, sig);
    expect(a).toEqual(b);
    // A third call after exercising other inputs still matches (no hidden state).
    computeTunedAlphas(midVector(), uniformSignal(1e9));
    const c = computeTunedAlphas(cur, sig);
    expect(c).toEqual(a);
  });

  it("is DETERMINISTIC by construction: source has NO Math.random / Date.now / new Date (covers BOTH the nudge AND the UCB bandit)", () => {
    // The wall-clock/RNG ban: the pure math must read no time and no randomness
    // (globals.test.ts also bans these in src; restated here so the RED is
    // reproducible from this commit). A clock is injected by the JOB,
    // never used in the pure step. This grep scans the WHOLE module source, so it
    // now also forbids RNG/clock inside the NEW computeBanditAlphas (RANK-03):
    // the bandit MUST be deterministic UCB (sqrt(ln(n)/n) confidence width), NOT a
    // Math.random() Thompson sample — that would break this belt + the keyless
    // learning-lift bench reproducibility (Pitfall 4).
    expect(updateSrc, "no Math.random in the update math").not.toMatch(/Math\.random/);
    expect(updateSrc, "no Date.now in the update math").not.toMatch(/Date\.now/);
    expect(updateSrc, "no `new Date` in the update math").not.toMatch(/new\s+Date\b/);
  });

  it("does NOT MUTATE the input vector (returns a fresh object)", () => {
    const cur = midVector();
    const snapshot = { ...cur };
    const out = computeTunedAlphas(cur, uniformSignal(1));
    expect(cur).toEqual(snapshot); // input untouched
    expect(out).not.toBe(cur); // a new object
  });

  it("DIRECTIONAL + BOUNDED: a positive usefulnessGradient raises usefulnessAlpha by at most STEP", () => {
    const cur = midVector();
    const out = computeTunedAlphas(cur, {
      recencyGradient: 0,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 1, // a unit positive nudge
    });
    // Raised vs input...
    expect(out.usefulnessAlpha).toBeGreaterThan(cur.usefulnessAlpha);
    // ...but by at most the bounded per-run delta STEP (no unbounded jump).
    expect(out.usefulnessAlpha - cur.usefulnessAlpha).toBeLessThanOrEqual(0.05 + 1e-12);
    // The OTHER three (zero gradient) are unchanged.
    expect(out.recencyAlpha).toBe(cur.recencyAlpha);
    expect(out.temporalAlpha).toBe(cur.temporalAlpha);
    expect(out.proofAlpha).toBe(cur.proofAlpha);
  });

  it("DIRECTIONAL: a negative gradient lowers that alpha (toward 0) by at most STEP", () => {
    const cur = midVector();
    const out = computeTunedAlphas(cur, {
      recencyGradient: -1,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 0,
    });
    expect(out.recencyAlpha).toBeLessThan(cur.recencyAlpha);
    expect(cur.recencyAlpha - out.recencyAlpha).toBeLessThanOrEqual(0.05 + 1e-12);
  });

  it("a ZERO-signal aggregate (all gradients 0) returns the input vector unchanged", () => {
    const cur: TunedAlphaVector = {
      recencyAlpha: 0.3,
      temporalAlpha: 0.7,
      proofAlpha: 0.1,
      usefulnessAlpha: 0.9,
    };
    const out = computeTunedAlphas(cur, uniformSignal(0));
    expect(out).toEqual(cur);
  });

  it("STRUCTURAL TRUST-FREEZE (math layer): the source names no trust-weight field + no @comis/memory (covers BOTH the nudge AND the UCB bandit)", () => {
    // Belt #1/#4 restated at the math layer (grep-0): the ranking math never names
    // the trust weight (it is not an input or an output), and the pure ranking
    // math imports @comis/core TYPES only (the agent↛memory cut, score.ts:5). This
    // grep scans the WHOLE module, so it now ALSO enforces that the NEW
    // computeBanditAlphas (RANK-03/RANK-04) cannot name a trust weight — the bandit
    // STRUCTURALLY cannot move the trust alpha (T-200-08).
    expect(updateSrc, "no trustAlpha in the update math").not.toMatch(/trustAlpha/);
    expect(updateSrc, "no trustGradient in the update math").not.toMatch(/trustGradient/);
    expect(updateSrc, "no @comis/memory import in pure agent ranking math").not.toMatch(
      /@comis\/memory/,
    );
  });

  it("STRUCTURAL TRUST-FREEZE (compile-time): trust is neither an input nor an output", () => {
    const cur = midVector();
    // @ts-expect-error trustGradient is not a field on FeedAggregate (trust is never tuned)
    const badSig: FeedAggregate = {
      recencyGradient: 0,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 0,
      trustGradient: 1,
    };
    void badSig;
    const result = computeTunedAlphas(cur, uniformSignal(0));
    // @ts-expect-error trustAlpha is not a field on the TunedAlphaVector result
    const _t: number = result.trustAlpha;
    void _t;
  });
});

/** A bandit posterior (the per-(tenant,agent,intent) outcome attribution). */
function posterior(rewardSum: number, n: number): { rewardSum: number; n: number } {
  return { rewardSum, n };
}

describe("computeBanditAlphas — deterministic UCB learner (RANK-03)", () => {
  it("is DETERMINISTIC: identical inputs yield deep-equal outputs every call (no RNG)", () => {
    // The UCB exploration term is optimism-under-uncertainty (a sqrt(ln(n)/n)
    // confidence width), NOT a Math.random() sample — so the bandit is as
    // reproducible as the nudge. A naive Thompson would make this flaky.
    const cur = midVector();
    const sig: FeedAggregate = {
      recencyGradient: 0.4,
      temporalGradient: -0.2,
      proofGradient: 0.1,
      usefulnessGradient: 0.6,
    };
    const a = computeBanditAlphas(cur, sig, posterior(3, 8), 0.1);
    const b = computeBanditAlphas(cur, sig, posterior(3, 8), 0.1);
    expect(a).toEqual(b);
    // A third call after exercising other inputs still matches (no hidden state).
    computeBanditAlphas(midVector(), uniformSignal(1e9), posterior(-50, 1), 1);
    const c = computeBanditAlphas(cur, sig, posterior(3, 8), 0.1);
    expect(c).toEqual(a);
  });

  it("CLAMP holds: a pathological huge-positive reward keeps EVERY output in [0,1]", () => {
    // A poisoned reward (rewardSum=1e9, n=1) must NOT run an alpha away above 1
    // (T-200-09 boost inversion / trust-first overturn via the usefulness factor).
    const out = computeBanditAlphas(midVector(), uniformSignal(1e9), posterior(1e9, 1), 1);
    for (const [k, v] of Object.entries(out)) {
      expect(v, `${k} must be ≤ 1 under a pathological +reward (clamp)`).toBeLessThanOrEqual(1);
      expect(v, `${k} must be ≥ 0 under a pathological +reward (clamp)`).toBeGreaterThanOrEqual(0);
    }
  });

  it("CLAMP holds: a pathological huge-negative reward cannot push an alpha negative", () => {
    const out = computeBanditAlphas(midVector(), uniformSignal(-1e9), posterior(-1e9, 1), 1);
    for (const [k, v] of Object.entries(out)) {
      expect(v, `${k} must be ≥ 0 under a pathological -reward (no boost inversion)`).toBeGreaterThanOrEqual(
        0,
      );
      expect(v, `${k} must be ≤ 1`).toBeLessThanOrEqual(1);
    }
  });

  it("CLAMP is TOTAL: a NaN reward / NaN gradient yields ALPHA_MIN (0), never a NaN alpha", () => {
    // A NaN alpha collapses the recall score (base*(1+NaN*…) → NaN) — clampAlpha
    // must coerce any non-finite axis output to the in-range floor.
    const outRewardNaN = computeBanditAlphas(midVector(), uniformSignal(0), posterior(NaN, 4), 0.1);
    for (const [k, v] of Object.entries(outRewardNaN)) {
      expect(Number.isFinite(v), `${k} must be finite under a NaN reward`).toBe(true);
      expect(v, `${k} in [0,1]`).toBeGreaterThanOrEqual(0);
      expect(v, `${k} in [0,1]`).toBeLessThanOrEqual(1);
    }
    const outGradNaN = computeBanditAlphas(midVector(), uniformSignal(NaN), posterior(1, 4), 0.1);
    for (const [k, v] of Object.entries(outGradNaN)) {
      expect(Number.isFinite(v), `${k} must be finite under a NaN gradient`).toBe(true);
    }
  });

  it("REWARD SIGN: a positive outcome-attributed reward pushes usefulnessAlpha UP, a negative pushes it DOWN", () => {
    // ROADMAP criterion 1: a success-attributed reward raises the axis; a
    // failure/corrected-attributed reward lowers it. Same gradient, opposite reward.
    const cur = midVector();
    const sig: FeedAggregate = {
      recencyGradient: 0,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 0.2,
    };
    const up = computeBanditAlphas(cur, sig, posterior(4, 4), 0); // mean reward +1, no exploration
    const down = computeBanditAlphas(cur, sig, posterior(-4, 4), 0); // mean reward -1
    expect(up.usefulnessAlpha).toBeGreaterThan(cur.usefulnessAlpha);
    expect(down.usefulnessAlpha).toBeLessThan(cur.usefulnessAlpha);
  });

  it("UCB EXPLORATION: an under-explored arm (low n) is pushed MORE than a well-explored arm (high n) for the same reward", () => {
    // The confidence width sqrt(ln(n+1)/(n+1)) shrinks as n grows — optimism under
    // uncertainty. With identical reward sign + gradient, the rarely-seen arm gets
    // the larger exploration bonus, so it moves further toward the boundary.
    // Deterministic — no RNG.
    const cur = midVector();
    const sig: FeedAggregate = {
      recencyGradient: 0,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 0.1,
    };
    const underExplored = computeBanditAlphas(cur, sig, posterior(1, 1), 0.5); // n=1
    const wellExplored = computeBanditAlphas(cur, sig, posterior(50, 50), 0.5); // n=50, same mean reward (+1)
    const moveUnder = underExplored.usefulnessAlpha - cur.usefulnessAlpha;
    const moveWell = wellExplored.usefulnessAlpha - cur.usefulnessAlpha;
    expect(moveUnder, "the under-explored arm gets the larger exploration bonus").toBeGreaterThan(
      moveWell,
    );
  });

  it("RANK-04 KEYSTONE: usefulnessAlpha AND recencyAlpha MOVE on synthetic reward, while the result carries NO trust field", () => {
    // The trust-frozen proof at the math layer: a bandit update with a positive
    // usefulness + recency gradient (and a nonzero posterior) MOVES both axes — and
    // recency moves (it is NO LONGER hardcoded 0 — the full vector is learnable from
    // per-id outcome attribution). The returned vector STRUCTURALLY cannot carry a
    // trust weight: Object.keys(result) is exactly the 4 alphas (belts #1/#4 —
    // T-200-08). On pre-patch HEAD this fails because computeBanditAlphas does not
    // exist.
    const cur = midVector();
    const sig: FeedAggregate = {
      recencyGradient: 0.5,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 0.5,
    };
    const result = computeBanditAlphas(cur, sig, posterior(6, 6), 0.1);

    // Both axes moved (usefulness AND recency — the full vector is now learnable).
    expect(result.usefulnessAlpha, "usefulnessAlpha must move").not.toBe(cur.usefulnessAlpha);
    expect(result.recencyAlpha, "recencyAlpha must move (no longer hardcoded 0)").not.toBe(
      cur.recencyAlpha,
    );

    // The trust weight is structurally absent — the bandit cannot emit it.
    expect(Object.keys(result).sort()).toEqual(
      ["proofAlpha", "recencyAlpha", "temporalAlpha", "usefulnessAlpha"].sort(),
    );
    expect(Object.keys(result), "the result carries NO trust field").not.toContain("trustAlpha");
  });

  it("RANK-04 PER-INTENT divergence: two intents (different posteriors) yield different vectors from the same cur", () => {
    // The per-intent learner: a 'temporal' bucket with a strong positive reward and
    // the global '' bucket with a weak/negative reward diverge independently from the
    // same starting vector — usefulness/recency move per intent while trust (absent
    // here, config-sourced at the overlay) is untouched. (The intent dimension lives
    // in the store key; this proves the MATH responds per-posterior, the bandit's
    // per-intent substrate.)
    const cur = midVector();
    const sig: FeedAggregate = {
      recencyGradient: 0.3,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: 0.3,
    };
    const temporalBucket = computeBanditAlphas(cur, sig, posterior(8, 8), 0.1); // strong +reward
    const globalBucket = computeBanditAlphas(cur, sig, posterior(-8, 8), 0.1); // -reward
    expect(temporalBucket).not.toEqual(globalBucket);
    expect(temporalBucket.usefulnessAlpha).toBeGreaterThan(globalBucket.usefulnessAlpha);
  });

  it("does NOT MUTATE the input vector (returns a fresh object)", () => {
    const cur = midVector();
    const snapshot = { ...cur };
    const out = computeBanditAlphas(cur, uniformSignal(0.5), posterior(2, 4), 0.1);
    expect(cur).toEqual(snapshot);
    expect(out).not.toBe(cur);
  });

  it("STRUCTURAL TRUST-FREEZE (compile-time): the bandit takes/returns NO trust field", () => {
    const cur = midVector();
    const result = computeBanditAlphas(cur, uniformSignal(0), posterior(0, 0), 0.1);
    // @ts-expect-error trustAlpha is not a field on the bandit's TunedAlphaVector result
    const _t: number = result.trustAlpha;
    void _t;
  });

  it("the NUDGE is PRESERVED verbatim: computeTunedAlphas still returns clampAlpha(cur + 0.05*grad)", () => {
    // The conservative learner:'nudge' fallback is byte-unchanged (a golden-value
    // assertion the bandit work must NOT disturb).
    const cur = midVector();
    const out = computeTunedAlphas(cur, {
      recencyGradient: 1,
      temporalGradient: 0,
      proofGradient: 0,
      usefulnessGradient: -1,
    });
    expect(out.recencyAlpha).toBeCloseTo(0.55, 12); // 0.5 + 0.05*1
    expect(out.usefulnessAlpha).toBeCloseTo(0.45, 12); // 0.5 + 0.05*(-1)
    expect(out.temporalAlpha).toBe(0.5);
    expect(out.proofAlpha).toBe(0.5);
  });
});
