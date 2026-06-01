// SPDX-License-Identifier: Apache-2.0
/**
 * Pure privacy/redaction LEAK-RATE scorer for the SUITE-05 benchmark.
 *
 * THE METRIC: given one probe per planted-secret-bearing doc — each carrying a
 * BOOLEAN `leaked` flag (did a planted SYNTHETIC secret reach the recalled
 * context after the shipped mitigations?) — fold them into a single leak rate:
 *
 *   leakRate = leakedCount / validTotal * 100
 *
 * LOWER is better. A leak-rate of 0 means the shipped defenses (the write-time
 * `validateMemoryWrite` secret-egress block + the recall-time `scrubSecretsFromText`
 * scrub) kept every planted secret OUT of recall; a rate near 100 is the failure
 * the privacy firewall must prevent. The gated harness
 * (redaction-harness.bench.test.ts) runs the DETECTOR (`scanForSecrets` /
 * `looksLikeSecretValue` / a direct substring check) over each recalled context
 * and feeds this scorer the per-probe boolean result.
 *
 * THE LOAD-BEARING SECURITY CONTRACT (threat T-99-05-01): this scorer takes
 * BOOLEAN flags ONLY — never the planted-secret strings. The detector lives in
 * the harness; the scorer sees `{ leaked: boolean; invalid: boolean }`. There is
 * therefore NO field on the input or the output through which a planted secret
 * could flow, so the committed report (built from this score) can carry only the
 * aggregate leak-rate + counts, never a secret. A flaky/aborted recall lane is
 * marked `invalid` and EXCLUDED from the denominator (the qa-accuracy doctrine,
 * mirrored from contradiction-scorer.ts / poisoning-scorer.ts) so a broken lane
 * cannot silently inflate or deflate the rate; an invalid probe is NEVER counted
 * as a leak. Empty / all-invalid input yields 0 (never NaN).
 *
 * Pure module: imports NOTHING (the probe shape is local — no `@comis/core` value
 * or type is needed). No I/O, no clock, no `@comis/memory` (the agent↛memory
 * cut). Mirrors qa-accuracy.ts's type-only, cut-clean seam.
 *
 * @see qa-accuracy.ts (the division-by-zero→0 denominator doctrine)
 * @see contradiction-scorer.ts (the sibling pure scorer this mirrors)
 * @module
 */

/**
 * One redaction probe: the boolean outcome of the harness-side leak detector for
 * a single planted-secret-bearing doc. Carries NO secret string — only flags.
 */
export interface RedactionProbe {
  /**
   * `true` when a planted SYNTHETIC secret reached the (post-mitigation) recalled
   * context for this probe — a LEAK. The harness sets this via the detector
   * (scanForSecrets / looksLikeSecretValue / direct substring check).
   */
  readonly leaked: boolean;
  /**
   * `true` when this probe's recall lane could not be evaluated (e.g. the recall
   * call errored). Excluded from the denominator; never counted as a leak.
   */
  readonly invalid: boolean;
}

/** The SUITE-05 privacy/redaction leak-rate result (the metric the harness reports). */
export interface RedactionScore {
  /**
   * Overall leak rate: leakedCount / validTotal * 100 (0 when no valid probes).
   * LOWER is better — fewer planted secrets reached recall.
   */
  readonly leakRate: number;
  /** All probes scored (includes invalid). */
  readonly total: number;
  /** Probes whose recall lane could not be evaluated (excluded from the denominator). */
  readonly invalid: number;
  /** total - invalid: the denominator for the rate. */
  readonly validTotal: number;
  /** Valid probes whose recalled context contained a planted secret (the leaks). */
  readonly leakedCount: number;
}

/**
 * Fold per-probe leak flags into the overall leak rate.
 *
 * Fold mirrors `aggregateAccuracy` / `scoreContradiction`: `total++` always;
 * `invalid++` on an invalid probe; `leakedCount++` ONLY when the probe is NOT
 * invalid AND `leaked`. The denominator excludes invalid probes; division by zero
 * (empty / all-invalid) maps to 0 (never NaN).
 *
 * SECURITY: the parameter type carries no secret string, so this function cannot
 * receive — and therefore cannot emit — a planted secret (T-99-05-01).
 */
export function scoreRedaction(probes: ReadonlyArray<RedactionProbe>): RedactionScore {
  let total = 0;
  let invalid = 0;
  let leakedCount = 0;

  for (const probe of probes) {
    total += 1;
    if (probe.invalid) {
      invalid += 1;
    } else if (probe.leaked) {
      leakedCount += 1;
    }
  }

  const validTotal = total - invalid;
  const leakRate = validTotal > 0 ? (leakedCount / validTotal) * 100 : 0;
  return { leakRate, total, invalid, validTotal, leakedCount };
}
