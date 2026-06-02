// SPDX-License-Identifier: Apache-2.0
/**
 * Per-release REGRESSION-vs-BASELINE verdict (Phase 116, GATE-01) -- the pure
 * comparison that backs the SCHEDULED CI regression gate
 * (`.github/workflows/bench-regression.yml` + the `gate` mode of
 * `scripts/bench-memory.sh`).
 *
 * THE GATE (.planning + GATE-REPORT.md §4): every per-release benchmark run must
 * be checked against the committed J1 baseline
 * (`benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json`, judge A =
 * gpt-4o, the LongMemEval reference judge). A category "regresses" -- and fails
 * the job -- ONLY when BOTH conditions hold:
 *   1. the current accuracy is BELOW the baseline by more than `tolerancePts`
 *      (the {@link REGRESSION_TOLERANCE_PTS} band), AND
 *   2. the drop is STATISTICALLY SIGNIFICANT at the run's N (via
 *      {@link twoProportionTest} -- the same two-proportion z-test the rest of
 *      the believability layer uses).
 *
 * WHY BOTH GATES (the j1-baseline n-dependence rationale): per-category n=20
 * gives a binomial SE of ~10-11pt, so a ~6pt category drop at n=20 is judge/
 * sampling noise, not a real regression. A bare-threshold gate (drop > tolerance,
 * no significance check) would red-light CI on noise and train operators to
 * ignore it; requiring significance keeps the gate trustworthy. The tolerance
 * band is the FIRST gate so a statistically-significant-but-tiny drop (e.g. 2pt
 * at n=10000) never red-lights either -- the gate fires only on a drop that is
 * both materially large AND not noise.
 *
 * NO NEW STATISTICAL TEST: this reuses {@link twoProportionTest} from
 * significance.ts (no prior test existed before Phase 104; none is added here)
 * and the `CategoryAccuracy` count shape from qa-accuracy.ts. The accuracy
 * PERCENTAGE on each bucket is informational; the significance test reads the raw
 * `correct`/`total` counts (a percentage alone cannot be tested for significance).
 *
 * DROPPED CATEGORY = A REAL LOSS: a category present in the baseline but ABSENT
 * from the current run is treated as `current = 0` -- a category that silently
 * vanished is a regression to be flagged, never a free pass. (A category present
 * only in the current run is informational and is NOT in the per-category list;
 * the baseline is the comparability anchor.)
 *
 * PURE MATH (no Result, no throws, no I/O, no clock, no env, no randomness --
 * AGENTS.md 2.1 pure-fn carve-out, the same one qa-accuracy.ts / significance.ts /
 * cross-judge-spread.ts use). NEVER-NaN: a degenerate baseline/current count
 * (total 0) yields a finite `deltaPts` (0 - 0 = 0) and a `significant: false`
 * (twoProportionTest's zero-denominator guard) -- never a NaN that reads as a
 * missing number, never a fabricated `regressed: true`.
 *
 * SECURITY -- structural secret omission (the cross-judge-spread.ts /
 * results-ledger.ts doctrine, ASVS V7): the verdict may be embedded in a manifest
 * written via `writeRegularFile`, OUTSIDE Pino's redaction net, so this fold
 * guarantees no credential ever reaches the file. It does so STRUCTURALLY: each
 * {@link CategoryRegression} is rebuilt from NUMERICALLY-COERCED scalars
 * (`Number(...)`) plus the primitive category string -- the input bucket object
 * is NEVER spread or copied as-is, so a secret-shaped STRING value hung off an
 * input map coerces to NaN and the category is DROPPED (a real per-category
 * accuracy is always finite), and the `summary` is built only from the rebuilt
 * numeric/boolean fields + the category string.
 *
 * SECURITY -- prototype-pollution discipline (qa-accuracy.ts:135): the category
 * keys originate from the UNTRUSTED dataset `question_type` strings + the
 * committed baseline manifest. The intermediate per-category accuracy maps are
 * null-prototype objects (`Object.create(null)`) with literal-keyed writes, so a
 * `__proto__`/`constructor` category key is an ordinary own data property and can
 * NEVER mutate `Object.prototype`; the output is a plain array (no map keyed by
 * the untrusted string), so it carries no prototype-mutation surface either.
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module; the agent
 * package may not import the memory package. The only imports are the
 * `twoProportionTest` VALUE + the `CategoryAccuracy` TYPE from in-package
 * siblings (significance.ts / qa-accuracy.ts). No `@comis/memory`.
 *
 * @module
 */

