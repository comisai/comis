// SPDX-License-Identifier: Apache-2.0
/**
 * Reflection delta-ops APPLY — the Reflection engine's byte-stable
 * doc-refresh primitive (the drift-killer). The runtime
 * counterpart to the type-only `../ports/reflection-port.ts` (the runtime values
 * live HERE because `core/src/ports/*.ts` is type-only by the port-shape rule —
 * the no-op-factory / `profile-id` precedent). Re-exported on the public
 * `@comis/core` surface via `../exports/ports.ts`.
 *
 * ## The drift-killer (the load-bearing invariant)
 *
 * {@link applyDeltaOps} copies every section NOT targeted by an op **by
 * reference** — the same object survives into the result. Reference identity IS
 * the byte-identity guarantee: an untouched section is never re-serialized, so a
 * one-section refresh produces a one-section diff and the slow drift a
 * full-rewrite causes cannot happen. The function is
 * PURE (no IO, no clock, no randomness) and TOTAL (an op whose target id does not
 * exist is a no-op for that op — never a throw, never a doc-corruption), and it
 * never mutates `prev`.
 *
 * {@link renderStructuredBody} projects the AST to the markdown `body` column
 * deterministically (`## heading\n\nbody`, sections joined by a blank line) — the
 * same AST renders to the byte-identical string on every call.
 *
 * @module
 */

import type { DocSection, StructuredBody, DeltaOp } from "../ports/reflection-port.js";

/**
 * Apply a list of {@link DeltaOp}s to a structured body, returning the NEXT body.
 *
 * THE DRIFT-KILLER: every section NOT targeted by an op is copied
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
