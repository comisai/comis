// SPDX-License-Identifier: Apache-2.0
/**
 * Pure O(1) slice-boundary backoff: no I/O/clock/env. Adjust a
 * raw UTF-16 cut index so a truncation never splits a surrogate pair or orphans
 * a base char's trailing combining/joiner/variation-selector sequence — the
 * result is mojibake-free for the served scripts (Hebrew niqqud,
 * emoji-ZWJ families, astral CJK).
 *
 * Single source of truth: the content-length truncation cut sites in
 * @comis/agent (tool-result-size-guard.ts) and @comis/daemon
 * (template-interpolation.ts) ALL import THIS symbol — never a copy. The helper
 * only MOVES an index backward; it injects nothing (so the truncation marker,
 * which stays plain English + newline-isolated, gains no bidi-control codepoint
 * at its boundary).
 *
 * Detection uses Node's native ECMAScript Unicode property escapes under the `u`
 * flag (probed live on Node v22.21.1: `\p{M}`/`\p{Join_Control}`/
 * `\p{Variation_Selector}` all supported) — NOT `Intl.Segmenter` (REJECTED:
 * full grapheme segmentation of a 50K string to move two indices is O(n)
 * over-engineering for an O(1) need, and would add no dependency-free guarantee)
 * and NOT a reuse of the SCRIPT_CLASSES combining ranges (those are scoped to
 * the served-script set, not all Unicode marks). NO imports from any @comis
 * package — pure data + a pure function.
 * @module
 */

/** Bounded backoff: a pathological combining-mark/joiner run cuts anyway after
 *  this many code units, so the helper stays O(1) on a 50K string. */
const MAX_BACKOFF = 16;

/** Trailing combiner/joiner/variation-selector test. `\p{M}` = Mn/Me combining
 *  marks; `\p{Join_Control}` = ZWJ (U+200D); `\p{Variation_Selector}` = the
 *  selectors U+FE00–FE0F + supplement U+E0100–E01EF (NOT `\p{M}`, hence their own
 *  escape). Requires the `u` flag. */
const TRAILING_COMBINER = /\p{M}|\p{Join_Control}|\p{Variation_Selector}/u;

/**
 * Adjust a raw UTF-16 cut index to a safe boundary (≤ the original index).
 *
 * @param text  - the text being cut (already-ingested machine content; this adds
 *   no new input surface).
 * @param index - the raw UTF-16 cut index computed by the caller (a head/tail
 *   truncation target).
 * @returns the adjusted index: never inside a surrogate pair, never immediately
 *   after a base char's trailing combining/joiner/VS run; bounded backoff, then
 *   cuts anyway. An ASCII boundary is a no-op (returns the index unchanged).
 */
export function adjustSliceBoundary(text: string, index: number): number {
  if (index <= 0) return 0; // clamp low (also covers an empty string)
  if (index >= text.length) return text.length; // clamp high

  let i = index;

  // 1) Surrogate: if the unit AT the cut index is a LOW surrogate (0xDC00–0xDFFF)
  //    the cut lands mid-pair — step back one unit to the pair start.
  const code = text.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff) i -= 1;

  // 2) Combiner/joiner/VS backoff: while the codepoint ENDING just before i is a
  //    combiner, step the index back past it (and the base char it modifies),
  //    bounded. Surrogate-aware: a low surrogate just before i means a 2-unit
  //    codepoint starts at i-2.
  let backoff = 0;
  while (i > 0 && backoff < MAX_BACKOFF) {
    const prevIsPairLow =
      i >= 2 &&
      text.charCodeAt(i - 1) >= 0xdc00 &&
      text.charCodeAt(i - 1) <= 0xdfff &&
      text.charCodeAt(i - 2) >= 0xd800 &&
      text.charCodeAt(i - 2) <= 0xdbff;
    const cpStart = prevIsPairLow ? i - 2 : i - 1;
    const cp = text.codePointAt(cpStart) ?? 0;
    if (TRAILING_COMBINER.test(String.fromCodePoint(cp))) {
      i = cpStart; // drop the combiner; keep scanning to also drop its base char
      backoff += 1;
      continue;
    }
    break; // landed on a base char (or non-combiner) — a safe boundary
  }

  return i;
}
