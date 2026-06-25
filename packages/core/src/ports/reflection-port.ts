// SPDX-License-Identifier: Apache-2.0
/**
 * Reflection delta-ops — the v2.31 Reflection engine's byte-stable doc-refresh
 * primitive (REFLECT-04, Hindsight's drift-killer). A Mental Model doc's
 * `structuredBody` is a section-list AST (`{ sections: { id, heading, body }[] }`).
 * A reflect refresh of an EXISTING doc emits a list of typed {@link DeltaOp}s
 * (add / replace / remove a section) rather than rewriting the whole body; this
 * module applies them.
 *
 * ## The drift-killer (the load-bearing invariant)
 *
 * {@link applyDeltaOps} copies every section NOT targeted by an op **by
 * reference** — the same object survives into the result. Reference identity IS
 * the byte-identity guarantee: an untouched section is never re-serialized, so a
 * one-section refresh produces a one-section diff and the slow drift a
 * full-rewrite causes (Hindsight's failure mode) cannot happen. The function is
 * PURE (no IO, no clock, no randomness) and TOTAL (an op whose target id does not
 * exist is a no-op for that op — never a throw, never a doc-corruption), and it
 * never mutates `prev`.
 *
 * {@link renderStructuredBody} projects the AST to the markdown `body` column
 * deterministically (`## heading\n\nbody`, sections joined by a blank line) — the
 * same AST renders to the byte-identical string on every call.
 *
 * This file is type-only + pure-function: no zod, no IO, no `@comis/memory`
 * import. The store widens `MentalModel`/`AdmitMentalModelInput` with
 * `structuredBody?: StructuredBody` (importing the type from HERE); the agent
 * reflection job (Plan 04) parses the LLM's delta-ops into {@link DeltaOp}s,
 * applies them against the prior doc's AST via {@link applyDeltaOps}, and renders
 * the result for the `body` column. An ABSENT prior AST ⇒ the job treats the
 * topic as a NEW doc (synthesize fresh — Assumption A6).
 *
 * @module
 */

/**
 * One section of a Mental Model doc's structured body. `id` is the stable
 * delta-op target key (the LLM addresses a section by id when emitting a
 * replace/remove); `heading`/`body` are the rendered markdown content.
 */
export interface DocSection {
  /** Stable section id — the delta-op target key (replace/remove address it). */
  id: string;
  /** The section heading (rendered as `## heading`). */
  heading: string;
  /** The section body (markdown). */
  body: string;
}

/**
 * The structured-body AST persisted in the `mental_models.structured_body`
 * column (JSON) and surfaced on {@link MentalModel}. An ordered section list — a
 * reflect refresh deltas against it; {@link renderStructuredBody} projects it to
 * the `body` markdown column.
 */
export interface StructuredBody {
  /** The ordered sections of the doc. */
  sections: DocSection[];
}

/**
 * A typed structured-body edit emitted by a reflect refresh of an EXISTING doc.
 * The closed union the reflection-prompt parser produces and {@link applyDeltaOps}
 * consumes:
 *  - `add` — insert `section` immediately after the section with id `after`, or
 *    at the END when `after` is omitted (or names a section that does not exist).
 *  - `replace` — swap the section whose id is `id` for `section` (a no-op when no
 *    section has that id).
 *  - `remove` — drop the section whose id is `id` (a no-op when none matches).
 */
export type DeltaOp =
  | { op: "add"; after?: string; section: DocSection }
  | { op: "replace"; id: string; section: DocSection }
  | { op: "remove"; id: string };

/**
 * Apply a list of {@link DeltaOp}s to a structured body, returning the NEXT body.
 *
 * THE DRIFT-KILLER (REFLECT-04): every section NOT targeted by an op is copied
 * **by reference** — `result.sections[i] === prev.sections[i]` for an untouched
 * section. Only an `add`'s/`replace`'s `section` object is new. Pure (never
 * mutates `prev`), total (a target id that does not exist is a no-op for that op,
 * never a throw), deterministic (ops applied in order). An empty op list returns
 * a body whose sections are all the same references as `prev` — an empty refresh
 * never drifts.
 */
export function applyDeltaOps(prev: StructuredBody, ops: DeltaOp[]): StructuredBody {
  // Start from a shallow copy of the section array — the ELEMENTS are the SAME
  // object references as prev (byte-identity); only the array container is new
  // (so prev is never mutated).
  let sections: DocSection[] = prev.sections.slice();

  for (const op of ops) {
    switch (op.op) {
      case "replace": {
        const idx = sections.findIndex((s) => s.id === op.id);
        // Non-existent target → no-op for this op (graceful; no throw, no corruption).
        if (idx === -1) break;
        // Replace ONLY the target; all other elements remain the same references.
        sections = sections.map((s, i) => (i === idx ? op.section : s));
        break;
      }
      case "remove": {
        const idx = sections.findIndex((s) => s.id === op.id);
        if (idx === -1) break; // no-op for a non-existent id
        // filter() preserves the references of the survivors.
        sections = sections.filter((_, i) => i !== idx);
        break;
      }
      case "add": {
        const afterId = op.after;
        // Omitted `after`, or an `after` that does not match any section, appends
        // at the END (graceful). Otherwise insert immediately after the match.
        const afterIdx =
          afterId === undefined ? -1 : sections.findIndex((s) => s.id === afterId);
        if (afterIdx === -1) {
          sections = [...sections, op.section];
        } else {
          sections = [...sections.slice(0, afterIdx + 1), op.section, ...sections.slice(afterIdx + 1)];
        }
        break;
      }
    }
  }

  return { sections };
}

/**
 * Project a {@link StructuredBody} to the markdown `body` column. Each section
 * renders as `## heading\n\nbody`; sections are joined by a blank line. Pure +
 * deterministic — the same AST yields the byte-identical string on every call.
 * An empty section list renders to the empty string.
 */
export function renderStructuredBody(ast: StructuredBody): string {
  return ast.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n");
}
