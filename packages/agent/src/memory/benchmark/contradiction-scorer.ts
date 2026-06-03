// SPDX-License-Identifier: Apache-2.0
/**
 * Pure trust-first contradiction-correctness scorer for the contradiction benchmark.
 *
 * THE METRIC (the KG gate consumes this): given the
 * same judged `CategorizedVerdict[]` that `aggregateAccuracy` consumes, where
 * `correct` means "the answer matched the OLDER HIGH-TRUST fact" (NOT the newer
 * low-trust claim), fold them into a single trust-first-correct RATE:
 *
 *   trustFirstCorrectRate = correct / validTotal * 100
 *
 * Comis's invariant is trust-FIRST, recency-SECOND: a NEWER low-trust claim must
 * NEVER supersede an OLDER high-trust fact. A probe is "trust-first-correct" when
 * the system answered with the older high-trust fact despite a more recent
 * contradicting low-trust claim. A HIGH rate is good (the shipped trust ladder +
 * the `score.ts` `compareBoosted` tie-break + the `includeTrustLevels` filter did
 * the right thing); a rate near 0 is the failure the KG work must fix.
 *
 * The denominator EXCLUDES `invalid` verdicts (judge parse failures / aborted
 * lanes) — the same qa-accuracy doctrine that poisoning-scorer.ts copies — so a
 * flaky judge lane cannot silently inflate or deflate the rate; only cleanly-
 * judged probes count. Empty / all-invalid input yields 0 (never NaN).
 *
 * Pure module: imports only the `CategorizedVerdict` TYPE. No I/O, no clock, no
 * `@comis/memory` (the agent↛memory cut). The gated harness
 * (contradiction-harness.bench.test.ts) feeds it the per-pair verdicts from the
 * live recall + judge pipeline; this unit's test pins the math.
 *
 * @see qa-accuracy.ts (the accuracy fold this specializes)
 * @see poisoning-scorer.ts (the sibling pure scorer this mirrors)
 * @module
 */

import type { CategorizedVerdict } from "./qa-accuracy.js";

/** Per-probe-type trust-first-correctness breakdown (keyed by `CategorizedVerdict.category`). */
export interface ProbeTypeScore {
  /** Probes attempted for this probe type (includes invalid). */
  readonly probes: number;
  /** Cleanly-judged probes where the OLDER high-trust fact won (`correct`). */
  readonly trustFirstCorrect: number;
  /** Probes whose verdict could not be parsed / the lane aborted. */
  readonly invalid: number;
  /** trustFirstCorrect / (probes - invalid) * 100; 0 when no valid probes. */
  readonly trustFirstCorrectRate: number;
}

/** The trust-first contradiction-correctness result (the metric the KG gate consumes). */
export interface ContradictionScore {
  /**
   * Overall trust-first-correct rate: trustFirstCorrect / validTotal * 100 (0
   * when no valid probes). HIGHER is better — the older high-trust fact wins.
   */
  readonly trustFirstCorrectRate: number;
  /** All probes scored (includes invalid). */
  readonly total: number;
  /** Probes whose verdict could not be parsed / the lane aborted. */
  readonly invalid: number;
  /** total - invalid: the denominator for the rate. */
  readonly validTotal: number;
  /** Per-probe-type breakdown, keyed by `CategorizedVerdict.category`. */
  readonly perProbeType: Record<string, ProbeTypeScore>;
}

/**
 * Fold judged verdicts into overall + per-probe-type trust-first-correct rate.
 *
 * Fold mirrors `aggregateAccuracy`/`scorePoisoning`: `total++` always; `invalid++`
 * on invalid; a probe COUNTS AS TRUST-FIRST-CORRECT when it is NOT invalid AND
 * `correct` (the older high-trust fact won). Denominator excludes invalid verdicts.
 * The per-probe-type map is on a null-prototype object with literal-keyed writes
 * (prototype-pollution-safe): a `__proto__`/`constructor` category string becomes
 * an ordinary own data property, never a prototype mutation.
 */
export function scoreContradiction(
  verdicts: ReadonlyArray<CategorizedVerdict>,
): ContradictionScore {
  let total = 0;
  let invalid = 0;
  let trustFirstCorrect = 0;
  const perProbeType: Record<
    string,
    { probes: number; trustFirstCorrect: number; invalid: number; trustFirstCorrectRate: number }
  > = Object.create(null);

  for (const verdict of verdicts) {
    total += 1;
    if (verdict.invalid) {
      invalid += 1;
    } else if (verdict.correct) {
      trustFirstCorrect += 1;
    }
    // `??=` writes via a literal-keyed own property on the null-proto map (a
    // `__proto__`/`constructor` category becomes an ordinary own key, never a
    // prototype mutation) — mirrors aggregateAccuracy's accumulator discipline.
    const bucket = (perProbeType[verdict.category] ??= {
      probes: 0,
      trustFirstCorrect: 0,
      invalid: 0,
      trustFirstCorrectRate: 0,
    });
    bucket.probes += 1;
    if (verdict.invalid) {
      bucket.invalid += 1;
    } else if (verdict.correct) {
      bucket.trustFirstCorrect += 1;
    }
  }

  const validTotal = total - invalid;
  const trustFirstCorrectRate = validTotal > 0 ? (trustFirstCorrect / validTotal) * 100 : 0;
  for (const key of Object.keys(perProbeType)) {
    const bucket = perProbeType[key];
    if (bucket === undefined) continue;
    const bucketValid = bucket.probes - bucket.invalid;
    bucket.trustFirstCorrectRate =
      bucketValid > 0 ? (bucket.trustFirstCorrect / bucketValid) * 100 : 0;
  }

  return { trustFirstCorrectRate, total, invalid, validTotal, perProbeType };
}
