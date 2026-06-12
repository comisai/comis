// SPDX-License-Identifier: Apache-2.0
/**
 * Unicode script classification: the SCRIPT_CLASSES data table plus the pure
 * classifier functions over it (classifyCodepointToRow, classifyCodepoint,
 * scriptShares, dominantScript).
 *
 * Single source of truth for per-script token factors (Phase 179 estimators),
 * FTS routing (Phase 180), and observability event classes (Phases 180/181).
 * Adding a script later is a data edit — append a row, never a new mechanism.
 *
 * Defined in @comis/core so @comis/agent (Phase 179 estimators),
 * @comis/memory and @comis/skills (Phase 180 FTS routing), and the executor
 * (Phase 181 reply-language resolver) can import it without creating a
 * package cycle. NO imports from any @comis package — this file is pure
 * static data + pure functions, no I/O/clock/env (I9), and contains no
 * regex (V5 — zero ReDoS surface; classification is a single O(n)
 * codepoint-range scan, allocation bounded by the table size, never by input).
 * @module
 */

/** The closed set of script classes the estimator/router/resolver tiers consume. */
export type ScriptClass =
  | "latin"
  | "cyrillic"
  | "hebrew"
  | "arabic"
  | "cjk"
  | "thai"
  | "greek"
  | "devanagari"
  | "other";

/** One row of the SCRIPT_CLASSES table. Rows are scanned in declaration order
 *  (first-match-wins), so a combining-marks row placed BEFORE its letters row
 *  takes the lower factor for ambiguous codepoints (I3). */
export interface ScriptClassRow {
  readonly class: ScriptClass;
  /** Inclusive codepoint ranges `[lo, hi]`. Empty for the `other` fallback row. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  /** Chars-per-token multiplier in (0, 1]; latin === 1.0 exactly (I1). */
  readonly tokenFactor: number;
}

/** Per-script classification table. First-match-wins; mark rows precede their
 *  letter rows. Populated in Task 2 (GREEN). */
export const SCRIPT_CLASSES: ReadonlyArray<ScriptClassRow> = [];

/**
 * Matched row, OR the `other` fallback row for unmatched non-ASCII, OR null
 * for neutral ASCII (digits/punct/whitespace/controls — excluded from shares).
 */
export function classifyCodepointToRow(cp: number): ScriptClassRow | null {
  void cp;
  throw new Error("not implemented");
}

/** Class of the matched row (see classifyCodepointToRow), or null for neutral ASCII. */
export function classifyCodepoint(cp: number): ScriptClass | null {
  void cp;
  throw new Error("not implemented");
}

/**
 * UTF-16-unit-weighted shares over non-neutral chars; the values sum to 1
 * when any non-neutral char exists; empty Map otherwise.
 */
export function scriptShares(text: string): ReadonlyMap<ScriptClass, number> {
  void text;
  throw new Error("not implemented");
}

/**
 * Largest non-Latin class when the total non-Latin share >= 0.30, else the
 * overall argmax; "latin" for empty/all-neutral text.
 */
export function dominantScript(text: string): ScriptClass {
  void text;
  throw new Error("not implemented");
}
