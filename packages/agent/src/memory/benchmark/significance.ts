// SPDX-License-Identifier: Apache-2.0
/**
 * Statistical-significance layer -- the N + confidence-interval + significance
 * computations every published benchmark number must carry.
 *
 * THE BELIEVABILITY REQUIREMENT:
 * every headline number reports N + a significance flag; a single-judge,
 * no-N, no-significance number is not credible. This module supplies (1) a
 * Wilson 95% confidence interval for a single accuracy over integer counts, and
 * (2) a two-proportion z-test for an A-vs-B accuracy delta -- the only genuinely
 * net-new statistical algorithm (no prior statistical test exists in the repo;
 * `qa-accuracy.ts`'s `accuracyOf` is a plain fold).
 *
 * WHY WILSON (not the naive Wald interval): the Wald interval (pHat +- z*SE)
 * degenerates to a zero-width or out-of-[0,1] interval at the boundaries
 * (pHat=0 or 1) and undercovers at small N -- exactly the regime the benchmark
 * lives in (per-category n=20). The Wilson score interval is well-behaved at the
 * boundaries and is the standard choice for binomial proportions.
 *
 * THE n-DEPENDENCE OF SIGNIFICANCE (the j1-baseline rationale): per-category
 * n=20 gives a binomial SE of ~10-11pt, so a ~6pt A-vs-B gap at n=20 is noise
 * (not significant), whereas a 19pt gap at n=100 is significant. The
 * two-proportion test makes this quantitative, so a small-N gap is never
 * mistaken for a real difference.
 *
 * PURE MATH (no Result, no throws, no I/O, no clock, no env, no randomness --
 * AGENTS.md 2.1 pure-fn carve-out, the same one qa-accuracy.ts uses).
 *
 * NEVER-NaN / FAIL-SAFE: every degenerate count maps to a safe,
 * non-fabricated value -- `total === 0` -> all-zero CI; a zero denominator or a
 * zero pooled standard error -> `pValue: 1, significant: false`. A divide-by-zero
 * can never silently surface a NaN that reads as a missing number, nor a
 * fabricated-looking "significant: true".
 *
 * SECURITY -- no input spread (the suite-report.ts doctrine in style): the inputs
 * are plain `{ correct, total }` count records; the outputs are rebuilt
 * field-by-field from numeric scalars, never spread -- so an off-contract
 * secret-bearing field hung off a count argument has no path to the output
 * (these results may be embedded in a manifest written via `writeRegularFile`,
 * outside Pino's redaction net).
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module; the agent
 * package may not import the memory package, and this file imports nothing at
 * all. Mirrors qa-accuracy.ts's import-free, cut-clean seam.
 *
 * @module
 */

/** The z-score for a two-sided 95% interval (the standard normal 0.975 quantile). */
const Z_95 = 1.959963984540054;

/** A Wilson 95% confidence interval for a single accuracy over integer counts. */
export interface AccuracyCI {
  /** The sample size (`total`). */
  n: number;
  /** The point estimate `correct / total` (0 when `total === 0`). */
  pHat: number;
  /** The lower Wilson bound, clamped to `>= 0` (0 when `total === 0`). */
  lo: number;
  /** The upper Wilson bound, clamped to `<= 1` (0 when `total === 0`). */
  hi: number;
}

/** A two-proportion significance test result. */
export interface ProportionTest {
  /** The combined sample size `a.total + b.total`. */
  n: number;
  /** The two-sided p-value (1 for a degenerate/zero-SE comparison -- never NaN). */
  pValue: number;
  /** `true` when `pValue < 0.05`. */
  significant: boolean;
}

/**
 * Pure: the Wilson 95% score confidence interval for a single accuracy.
 *
 * Uses the verified Wilson formula (z = {@link Z_95}); guards `total === 0` to an
 * all-zero result (never NaN), and clamps the bounds to `[0, 1]` so a boundary
 * proportion (pHat=0 or 1) yields a sensible one-sided-looking interval rather
 * than an out-of-range or zero-width Wald interval.
 *
 * @param correct the count of successes (graded-correct verdicts)
 * @param total the sample size (valid verdicts)
 * @returns the {@link AccuracyCI} (`{ n, pHat, lo, hi }`)
 */
export function wilsonInterval(correct: number, total: number): AccuracyCI {
  // Empty-set guard: no observations -> all-zero, never a 0/0 = NaN.
  if (total === 0) return { n: 0, pHat: 0, lo: 0, hi: 0 };
  const p = correct / total;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const half = (Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    n: total,
    pHat: p,
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
  };
}

/**
 * Pure: a standard two-sided two-proportion z-test over two `{ correct, total }`
 * count records.
 *
 * Pools the two proportions (`p = (a.correct + b.correct) / (a.total +
 * b.total)`), forms the pooled standard error, and computes a two-sided p-value
 * from the standard normal CDF. Reports the combined N + a `significant` flag at
 * the 0.05 level.
 *
 * FAIL-SAFE: a zero denominator (`a.total === 0` or
 * `b.total === 0`) or a zero pooled SE (both arms at the same boundary, e.g.
 * both all-correct -> pooled p=1 -> SE=0) returns `{ n, pValue: 1, significant:
 * false }` -- a degenerate comparison is never reported as significant and never
 * yields a NaN p-value.
 *
 * SECURITY: reads ONLY the numeric `correct`/`total` scalars and rebuilds the
 * result field-by-field -- never spreads the input, so an off-contract
 * secret-bearing field on a count argument cannot reach the output.
 *
 * @param a the first arm's counts
 * @param b the second arm's counts
 * @returns the {@link ProportionTest} (`{ n, pValue, significant }`)
 */
export function twoProportionTest(
  a: { correct: number; total: number },
  b: { correct: number; total: number },
): ProportionTest {
  const n = a.total + b.total;
  // Zero-denominator guard (before any division): a missing arm cannot be tested.
  if (a.total === 0 || b.total === 0) return { n, pValue: 1, significant: false };

  const pa = a.correct / a.total;
  const pb = b.correct / b.total;
  const pooled = (a.correct + b.correct) / n;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.total + 1 / b.total));

  // Zero pooled SE (both arms at the same boundary, e.g. both 0% or both 100%):
  // there is no variance to test against -> not significant, pValue 1.
  if (!(se > 0)) return { n, pValue: 1, significant: false };

  const z = (pa - pb) / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { n, pValue, significant: pValue < 0.05 };
}

/**
 * The standard normal cumulative distribution function via the Zelen & Severo
 * rational approximation (Abramowitz & Stegun 26.2.17) -- max abs error
 * ~7.5e-8, ample for a significance threshold. Pure, total, never NaN for a
 * finite input.
 *
 * @param x a finite z-score
 * @returns P(Z <= x) for the standard normal
 */
function standardNormalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2); // pdf at x
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upperTail = d * poly; // P(Z > |x|)
  const cdfAbs = 1 - upperTail; // P(Z <= |x|)
  return x >= 0 ? cdfAbs : 1 - cdfAbs;
}