import { twoProportionTest } from "./significance.js";
import type { CategoryAccuracy } from "./qa-accuracy.js";

/**
 * The regression tolerance in accuracy points: a category is flagged ONLY when
 * the current accuracy drops MORE than this below the baseline (and the drop is
 * also significant). A drop within `[-tolerance, 0]` is treated as within-noise
 * and never red-lights the gate.
 *
 * 5.0pt mirrors the cross-judge survival tolerance (SURVIVAL_TOLERANCE_PTS):
 * per-category n=20 yields a binomial SE of ~10-11pt, so a <=5pt drop is well
 * within sampling noise. The tolerance is the first of the two gates (a tiny but
 * statistically-significant drop at huge N is still absorbed by it).
 */
export const REGRESSION_TOLERANCE_PTS = 5.0;

/** The minimal `{ correct, total }` counts the significance test reads. */
interface CountPair {
  correct: number;
  total: number;
}

/**
 * One category's regression verdict: the baseline + current accuracy (points),
 * their signed delta, whether the drop is statistically significant, and the
 * final per-category `regressed` flag (the AND of the tolerance + significance
 * gates).
 */
export interface CategoryRegression {
  /** The category label (the comparability anchor; an untrusted dataset string). */
  category: string;
  /** The committed baseline accuracy for this category (percentage points). */
  baseline: number;
  /** The current run's accuracy for this category (percentage points; 0 when absent). */
  current: number;
  /** `current - baseline` -- negative means a drop (the regression direction). */
  deltaPts: number;
  /** `true` when the current-vs-baseline count difference is significant at p<0.05. */
  significant: boolean;
  /** `true` ONLY when `deltaPts < -tolerancePts` AND `significant` -- a real regression. */
  regressed: boolean;
}

/**
 * The structured regression verdict over all baseline categories: the overall
 * `regressed` flag (any category regressed), the per-category breakdown, and a
 * secret-free human-readable summary.
 */
export interface RegressionVerdict {
  /** `true` when ANY category regressed -- the value the scheduled CI job exits non-zero on. */
  regressed: boolean;
  /** One {@link CategoryRegression} per baseline category with a finite accuracy in BOTH runs. */
  perCategory: CategoryRegression[];
  /** A one-line, structurally secret-free summary naming any regressed category. */
  summary: string;
}

/**
 * Rebuild a null-prototype `category -> { correct, total }` count map from a
 * per-category accuracy map, copying ONLY the numeric `correct`/`total` scalars
 * of each bucket (coerced). Never spreads the input bucket; a
 * `__proto__`/`constructor` key is an inert own data property; a bucket whose
 * counts are not finite numbers (e.g. a secret-shaped string hung at the category
 * level) is mapped to a sentinel non-finite pair so the caller's finite-guard
 * drops it (it can never leak a string into the output).
 */
function projectCounts(perCategory: Record<string, CategoryAccuracy>): Record<string, CountPair> {
  const map: Record<string, CountPair> = Object.create(null) as Record<string, CountPair>;
  for (const key of Object.keys(perCategory)) {
    // `Object.keys` yields only present keys and the project does not set
    // `noUncheckedIndexedAccess`, so the indexed access is a defined value of
    // the declared `CategoryAccuracy` element type. A real bucket has numeric
    // counts; a secret-shaped string value coerces to NaN here (never copied as
    // a string), and the caller drops the category via the finite-guard.
    const bucket = perCategory[key] as unknown as { correct?: unknown; total?: unknown };
    map[key] = {
      correct: Number(bucket?.correct),
      total: Number(bucket?.total),
    };
  }
  return map;
}

/** Accuracy as `correct / total * 100`, guarded to 0 when `total <= 0` (never NaN). */
function pct(correct: number, total: number): number {
  return total > 0 ? (correct / total) * 100 : 0;
}

