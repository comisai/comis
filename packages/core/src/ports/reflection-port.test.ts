// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the v2.31 Reflection delta-ops (`@comis/core` reflection-port):
 * `applyDeltaOps` (the PURE add/replace/remove apply over the `structuredBody`
 * section-AST) + `renderStructuredBody` (the AST → markdown body projection).
 *
 * THE LOAD-BEARING ASSERTION (REFLECT-04, Hindsight's drift-killer): a section
 * NOT targeted by an op is copied BYTE-IDENTICAL — i.e. the SAME object reference
 * survives into the result (`result.sections[i] === prev.sections[i]`). Reference
 * identity IS the byte-identity proof: a reflect refresh that touches one section
 * must NOT rewrite (or even re-serialize) the untouched ones. This is what keeps
 * the per-run token delta small and prevents the slow drift a full-rewrite causes.
 *
 * `applyDeltaOps` is pure (no IO, no clock, no randomness) and total (a malformed
 * op — e.g. a target id that does not exist — is a no-op for that op, never a
 * throw and never a doc-corruption). `renderStructuredBody` is deterministic
 * (same AST → same string on every call).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { StructuredBody, DeltaOp } from "./reflection-port.js";
// The runtime apply functions live in the non-ports home module (the port file
// is type-only); they are re-exported on the public @comis/core surface.
import { applyDeltaOps, renderStructuredBody } from "../reflection/delta-ops.js";

/** A 3-section fixture; each section is a distinct object so reference identity is observable. */
function makePrev(): StructuredBody {
  return {
    sections: [
      { id: "s1", heading: "Intro", body: "the intro" },
      { id: "s2", heading: "Steps", body: "OLD steps" },
      { id: "s3", heading: "Notes", body: "some notes" },
    ],
  };
}

describe("applyDeltaOps — byte-identity (reference) of untargeted sections (REFLECT-04)", () => {
  it("replace touches ONLY the target; s1 and s3 are the SAME object references as prev (the drift-killer)", () => {
    const prev = makePrev();
    const ops: DeltaOp[] = [
      { op: "replace", id: "s2", section: { id: "s2", heading: "Steps", body: "NEW steps" } },
    ];
    const next = applyDeltaOps(prev, ops);

    // The untargeted sections are byte-identical — the SAME object reference.
    expect(next.sections[0]).toBe(prev.sections[0]); // s1 — by reference
    expect(next.sections[2]).toBe(prev.sections[2]); // s3 — by reference
    // Only s2 changed (a new object, the replacement body).
    expect(next.sections[1]).not.toBe(prev.sections[1]);
    expect(next.sections[1]?.body).toBe("NEW steps");
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    // prev is not mutated (pure).
    expect(prev.sections[1]?.body).toBe("OLD steps");
  });

  it("an EMPTY op list returns sections that are all the SAME references (an empty refresh never drifts)", () => {
    const prev = makePrev();
    const next = applyDeltaOps(prev, []);
    expect(next.sections[0]).toBe(prev.sections[0]);
    expect(next.sections[1]).toBe(prev.sections[1]);
    expect(next.sections[2]).toBe(prev.sections[2]);
    expect(next.sections.length).toBe(3);
  });
});

describe("applyDeltaOps — add", () => {
  it("add with after:'s1' inserts the new section immediately after s1; the others stay byte-identical", () => {
    const prev = makePrev();
    const inserted = { id: "s1b", heading: "Prereqs", body: "install deps" };
    const next = applyDeltaOps(prev, [{ op: "add", after: "s1", section: inserted }]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s1b", "s2", "s3"]);
    // The inserted section IS the passed object; the originals are byte-identical.
    expect(next.sections[1]).toBe(inserted);
    expect(next.sections[0]).toBe(prev.sections[0]); // s1
    expect(next.sections[2]).toBe(prev.sections[1]); // s2 (shifted, same ref)
    expect(next.sections[3]).toBe(prev.sections[2]); // s3 (shifted, same ref)
  });

  it("add with NO 'after' appends the new section at the END; the others stay byte-identical", () => {
    const prev = makePrev();
    const appended = { id: "s4", heading: "Appendix", body: "extra" };
    const next = applyDeltaOps(prev, [{ op: "add", section: appended }]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(next.sections[3]).toBe(appended);
    expect(next.sections[0]).toBe(prev.sections[0]);
    expect(next.sections[1]).toBe(prev.sections[1]);
    expect(next.sections[2]).toBe(prev.sections[2]);
  });

  it("add with an 'after' id that does not exist appends at the END (graceful — no throw)", () => {
    const prev = makePrev();
    const appended = { id: "s9", heading: "Late", body: "late add" };
    const next = applyDeltaOps(prev, [{ op: "add", after: "nope", section: appended }]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s9"]);
    expect(next.sections[3]).toBe(appended);
  });
});

describe("applyDeltaOps — remove", () => {
  it("remove drops ONLY the target; the survivors stay byte-identical", () => {
    const prev = makePrev();
    const next = applyDeltaOps(prev, [{ op: "remove", id: "s2" }]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(next.sections[0]).toBe(prev.sections[0]); // s1
    expect(next.sections[1]).toBe(prev.sections[2]); // s3
  });

  it("remove of a non-existent id is a no-op for that op (does not throw, does not corrupt the doc)", () => {
    const prev = makePrev();
    const next = applyDeltaOps(prev, [{ op: "remove", id: "ghost" }]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    // Every section survives byte-identical.
    expect(next.sections[0]).toBe(prev.sections[0]);
    expect(next.sections[1]).toBe(prev.sections[1]);
    expect(next.sections[2]).toBe(prev.sections[2]);
  });
});

describe("applyDeltaOps — non-existent target on replace", () => {
  it("replace targeting a non-existent id is a no-op for that op (graceful, no corruption)", () => {
    const prev = makePrev();
    const next = applyDeltaOps(prev, [
      { op: "replace", id: "ghost", section: { id: "ghost", heading: "X", body: "Y" } },
    ]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(next.sections[0]).toBe(prev.sections[0]);
    expect(next.sections[1]).toBe(prev.sections[1]);
    expect(next.sections[2]).toBe(prev.sections[2]);
  });
});

describe("applyDeltaOps — multiple ops applied in order", () => {
  it("applies a sequence (replace s2, remove s3, add s4) leaving s1 byte-identical", () => {
    const prev = makePrev();
    const replaced = { id: "s2", heading: "Steps", body: "NEW steps" };
    const appended = { id: "s4", heading: "End", body: "wrap up" };
    const next = applyDeltaOps(prev, [
      { op: "replace", id: "s2", section: replaced },
      { op: "remove", id: "s3" },
      { op: "add", section: appended },
    ]);
    expect(next.sections.map((s) => s.id)).toEqual(["s1", "s2", "s4"]);
    expect(next.sections[0]).toBe(prev.sections[0]); // s1 untouched by reference
    expect(next.sections[1]).toBe(replaced);
    expect(next.sections[2]).toBe(appended);
  });
});

describe("renderStructuredBody — deterministic markdown projection", () => {
  it("renders sections as `## heading\\n\\nbody`, joined by a blank line", () => {
    const ast: StructuredBody = {
      sections: [
        { id: "s1", heading: "Steps", body: "do X" },
        { id: "s2", heading: "Notes", body: "watch out" },
      ],
    };
    const md = renderStructuredBody(ast);
    expect(md).toBe("## Steps\n\ndo X\n\n## Notes\n\nwatch out");
  });

  it("is deterministic — calling twice yields the byte-identical string", () => {
    const ast: StructuredBody = { sections: [{ id: "s1", heading: "Steps", body: "do X" }] };
    expect(renderStructuredBody(ast)).toBe(renderStructuredBody(ast));
    expect(renderStructuredBody(ast)).toBe("## Steps\n\ndo X");
  });

  it("renders an empty AST as the empty string", () => {
    expect(renderStructuredBody({ sections: [] })).toBe("");
  });
});
