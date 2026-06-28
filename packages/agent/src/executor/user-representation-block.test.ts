// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildProfileBlock — the PURE deterministic per-user-profile formatter
 * (the v2.31 FOLD-01 read path). The read-path analog of buildTemporalGuidanceBlock
 * (rag/temporal-guidance.ts): a pure function over a kind:"profile" MentalModel that
 * returns a FIXED-shape <user_profile> system-prompt block string, or `undefined`
 * when there is nothing to inject (no usable sections → no block → the caller pushes
 * nothing → byte-identity).
 *
 * v2.31 Phase 225-05: the legacy `buildUserRepresentationBlock(UserRepresentationEntry[])`
 * formatter + the `UserRepresentationEntry` type + the `userRepresentationStore` it read
 * from were DELETED (the standalone user-representation subsystem). The FOLD-03 equivalence
 * oracle below now asserts `buildProfileBlock` against an INLINED byte-exact pre-fold target
 * (a literal string), which is a stronger guard than re-deriving it from the deleted formatter.
 */

import type { MentalModel } from "@comis/core";
import { describe, it, expect } from "vitest";
import { buildProfileBlock } from "./user-representation-block.js";

// ---------------------------------------------------------------------------
// FOLD-03 EQUIVALENCE ORACLE (Phase 225 Plan 02). The fold replaced the
// userRepresentationStore.read → buildUserRepresentationBlock(UserRepresentationEntry[])
// read path with a mentalModelStore.list(scope,"profile") → buildProfileBlock(MentalModel)
// path. This is the no-regression guard: the PRE-fold <user_profile> block for a fixture
// covering all 4 prefix-types is the EQUIVALENCE TARGET (inlined as a byte-exact literal
// after Plan 05 deleted the legacy formatter), and the NEW buildProfileBlock (given a
// kind:profile MentalModel whose structuredBody.sections carry the SAME 4 facts) must render
// EQUIVALENT-OR-BETTER: the same <user_profile> wrapper, the same facts, the same fixed group
// order. The RED fires if a fact is DROPPED (we assert against the captured PRE-fold target,
// NOT a snapshot of the new output — snapshotting the new output would false-green a regression).
// ---------------------------------------------------------------------------
describe("buildProfileBlock — FOLD-03 equivalence with the pre-fold <user_profile> block", () => {
  // The four facts, one per prefix-type, shared by BOTH the pre-fold target and
  // the post-fold MentalModel — so the two render paths see the SAME facts.
  const FACT_IDENTITY = "name is Sam";
  const FACT_PREFERENCE = "likes terse replies";
  const FACT_RELATIONSHIP = "manages a team of five";
  const FACT_INSTRUCTION = "always reply in English";

  /**
   * The captured PRE-fold equivalence TARGET (the block the legacy
   * buildUserRepresentationBlock produced for the 4-fact fixture, one fact per group, in the
   * fixed identity → preference → relationship → instruction order). Inlined byte-exact since
   * the legacy formatter was deleted in Plan 05 — the fold must reproduce THIS envelope + facts.
   */
  const ORACLE_PREFOLD_BLOCK = [
    "<user_profile>",
    "What we know about this user (durable profile; trust-checked at write time):",
    "### Identity",
    `- ${FACT_IDENTITY}`,
    "### Preferences",
    `- ${FACT_PREFERENCE}`,
    "### Relationships",
    `- ${FACT_RELATIONSHIP}`,
    "### Standing instructions",
    `- ${FACT_INSTRUCTION}`,
    "</user_profile>",
  ].join("\n");

  /**
   * A kind:profile MentalModel carrying the SAME 4 facts in its structuredBody —
   * one section per prefix-type, ids matching the 4 GROUP_ORDER groups (the
   * PROFILE_REFLECT_PROMPT emits exactly these section ids). This is what the
   * reflect engine admits for a profile doc.
   */
  function makeProfileModel(): MentalModel {
    return {
      id: "mm-profile-u",
      name: "profile-user-u",
      description: "Durable profile for user u",
      body: "(rendered markdown body — not the formatter's input)",
      kind: "profile",
      topicKey: "",
      trustLevel: "learned",
      state: "active",
      proofCount: 2,
      confidence: 0.7,
      mutating: false,
      sourceTrajIds: ["s1", "s2"],
      structuredBody: {
        sections: [
          { id: "identity", heading: "Identity", body: `- ${FACT_IDENTITY}` },
          { id: "preference", heading: "Preferences", body: `- ${FACT_PREFERENCE}` },
          { id: "relationship", heading: "Relationships", body: `- ${FACT_RELATIONSHIP}` },
          { id: "instruction", heading: "Standing instructions", body: `- ${FACT_INSTRUCTION}` },
        ],
      },
      createdAt: 1_000,
    };
  }

  it("renders the <user_profile> wrapper", () => {
    const block = buildProfileBlock(makeProfileModel());
    expect(block).not.toBeUndefined();
    expect(block).toContain("<user_profile>");
    expect(block).toContain("</user_profile>");
    // The oracle (pre-fold) had the wrapper too — equivalence on the envelope.
    expect(ORACLE_PREFOLD_BLOCK).toContain("<user_profile>");
  });

  it("preserves EVERY fact the pre-fold block carried (no fact dropped — the RED guard)", () => {
    const block = buildProfileBlock(makeProfileModel())!;
    for (const fact of [FACT_IDENTITY, FACT_PREFERENCE, FACT_RELATIONSHIP, FACT_INSTRUCTION]) {
      // The oracle carried it…
      expect(ORACLE_PREFOLD_BLOCK).toContain(fact);
      // …and the fold must too (equivalent-or-better: a dropped fact fails here).
      expect(block).toContain(fact);
    }
  });

  it("preserves the fixed group order identity → preference → relationship → instruction", () => {
    const block = buildProfileBlock(makeProfileModel())!;
    const idxIdentity = block.indexOf(FACT_IDENTITY);
    const idxPreference = block.indexOf(FACT_PREFERENCE);
    const idxRelationship = block.indexOf(FACT_RELATIONSHIP);
    const idxInstruction = block.indexOf(FACT_INSTRUCTION);

    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeLessThan(idxPreference);
    expect(idxPreference).toBeLessThan(idxRelationship);
    expect(idxRelationship).toBeLessThan(idxInstruction);
  });

  it("renders the byte-exact pre-fold envelope (equivalent-or-better — same wrapper, headings, bullets, order)", () => {
    // The fold's output for the 4-fact fixture is byte-identical to the captured pre-fold target.
    expect(buildProfileBlock(makeProfileModel())).toBe(ORACLE_PREFOLD_BLOCK);
  });

  it("is pure + byte-stable (same input → byte-identical output across calls)", () => {
    expect(buildProfileBlock(makeProfileModel())).toEqual(buildProfileBlock(makeProfileModel()));
  });

  it("returns undefined for a profile doc with no usable sections (→ caller pushes nothing → byte-identity)", () => {
    const empty: MentalModel = { ...makeProfileModel(), structuredBody: { sections: [] }, body: "" };
    expect(buildProfileBlock(empty)).toBeUndefined();
  });
});
