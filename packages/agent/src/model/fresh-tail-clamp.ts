// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve the clamped fresh-tail turn count, bounded so the verbatim fresh
 * tail cannot alone consume more than 30% of the effective context window.
 *
 * Rules:
 * - If effectiveWindow is not finite (frontier/mid models), returns
 *   configuredTurns UNCHANGED — byte-identical guarantee.
 * - Conservative 30% budget floor (§7 open measurement question):
 *   affordable = floor(effectiveWindow * 0.3 / avgTokPerStep)
 * - Returns min(configuredTurns, affordable), minimum 1.
 * - The 30% fraction is a placeholder until the Phase-171 harness measures
 *   actual recall impact. Do not treat it as a calibrated constant.
 *
 * Pure function — no side effects, no async, no DI. All context passed
 * as parameters. Mirrors the effective-context-window.ts pattern.
 *
 * @module
 */

/**
 * Resolve a clamped fresh-tail turn count from the effective context window.
 *
 * @param effectiveWindow - The reconciled effective window in tokens
 *   (pass `Infinity` for frontier/mid — clamp will not fire).
 * @param configuredTurns - The operator-configured freshTailTurns value
 *   (from schema default 8, min 1, max 50).
 * @param avgTokensPerStep - Optional estimated tokens per conversation step.
 *   If omitted, estimated as `max(1, floor(effectiveWindow / 20))` (5% floor).
 * @returns The clamped turn count — always ≥ 1, always ≤ configuredTurns.
 *
 * NB (ISSUE #1, 2026-06-22): this turn-count clamp is the COARSE upper bound only.
 * The PRECISE residual enforcement for the protected fresh tail (so it always fits a
 * small window where the system prompt dominates) lives in the lcd-assembler as a
 * post-B-8 TOTAL token bound (boundFreshTailTotalToResidual) — a turn-count clamp is
 * unreliable there because one oversized message (which B-8 bounds anyway) skews the
 * per-step estimate.
 */
export function resolveClampedFreshTailTurns(
  effectiveWindow: number,
  configuredTurns: number,
  avgTokensPerStep?: number,
): number {
  if (!isFinite(effectiveWindow)) return configuredTurns; // frontier/mid: byte-identical
  // Estimate tokens per step if not provided (5% of effectiveWindow as single-step floor)
  const tokPerStep =
    avgTokensPerStep !== undefined && avgTokensPerStep > 0
      ? avgTokensPerStep
      : Math.max(1, Math.floor(effectiveWindow / 20));
  const budget = Math.floor(effectiveWindow * 0.3);
  const affordable = Math.max(1, Math.floor(budget / tokPerStep));
  return Math.min(configuredTurns, affordable);
}
