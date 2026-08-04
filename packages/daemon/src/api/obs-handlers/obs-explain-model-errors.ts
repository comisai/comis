// SPDX-License-Identifier: Apache-2.0
/**
 * The `modelErrors` signal fold — the per-category tally of LLM calls the
 * PROVIDER rejected, read off `model.completed` trajectory records.
 *
 * Extracted into this sibling (the `obs-explain-recall-verdict.ts` discipline)
 * to keep `obs-explain-signals.ts` under the 1000-line `obs-handlers/*` subdir
 * cap. PURE: no LLM, no I/O, no globals.
 *
 * Feeds `providerRejectedRequestVerdict`. Before this signal existed a session
 * whose every LLM call was rejected carried no failure evidence at all —
 * `failures[]` is tool-boundary-shaped (toolName/resultDigest/argsPreview), so
 * a provider-side rejection left only `stopReason:"error"` and the root-cause
 * heuristic fell through to incidental evidence.
 *
 * @module
 */

/** Per-category tally accumulated across a session's `model.completed` records. */
export type ModelErrorCounts = Record<string, number>;

/** The emitted signal shape (dominant category first). */
export interface ModelErrorsSignal {
  total: number;
  byCategory: Record<string, number>;
}

/**
 * Fold one `model.completed` record's `modelErrorCategory` into the tally.
 * Returns the updated counts, or the input unchanged when the record carried no
 * category (a healthy call, or an older trajectory written before the field).
 */
export function foldModelErrorCategory(
  counts: ModelErrorCounts | undefined,
  category: string | undefined,
): ModelErrorCounts | undefined {
  if (category === undefined || category.length === 0) return counts;
  const next = counts ?? {};
  next[category] = (next[category] ?? 0) + 1;
  return next;
}

/**
 * Project the tally onto a spread-ready signal field, ordered
 * dominant-category-first with a name tie-break so the downstream verdict is
 * deterministic for a given trajectory. Returns `{}` when no model call
 * errored, so the emitted signals object stays byte-for-byte unchanged on a
 * healthy session (the presence-conditional discipline its siblings use).
 */
export function modelErrorsField(
  counts: ModelErrorCounts | undefined,
): { modelErrors?: ModelErrorsSignal } {
  if (counts === undefined) return {};
  const entries = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return {};
  return {
    modelErrors: {
      total: entries.reduce((sum, [, n]) => sum + n, 0),
      byCategory: Object.fromEntries(entries),
    },
  };
}
