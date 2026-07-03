// SPDX-License-Identifier: Apache-2.0
/**
 * Overall + per-category QA accuracy aggregator -- folds the judged
 * verdicts into the apples-to-apples accuracy numbers the benchmark report
 * carries.
 *
 * THE LOAD-BEARING DENOMINATOR (identical to the denominator Hindsight's
 * published benchmark runner applies, keeping the numbers comparable):
 *
 *     correct    = count of valid verdicts graded correct
 *     invalid    = count of verdicts the judge could not be parsed for
 *     validTotal = total - invalid
 *     accuracy   = validTotal > 0 ? correct / validTotal * 100 : 0
 *
 * applied to BOTH the overall figure AND every per-category figure. An INVALID
 * verdict (the `undefined` from parseJudgeVerdict) is EXCLUDED from the
 * denominator -- it is NOT counted as a wrong answer. This is the integrity
 * invariant that keeps Comis's number comparable to Hindsight's published
 * figures: a judge that fails to grade does not silently depress accuracy.
 *
 * Per-category bookkeeping mirrors Hindsight exactly: `total++` ALWAYS;
 * `invalid++` when the verdict is invalid; `correct++` ONLY when the verdict is
 * valid AND correct. Division by zero (an empty set, or an all-invalid category)
 * maps to 0, never NaN -- the same discipline as recall-eval.ts's
 * `relevant.size === 0 -> 0` guard.
 *
 * PURE MATH (no Result, no throws, no I/O -- AGENTS.md 2.1 carve-out for pure
 * functions; the same carve-out recall-eval.ts uses). No clock, no randomness.
 *
 * SECURITY -- prototype-pollution discipline: the `category` strings
 * originate from the dataset `question_type` field and are UNTRUSTED. The
 * per-category accumulator is a null-prototype map (`Object.create(null)`), so a
 * `__proto__` / `constructor` / `prototype` category key becomes an ordinary own
 * data property and can NEVER mutate `Object.prototype`. The returned
 * `perCategory` is likewise a null-prototype object carrying only literal own
 * keys (mirrors locomo-loader.ts:204's prototype-pollution guard for
 * dataset-derived keys).
 *
 * ARCHITECTURE CUT (architecture-graph.test.ts:133): a PURE module; the agent
 * package may not import the memory package, and this file imports nothing at
 * all. Mirrors recall-eval.ts's type-only, cut-clean seam.
 *
 * @module
 */

/** Per-category accuracy bucket (Hindsight `total`/`invalid`/`correct` + the derived %). */
export interface CategoryAccuracy {
  /** Valid verdicts graded correct in this category. */
  correct: number;
  /** Total verdicts seen in this category (incremented unconditionally). */
  total: number;
  /** Verdicts in this category the judge could not be parsed for (excluded from the denominator). */
  invalid: number;
  /** `correct / (total - invalid) * 100`, or 0 when the valid-total is 0 (never NaN). */
  accuracy: number;
}

/** The overall + per-category accuracy result (the `qa-report.ts` `results` block). */
export interface AccuracyResult {
  /** Overall accuracy: `correct / (total - invalid) * 100`, or 0 when validTotal is 0. */
  overall: number;
  /** Total valid verdicts graded correct across all categories. */
  correct: number;
  /** Total verdicts seen across all categories. */
  total: number;
  /** Total invalid verdicts across all categories (excluded from the denominator). */
  invalid: number;
  /** `total - invalid` -- the apples-to-apples denominator. */
  validTotal: number;
  /** Per-category breakdown, keyed by the (untrusted) dataset category string. */
  perCategory: Record<string, CategoryAccuracy>;
}

/** A single judged verdict tagged with its dataset category. */
export interface CategorizedVerdict {
  /** The dataset category (`question_type`); untrusted -- may be `__proto__`. */
  category: string;
  /** Whether the (valid) verdict graded the answer correct. Ignored when `invalid`. */
  correct: boolean;
  /** `true` when the judge output could not be parsed (parseJudgeVerdict -> undefined). */
  invalid: boolean;
}

/** A mutable per-category accumulator (the internal fold state). */
interface MutableBucket {
  correct: number;
  total: number;
  invalid: number;
}

/** Accuracy as `correct / (total - invalid) * 100`, guarded to 0 when validTotal <= 0. */
function accuracyOf(correct: number, total: number, invalid: number): number {
  const validTotal = total - invalid;
  return validTotal > 0 ? (correct / validTotal) * 100 : 0;
}

/**
 * Fold judged verdicts into overall + per-category accuracy.
 *
 * Encodes the LOAD-BEARING invalid-excluded denominator (see the module doc):
 * the denominator for BOTH overall and each category is `(total - invalid)`, and
 * an invalid verdict never counts toward `correct`. Division by zero maps to 0.
 *
 * The per-category map is built on a null-prototype object so an untrusted
 * `__proto__`/`constructor` category key cannot pollute `Object.prototype`.
 */
export function aggregateAccuracy(verdicts: ReadonlyArray<CategorizedVerdict>): AccuracyResult {
  // Null-prototype accumulator: a `__proto__`/`constructor` category key is an
  // ordinary own property here, never a prototype mutation.
  const buckets: Record<string, MutableBucket> = Object.create(null) as Record<string, MutableBucket>;

  let correct = 0;
  let total = 0;
  let invalid = 0;

  for (const v of verdicts) {
    const key = v.category;
    // `??=` writes via a literal-keyed own property on the null-proto map; safe.
    const bucket = (buckets[key] ??= { correct: 0, total: 0, invalid: 0 });

    bucket.total++;
    total++;
    if (v.invalid) {
      bucket.invalid++;
      invalid++;
    } else if (v.correct) {
      bucket.correct++;
      correct++;
    }
  }

  // Materialize per-category accuracy onto a fresh null-prototype object with
  // literal own keys (no prototype reachable from the returned map).
  const perCategory: Record<string, CategoryAccuracy> = Object.create(null) as Record<
    string,
    CategoryAccuracy
  >;
  for (const key of Object.keys(buckets)) {
    const b = buckets[key];
    if (b === undefined) continue;
    perCategory[key] = {
      correct: b.correct,
      total: b.total,
      invalid: b.invalid,
      accuracy: accuracyOf(b.correct, b.total, b.invalid),
    };
  }

  return {
    overall: accuracyOf(correct, total, invalid),
    correct,
    total,
    invalid,
    validTotal: total - invalid,
    perCategory,
  };
}
