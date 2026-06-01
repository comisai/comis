// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-judge spread fold (Phase 104, Plan 104-01, PROVE-02) -- the per-category
 * inter-judge |A-B| survival computation that decides whether a headline number
 * is "stable" (safe to drive a decision).
 *
 * THE MOAT (.planning/MEMORY_BENCHMARK_CREDIBILITY.md): credibility = cross-judge
 * >=2 + a published spread. A result is trusted ONLY if it survives -- i.e. the
 * two judges agree within tolerance on that category. This module replaces the
 * hand-authored arithmetic in
 * `benchmarks/results/2026-05-31-j1-baseline/cross-judge-spread.md` with a
 * tested, reproducible fold over >=2 committed judge manifests.
 *
 * THE SURVIVAL TOLERANCE (from the j1-baseline reference math): a category
 * SURVIVES if |A-B| <= 5.0 points. Per-category n=20 gives a binomial SE of
 * ~10-11pt, so a >5pt inter-judge gap is judge-noise, not signal -- e.g.
 * single-session-preference did NOT survive in the j1 baseline (30 vs 45 = 15pt)
 * and must NOT headline.
 *
 * PURE (no Result, no throws, no I/O, no clock, no env -- AGENTS.md 2.1 pure-fn
 * carve-out, the same one qa-accuracy.ts uses). No randomness.
 *
 * SECURITY -- structural secret omission (T-104-01-01, ASVS V7, the
 * suite-report.ts:112-136 / qa-report.ts doctrine copied in style): the spread
 * output is written to a committed file via `writeRegularFile` (in 104-04),
 * OUTSIDE Pino's redaction safety-net, so this fold must guarantee no credential
 * ever reaches the file. It does so STRUCTURALLY, defending BOTH the value and
 * the key surface: (1) each {@link CategorySpread}'s judge values are
 * NUMERICALLY-COERCED scalars -- the input map value is never spread or copied
 * as-is, so a secret-shaped STRING value hung off an input map (`apiKey`,
 * `base_url`, an `authorization: Bearer ...`) has no path to the output (it
 * coerces to a number, never a leaked string); (2) a category whose value is NOT
 * a finite number is DROPPED entirely (`Number.isFinite` guard) -- so a
 * secret-shaped KEY whose value is a non-numeric secret string (e.g.
 * `apiKey: "sk-..."` hung at the category level) never emits a `category` entry
 * carrying that key. A legitimate per-category accuracy is always a finite
 * number, so this drops only off-contract pollution, never a real category.
 *
 * SECURITY -- prototype-pollution discipline (T-104-01-02, copied from
 * qa-accuracy.ts:135): the category keys originate from the UNTRUSTED dataset
 * `question_type` strings + judge manifests. The intermediate per-category map
 * in {@link computeSpreadFromResults} is a null-prototype object
 * (`Object.create(null)`) with literal-keyed writes, so a `__proto__` /
 * `constructor` category key is an ordinary own data property and can NEVER
 * mutate `Object.prototype`. {@link computeCrossJudgeSpread} iterates with
 * `Object.keys` and emits a plain array (no map keyed by the untrusted string),
 * so it carries no prototype-mutation surface either.
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module; the agent
 * package may not import the memory package. The only cross-package import is the
 * `AccuracyResult` / `CategoryAccuracy` TYPES from the in-package `qa-accuracy.ts`
 * (type-only). No `@comis/memory`. No value imports needed.
 *
 * @module
 */

import type { AccuracyResult } from "./qa-accuracy.js";

/**
 * The survival tolerance in accuracy points: a category SURVIVES (is stable
 * across the two judges) when its inter-judge spread |A-B| <= this value.
 *
 * 5.0pt is the j1-baseline protocol value. Rationale: per-category n=20 yields a
 * binomial standard error of ~10-11pt, so a <=5pt inter-judge gap is well within
 * noise (the judges agree), whereas a larger gap signals the number is too
 * judge-dependent to headline.
 */
export const SURVIVAL_TOLERANCE_PTS = 5.0;

/**
 * One category's cross-judge spread: the two judges' accuracy for the category,
 * the absolute spread between them, and whether it survives the tolerance.
 *
 * A headline number is trusted ONLY if `survives === true`.
 */
export interface CategorySpread {
  /** The category label (the comparability anchor; an untrusted dataset string). */
  category: string;
  /** Judge A's accuracy for this category (percentage points). */
  judgeA: number;
  /** Judge B's accuracy for this category (percentage points; falls back to A when absent). */
  judgeB: number;
  /** `|judgeA - judgeB|` -- the inter-judge spread in accuracy points. */
  spread: number;
  /** `true` when `spread <= tolerancePts` -- the number is stable across judges. */
  survives: boolean;
}

