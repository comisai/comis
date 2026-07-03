// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded chunked `String.replace` — ReDoS work-cap guard.
 *
 * The plain `input.replace(pattern, repl)` invocation is vulnerable to
 * catastrophic regex backtracking on adversarial inputs: a pattern like
 * `/(a+)+b/` against a long string of `'a'` exhibits worst-case
 * exponential backtracking, hanging the event loop for seconds-to-minutes.
 *
 * This helper bounds the per-call work by slicing the input into
 * `CHUNK_SIZE`-char chunks when the input exceeds `SINGLE_PASS_THRESHOLD`,
 * running `replace` independently on each chunk, then re-joining. The
 * chunk size is 16 384 chars — half the threshold — so even worst-case
 * quadratic-backtracking patterns complete in linear-in-input wall time
 * (each chunk's backtracking is capped at chunk-size²).
 *
 * Trade-off: a regex match that straddles a chunk boundary is missed.
 * For the credential patterns used in the redactor — all of which are
 * anchored on a fixed-byte-length prefix (`sk-`, `ghp_`, `Authorization:`,
 * etc.) or have explicit word boundaries — the chunk size is far larger
 * than any conceivable credential, so cross-chunk straddle is not a
 * practical concern.
 *
 * Single-pass below the threshold (≤ 32 768 chars) so the small-input
 * fast path stays a single `replace` call.
 *
 * Pure function — no I/O, no clock, no fs.
 *
 * @module
 */

/** Inputs at or below this length use a single full-input `replace` call. */
const SINGLE_PASS_THRESHOLD = 32_768;

/** Chunk size used when slicing above the threshold (half of threshold). */
const CHUNK_SIZE = 16_384;

/**
 * Replacement value — either a literal string, or a function with the
 * same shape as `String.prototype.replace`'s replacer callback.
 *
 * The function signature only models the (match, ...groups) shape used
 * by the redactor patterns; the index + offset overloads of
 * `String.replace` are not needed here and are omitted to keep the
 * type narrow.
 */
export type BoundedReplacer = string | ((match: string, ...groups: string[]) => string);

/**
 * Apply `pattern.replace(repl)` to `input`, slicing into chunks above
 * `SINGLE_PASS_THRESHOLD` to cap per-call regex backtracking work.
 *
 * @param input - the string to scan
 * @param pattern - a `RegExp` (must be `/g` for multi-match semantics)
 * @param repl - the replacement string or callback
 * @returns the transformed string (chunks rejoined)
 */
export function replacePatternBounded(
  input: string,
  pattern: RegExp,
  repl: BoundedReplacer,
): string {
  if (input.length <= SINGLE_PASS_THRESHOLD) {
    // The `as never` cast routes through the union overload of
    // String.replace; both `string` and the callback form are
    // structurally accepted, but TS infers a literal-string return path
    // first and complains about the callback case.
    return input.replace(pattern, repl as never);
  }

  const out: string[] = [];
  for (let start = 0; start < input.length; start += CHUNK_SIZE) {
    const chunk = input.slice(start, start + CHUNK_SIZE);
    out.push(chunk.replace(pattern, repl as never));
  }
  return out.join("");
}