/**
 * Pure: compare a CURRENT run's per-category accuracy against a committed
 * BASELINE's, returning the structured {@link RegressionVerdict}.
 *
 * Iterates the BASELINE categories (the comparability anchor). For each:
 *   - the current counts fall back to `{ correct: 0, total: <baseline.total> }`
 *     when the category is ABSENT from the current run (a dropped category is a
 *     regression to 0, tested at the baseline's N), never a crash;
 *   - a category whose baseline counts are NOT finite numbers (off-contract
 *     pollution -- a secret-shaped string hung at the category level) is DROPPED
 *     (a real per-category accuracy is always finite), so the output carries only
 *     real, comparable categories and no secret string ever reaches it;
 *   - `regressed` is the AND of (a) the current accuracy is more than
 *     `tolerancePts` below the baseline AND (b) the count difference is
 *     statistically significant (`twoProportionTest`).
 *
 * SECURITY: each output entry is rebuilt from numerically-coerced scalars + a
 * copied primitive category string -- the input bucket is never spread. The
 * intermediate count maps are null-prototype (prototype-pollution-safe). The
 * `summary` is composed only from the rebuilt numeric/boolean fields + category
 * strings -- never from a raw input value.
 *
 * @param currentPerCategory the current run's per-category accuracy (from the run manifest)
 * @param baselinePerCategory the committed baseline's per-category accuracy
 * @param tolerancePts the regression tolerance (default {@link REGRESSION_TOLERANCE_PTS})
 * @returns the {@link RegressionVerdict} (`{ regressed, perCategory, summary }`)
 */
export function compareToBaseline(
  currentPerCategory: Record<string, CategoryAccuracy>,
  baselinePerCategory: Record<string, CategoryAccuracy>,
  tolerancePts = REGRESSION_TOLERANCE_PTS,
): RegressionVerdict {
  // Null-prototype intermediates: a `__proto__`/`constructor` category key is an
  // inert own data property here, never a prototype mutation.
  const baseCounts = projectCounts(baselinePerCategory);
  const curCounts = projectCounts(currentPerCategory);

  const perCategory: CategoryRegression[] = [];
  for (const category of Object.keys(baseCounts)) {
    const b = baseCounts[category];
    // SECURITY: drop any category whose baseline counts are non-finite. A real
    // per-category accuracy is always finite; a secret-shaped KEY whose value is
    // a non-numeric string coerces to NaN in projectCounts and is structurally
    // omitted here, so its key never leaks into a `category` entry.
    if (!Number.isFinite(b.correct) || !Number.isFinite(b.total)) continue;

    // Absent-in-current -> current counts as 0 correct over the baseline's N (a
    // dropped category is a regression to 0, tested at a real denominator).
    const rawCur = category in curCounts ? curCounts[category] : undefined;
    const cur: CountPair =
      rawCur !== undefined && Number.isFinite(rawCur.correct) && Number.isFinite(rawCur.total)
        ? rawCur
        : { correct: 0, total: b.total };

    const baseline = pct(b.correct, b.total);
    const current = pct(cur.correct, cur.total);
    const deltaPts = current - baseline;

    // The two-proportion z-test reads the raw counts (a percentage cannot be
    // tested). A zero denominator / zero pooled SE returns significant:false.
    const { significant } = twoProportionTest(
      { correct: cur.correct, total: cur.total },
      { correct: b.correct, total: b.total },
    );

    // Both gates: a materially large drop (below baseline beyond the tolerance
    // band) AND a statistically significant one. Within-noise drops never fire.
    const regressed = deltaPts < -tolerancePts && significant;

    perCategory.push({
      // `category` is a primitive string copied as-is (a key, not a value); it
      // carries no secret -- the secret-bearing surface is the bucket value,
      // coerced to numbers above.
      category,
      baseline,
      current,
      deltaPts,
      significant,
      regressed,
    });
  }

  const regressedCats = perCategory.filter((c) => c.regressed).map((c) => c.category);
  const regressed = regressedCats.length > 0;
  const summary = regressed
    ? `REGRESSION: ${regressedCats.length} categor${regressedCats.length === 1 ? "y" : "ies"} below baseline beyond ${tolerancePts}pt and significant — ${regressedCats.join(", ")}`
    : `no regression across ${perCategory.length} categor${perCategory.length === 1 ? "y" : "ies"} (tolerance ${tolerancePts}pt, significance-gated)`;

  return { regressed, perCategory, summary };
}
