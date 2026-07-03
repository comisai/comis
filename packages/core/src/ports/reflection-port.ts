// SPDX-License-Identifier: Apache-2.0
/**
 * Reflection delta-op TYPES — the Reflection engine's byte-stable
 * doc-refresh vocabulary. A Mental Model doc's `structuredBody` is a
 * section-list AST (`{ sections: { id, heading, body }[] }`); a reflect refresh of
 * an EXISTING doc emits a list of typed {@link DeltaOp}s (add / replace / remove a
 * section) rather than rewriting the whole body.
 *
 * This file is TYPE-ONLY (the `core/src/ports/*.ts` port-shape rule — no runtime
 * values, enforced by `architecture.test.ts`). The pure APPLY functions
 * (`applyDeltaOps`, `renderStructuredBody`) are runtime values and therefore live
 * in the non-ports home module `../reflection/delta-ops.ts`; the curated barrel
 * `../exports/ports.ts` re-exports them so the public `@comis/core` surface keeps
 * the types + the functions together (the `profile-id` / no-op-factory precedent).
 *
 * The store widens `MentalModel`/`AdmitMentalModelInput` with
 * `structuredBody?: StructuredBody` (importing the type from HERE); the agent
 * reflection job parses the LLM's delta-ops into {@link DeltaOp}s,
 * applies them against the prior doc's AST via `applyDeltaOps`, and renders the
 * result for the `body` column. An ABSENT prior AST ⇒ the job treats the topic as
 * a NEW doc (synthesize fresh).
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
 * column (JSON) and surfaced on `MentalModel`. An ordered section list — a
 * reflect refresh deltas against it; `renderStructuredBody` projects it to the
 * `body` markdown column.
 */
export interface StructuredBody {
  /** The ordered sections of the doc. */
  sections: DocSection[];
  /**
   * The corroboration cluster's COMMON-CORE opening-request tokens (the shared procedure,
   * per-instance specifics dropped — `commonCoreTokens`). Stored so reuse attribution
   * (`topicMatchedSkillNames`) can credit a SURFACED skill on a turn that instantiates its
   * procedure WITHOUT the model having to explicitly `read` the SKILL.md. Optional — docs
   * stored without it (e.g. seeded docs) never auto-credit, only the explicit-read path. NOT rendered
   * into the `body` markdown (`renderStructuredBody` ignores it).
   */
  topicTokens?: string[];
}

/**
 * A typed structured-body edit emitted by a reflect refresh of an EXISTING doc.
 * The closed union the reflection-prompt parser produces and `applyDeltaOps`
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
