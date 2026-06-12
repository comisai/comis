// SPDX-License-Identifier: Apache-2.0
/**
 * scriptTokenFactor(text): the per-script chars-per-token multiplier in (0, 1].
 *
 * Every estimator call site divides by `ratio * scriptTokenFactor(text)` where
 * `text` is the exact string whose `.length` is divided — one rule, every site.
 *
 * Combination across script classes is HARMONIC per-row share summation
 * (`1/f = sum(share_i / f_i)`), NOT an arithmetic mean: tokens add per-class,
 * so `len/(R*f)` must equal `sum(len_i/(R*f_i))`. Probe evidence: a mixed
 * Hebrew+Latin string measured 15 real qwen tokens — harmonic estimates 15
 * exactly, arithmetic estimates 14 (an anti-conservative under-count)
 * [179-RESEARCH Pattern 3, qwen3-coder:30b probe 2026-06-12].
 *
 * Pure function, same purity rules as script-classes.ts: no I/O/clock/env
 * (I9), no regex (V5). Imported relatively (same-package rule, never via the
 * @comis/core barrel).
 * @module
 */
import { classifyCodepointToRow } from "./script-classes.js";

/**
 * Harmonic share-weighted token factor in (0, 1]; returns 1.0 for
 * empty/all-neutral/pure-ASCII text (I1 — Latin byte-identity). Shares are
 * UTF-16 code units (matching the `.length` the estimators divide), weighted
 * per table ROW (not per class) so combining-mark rows carry their own,
 * lower factor than the letter rows of the same class.
 */
export function scriptTokenFactor(text: string): number {
  void text;
  void classifyCodepointToRow;
  throw new Error("not implemented");
}
