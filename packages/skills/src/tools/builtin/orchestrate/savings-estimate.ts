// SPDX-License-Identifier: Apache-2.0
/**
 * `savings-estimate` — a pure, total estimator of the context tokens an
 * orchestrate run saved by materializing large tool returns to disk (as a
 * `ResultRef`) instead of re-entering them into the model context.
 *
 * It is a labeled ESTIMATE, not exact accounting — honesty over precision:
 *   - the shipped ~4-bytes-per-token proxy ({@link BYTES_PER_TOKEN});
 *   - MATERIALIZED-ONLY — it counts only the over-threshold returns that became
 *     `ResultRef` files on disk; sub-threshold inline returns are excluded;
 *   - POST-BOUNCE — the "actual" side is the bounded stdout that actually
 *     re-entered context, not the raw pre-bounce size.
 *
 *   wouldBeTokens  ≈ materializedBytes / 4        (had each over-threshold
 *                                                  return been its own
 *                                                  tool-result turn)
 *   actualTokens   ≈ stdoutCharsReentered / 4     (the bounded stdout re-entry)
 *   estSavedTokens = max(0, wouldBeTokens − actualTokens)   (never negative)
 *   savedRatio     = wouldBeTokens > 0 ? estSavedTokens / wouldBeTokens : 0
 *
 * Content-free: it takes and returns numbers only — never bytes-content, never a
 * path. Pure arithmetic: no I/O, no globals, total over any finite non-negative
 * input (a caller-facing boundary maps a run's measured bytes to these numbers).
 *
 * @module
 */

/**
 * The bytes→tokens proxy: roughly four bytes per token. A deliberate
 * rule-of-thumb, not a tokenizer — the estimate is labeled as such.
 */
const BYTES_PER_TOKEN = 4;

/** The estimate's shape: the counterfactual, the actual, the saved delta + ratio. */
export interface SavingsEstimate {
  /** Tokens the materialized returns WOULD have added had each re-entered context. */
  readonly wouldBeTokens: number;
  /** Tokens the bounded stdout actually re-entered context with. */
  readonly actualTokens: number;
  /** max(0, wouldBeTokens − actualTokens) — the saved delta, never negative. */
  readonly estSavedTokens: number;
  /** estSavedTokens / wouldBeTokens in [0, 1]; 0 when nothing was materialized. */
  readonly savedRatio: number;
}

/**
 * Estimate the context tokens a run saved by materializing large tool returns
 * instead of re-entering them. Both inputs are byte/char counts the runner
 * measures (the materialized `ResultRef` bytes; the post-bounce stdout chars);
 * this helper is a pure function of the two.
 */
export function estimateSavings(
  materializedBytes: number,
  stdoutCharsReentered: number,
): SavingsEstimate {
  const wouldBeTokens = Math.round(materializedBytes / BYTES_PER_TOKEN);
  const actualTokens = Math.round(stdoutCharsReentered / BYTES_PER_TOKEN);
  const estSavedTokens = Math.max(0, wouldBeTokens - actualTokens);
  const savedRatio = wouldBeTokens > 0 ? estSavedTokens / wouldBeTokens : 0;
  return { wouldBeTokens, actualTokens, estSavedTokens, savedRatio };
}