/**
 * Pure: fold two per-category accuracy maps (keyed by category, one per judge)
 * into the per-category |A-B| spread + a survival flag at `tolerancePts`.
 *
 * Iterates `Object.keys(perCategoryA)`; for each category, judge B's value falls
 * back to judge A's when the category is ABSENT in B -- yielding an explicit
 * spread of 0 (survives), never a crash on a missing category.
 *
 * SECURITY: each output {@link CategorySpread} is rebuilt from numerically
 * coerced scalars (`Number(...)`) -- the input map value is never spread or
 * copied as-is, so a secret-shaped STRING value on an input map cannot reach the
 * output (it coerces to a number / NaN). The output is a plain array (no map
 * keyed by the untrusted category string), so there is no prototype-mutation
 * surface.
 *
 * @param perCategoryA judge A's per-category accuracy (percentage points)
 * @param perCategoryB judge B's per-category accuracy (percentage points)
 * @param tolerancePts the survival tolerance (default {@link SURVIVAL_TOLERANCE_PTS})
 * @returns one {@link CategorySpread} per category present in `perCategoryA`
 */
export function computeCrossJudgeSpread(
  perCategoryA: Record<string, number>,
  perCategoryB: Record<string, number>,
  tolerancePts = SURVIVAL_TOLERANCE_PTS,
): CategorySpread[] {
  const out: CategorySpread[] = [];
  for (const category of Object.keys(perCategoryA)) {
    // Numeric coercion (never a string copy): a secret-shaped string value hung
    // off an input map coerces to NaN here and can never leak as a string.
    const a = Number(perCategoryA[category]);
    // SECURITY (T-104-01-01): drop any category whose value is NOT a finite
    // number. A real per-category accuracy is always finite; a secret-shaped
    // KEY (e.g. `apiKey: "sk-..."` hung at the category level) coerces to NaN
    // here and is structurally omitted, so its key never leaks into a `category`.
    if (!Number.isFinite(a)) continue;
    // missing-in-B -> use A as the explicit fallback (spread 0), never crash.
    const rawB = category in perCategoryB ? perCategoryB[category] : perCategoryA[category];
    const b = Number(rawB);
    const spread = Math.abs(a - b);
    out.push({
      // `category` is a primitive string copied as-is (a key, not a value); it
      // carries no secret -- the secret-bearing surface is the VALUE, coerced above.
      category,
      judgeA: a,
      judgeB: b,
      spread,
      // NaN <= tol is false, so a degenerate spread (e.g. a polluted judge-B
      // value while A is finite) never reads as "survives" -- a fail-safe, never
      // a fabricated-looking stable number.
      survives: spread <= tolerancePts,
    });
  }
  return out;
}

/**
 * Pure: project each {@link AccuracyResult}'s `perCategory` map to a
 * `Record<string, number>` of the per-category `accuracy` field (via a
 * null-prototype intermediate), then fold the cross-judge spread.
 *
 * A convenience so the harness can pass two `AccuracyResult` objects (the judge
 * manifests' shape) directly without manually projecting the accuracy field.
 *
 * SECURITY: the intermediate accuracy maps are null-prototype objects
 * (`Object.create(null)`) with literal-keyed writes of the numeric `accuracy`
 * scalar only -- so neither a `__proto__`/`constructor` category key nor an
 * off-contract secret-bearing field on the input result/bucket can reach the
 * downstream fold or the output (T-104-01-01 + T-104-01-02).
 *
 * @param a judge A's accuracy result
 * @param b judge B's accuracy result
 * @param tolerancePts the survival tolerance (default {@link SURVIVAL_TOLERANCE_PTS})
 * @returns one {@link CategorySpread} per category present in `a.perCategory`
 */
export function computeSpreadFromResults(
  a: AccuracyResult,
  b: AccuracyResult,
  tolerancePts = SURVIVAL_TOLERANCE_PTS,
): CategorySpread[] {
  return computeCrossJudgeSpread(
    projectAccuracy(a),
    projectAccuracy(b),
    tolerancePts,
  );
}

/**
 * Rebuild a null-prototype `category -> accuracy` map from an
 * {@link AccuracyResult}, copying ONLY the numeric `accuracy` scalar of each
 * bucket. Never spreads the input; a `__proto__`/`constructor` key is an inert
 * own data property; an off-contract secret field on the result or a bucket has
 * no path to the output.
 */
function projectAccuracy(r: AccuracyResult): Record<string, number> {
  const map: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of Object.keys(r.perCategory)) {
    // `Object.keys` yields only present keys and the project does not set
    // `noUncheckedIndexedAccess`, so the indexed access is a defined
    // `CategoryAccuracy`. Copy only the numeric `accuracy` field (coerced),
    // never the bucket object -- so an extra secret-shaped field on the bucket
    // cannot reach the output. Literal-keyed write on the null-proto map keeps a
    // `__proto__`/`constructor` key inert.
    map[key] = Number(r.perCategory[key].accuracy);
  }
  return map;
}
