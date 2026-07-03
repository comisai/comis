// SPDX-License-Identifier: Apache-2.0
/**
 * Pure full-haystack "filesystem dump" formatter — the Letta-style
 * filesystem-tool CONTROL the gated QA harness records as a labelled control row.
 *
 * WHAT IT IS (the minimal in-harness control): instead of
 * Comis's ranked recall (a top-5 `MemorySearchResult[]`), this dumps the ENTIRE
 * conversation haystack — every doc, in deterministic order, with NO relevance
 * scoring and NO top-k truncation — and lets the SAME answer model read it, graded
 * by the SAME judge. It is a deliberately-trivial no-memory reference: if a
 * full-dump baseline ties/beats Comis's ranked recall on a benchmark, the
 * *benchmark* is weak, not Comis (exactly how Letta showed a filesystem agent
 * scored 74.0% on LoCoMo, above Mem0's self-reported 68.5%). It is recorded ONLY under an
 * explicit control label — NEVER as Comis's own score.
 *
 * COMPARABLE SHAPE: each doc is rendered as the SAME numbered + dated block that
 * `formatAnswerContext` (qa-answer-prompt.ts:61) uses for the recall path, so the
 * only difference the harness measures between this control and Comis's recall is
 * "full dump" vs "ranked top-5", NOT context formatting. The dated anchor is the
 * doc's `createdAt` via the sanctioned `systemDateFrom` indirection (this is
 * `src/`; the globals rule scopes to `src/**`), exactly like qa-answer-prompt.ts.
 *
 * SECURITY — prototype-pollution discipline: the doc `content`
 * strings come from the UNTRUSTED dataset haystack. The dump is built by string
 * concatenation ONLY; doc content is NEVER used as an object key, so a
 * `"__proto__"` / `"constructor"` content value becomes ordinary rendered text and
 * can NEVER mutate `Object.prototype`. The ordering uses a numeric-keyed decorate-
 * sort-undecorate over a fresh array (no dataset-derived keys), mirroring
 * qa-accuracy.ts / longmemeval-loader.ts's null-proto + literal-key discipline.
 *
 * PURE: no clock read (the timestamps come from the docs), no I/O, no
 * @comis/memory import. ARCHITECTURE CUT (architecture-graph.test.ts): the agent
 * package may not import the memory package — this module imports ONLY
 * `systemDateFrom` from `@comis/core` (the same single import qa-answer-prompt.ts
 * uses). The live store + recall wiring lives in the gated `.bench.test.ts` (the
 * single cut escape).
 *
 * @module
 */

import { systemDateFrom } from "@comis/core";

/** Explicit sentinel for an empty haystack — keeps the formatter total (never throws). */
const EMPTY_HAYSTACK_SENTINEL = "(empty filesystem)";

/** One ingestable dated document — the `{content, createdAt}` shape both loaders emit. */
interface HaystackDoc {
  /** The document content (UNTRUSTED dataset text; rendered verbatim, never used as a key). */
  content: string;
  /** Event/record time as epoch-ms (the dated-document anchor + the sort key). */
  createdAt: number;
}

/**
 * Format the FULL haystack as a single "filesystem dump" context string — the
 * Letta-style control context for one question.
 *
 * Dumps EVERY doc (no relevance ranking, no top-k truncation — the load-bearing
 * difference from ranked recall), sorted by `createdAt` ascending with a STABLE
 * tie-break (equal `createdAt` keeps input order), each rendered as the same
 * numbered + dated block `formatAnswerContext` uses so the answer model sees a
 * comparable context shape. An empty haystack yields the explicit
 * {@link EMPTY_HAYSTACK_SENTINEL} — the formatter is TOTAL and never throws.
 *
 * Pure: no clock (timestamps come from the docs), no I/O, no memory-package
 * import. Prototype-pollution-safe: built by string concatenation only; doc
 * content is never an object key.
 */
export function formatFilesystemContext(docs: ReadonlyArray<HaystackDoc>): string {
  if (docs.length === 0) {
    return EMPTY_HAYSTACK_SENTINEL;
  }
  // Decorate-sort-undecorate over a FRESH array: carry the original index so the
  // sort is STABLE on equal `createdAt` (independent of the engine's sort
  // stability), and so the comparator touches only numeric fields — never a
  // dataset-derived string key (prototype-pollution-safe ordering).
  const ordered = docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => a.doc.createdAt - b.doc.createdAt || a.index - b.index);

  // Concatenate the rendered blocks. The doc `content` is interpolated as TEXT
  // only (never an object key), so an attacker-shaped `"__proto__"` content value
  // cannot pollute any prototype.
  return ordered
    .map(({ doc }, i) => {
      const date = systemDateFrom(doc.createdAt).toISOString();
      return `[${i + 1}] (${date}) ${doc.content}`;
    })
    .join("\n");
}
