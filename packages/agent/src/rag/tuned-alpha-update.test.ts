// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 111 (LEARN-03 / Track H2) — the PURE, deterministic, CLAMPED
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
 *   requirement, LEARN-04).
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
import { computeTunedAlphas, type FeedAggregate } from "./tuned-alpha-update.js";

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

describe("computeTunedAlphas — pure clamped deterministic update (LEARN-03)", () => {
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

  it("is DETERMINISTIC by construction: source has NO Math.random / Date.now / new Date", () => {
    // The wall-clock/RNG ban: the pure math must read no time and no randomness
    // (globals.test.ts also bans these in src; restated here so the RED is
    // reproducible from this commit). A clock is injected by the JOB (111-04),
    // never used in the pure step.
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

  it("STRUCTURAL TRUST-FREEZE (math layer): the source names no trust-weight field + no @comis/memory", () => {
    // Belt #1 restated at the math layer (grep-0): the bandit math never names
    // the trust weight (it is not an input or an output), and the pure ranking
    // math imports @comis/core TYPES only (the agent↛memory cut, score.ts:5).
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
