// SPDX-License-Identifier: Apache-2.0
/**
 * Resolve the clamped fresh-tail turn count, bounded so the verbatim fresh
 * tail cannot alone consume more than 30% of the effective context window.
 *
 * Rules:
 * - If effectiveWindow is not finite (frontier/mid models), returns
 *   configuredTurns UNCHANGED — byte-identical guarantee.
 * - Conservative 30% budget floor:
 *   affordable = floor(effectiveWindow * 0.3 / avgTokPerStep)
 * - Returns min(configuredTurns, affordable), minimum 1.
 * - The 30% fraction is a conservative placeholder pending real recall-impact
 *   measurement. Do not treat it as a calibrated constant.
 *
 * Pure function — no side effects, no async, no DI. All context passed
 * as parameters. Mirrors the effective-context-window.ts pattern.
 *
 * @module
 */

/**
 * The fraction of the effective window the verbatim fresh tail may occupy on its
 * own. Conservative placeholder pending real recall-impact measurement — do not
 * treat it as a calibrated constant.
 */
const FRESH_TAIL_WINDOW_FRACTION = 0.3;

/**
 * Absolute per-step token estimate used when the caller supplies none.
 *
 * ⚠ This MUST NOT be derived from `effectiveWindow`. The original code estimated
 * a step at `floor(effectiveWindow / 20)` — 5% of the window — which cancels
 * against the 30% budget:
 *
 *   affordable = floor(0.3·W / (W/20)) = floor(0.3 · 20) = 6   ∀ finite W
 *
 * so the clamp returned the constant **6** for every window and every configured
 * value, making `contextEngine.freshTailTurns` (schema 1..50, default 8)
 * unreachable above 6 on every deployment. Live consequence (comis-moshe
 * 2026-07-26): on a 1M-token window with 9% of it in use, a turn with four
 * background-tool cycles slid the user's own request out of the verbatim tail and
 * the agent apologized for work the user had explicitly asked for. The two
 * existing auto-estimate tests could not catch it — both only asserted
 * `1 <= result <= configured`, which a constant 6 satisfies.
 *
 * CALIBRATION — chosen so this change can only ever keep MORE context, never
 * less. At the smallest window Comis treats as viable (8,192) the value
 * reproduces the previous behaviour exactly:
 *
 *   floor(0.3 · 8192 / 400) = floor(6.14) = 6   ← the old constant
 *
 * so no deployment loses tail steps, and every window above ~11K now reaches its
 * configured value instead of being pinned at 6. Measured live step sizes on the
 * incident turn were `[1385, 333, 4018, 193, 49, 178, 49]` tokens (mean ≈ 890),
 * so 400 deliberately UNDER-estimates a step: this is the coarse guard, and
 * under-estimating errs toward keeping the user's own message in context. The
 * PRECISE enforcement — which is what actually protects a small window where the
 * system prompt dominates — is `boundFreshTailTotalToResidual` in the assembler
 * (a total-token bound applied after the per-message char cap), not this clamp.
 *
 * Resulting behaviour (default `configuredTurns` = 8):
 *   W = 8,192     → 6   (identical to the pre-fix behaviour)
 *   W = 16,000    → 8
 *   W = 32,000    → 8
 *   W = 128,000   → 8
 *   W = 1,000,000 → 8   (and 50 configured → 50)
 */
const COARSE_TOKENS_PER_STEP_ESTIMATE = 400;

/**
 * Resolve a clamped fresh-tail turn count from the effective context window.
 *
 * @param effectiveWindow - The reconciled effective window in tokens
 *   (pass `Infinity` for frontier/mid — clamp will not fire).
 * @param configuredTurns - The operator-configured freshTailTurns value
 *   (from schema default 8, min 1, max 50).
 * @param avgTokensPerStep - Optional estimated tokens per conversation step.
 *   If omitted, {@link COARSE_TOKENS_PER_STEP_ESTIMATE} is used — an ABSOLUTE
 *   token estimate, deliberately NOT a fraction of the window (see that
 *   constant for why a window-relative estimate made this clamp a constant).
 * @returns The clamped turn count — always ≥ 1, always ≤ configuredTurns.
 *
 * NB: this turn-count clamp is the COARSE upper bound only.
 * The PRECISE residual enforcement for the protected fresh tail (so it always fits a
 * small window where the system prompt dominates) lives in the lcd-assembler as a
 * TOTAL token bound applied after the per-message char cap
 * (boundFreshTailTotalToResidual) — a turn-count clamp is unreliable there
 * because one oversized message (which the per-message cap bounds anyway) skews
 * the per-step estimate.
 */
export function resolveClampedFreshTailTurns(
  effectiveWindow: number,
  configuredTurns: number,
  avgTokensPerStep?: number,
): number {
  if (!isFinite(effectiveWindow)) return configuredTurns; // frontier/mid: byte-identical
  // The per-step estimate MUST be absolute. A window-relative estimate makes the
  // whole clamp a constant (see COARSE_TOKENS_PER_STEP_ESTIMATE).
  const tokPerStep =
    avgTokensPerStep !== undefined && avgTokensPerStep > 0
      ? avgTokensPerStep
      : COARSE_TOKENS_PER_STEP_ESTIMATE;
  const budget = Math.floor(effectiveWindow * FRESH_TAIL_WINDOW_FRACTION);
  const affordable = Math.max(1, Math.floor(budget / tokPerStep));
  return Math.min(configuredTurns, affordable);
}
