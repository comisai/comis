// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildUserRepresentationBlock — the PURE deterministic per-user-profile
 * formatter. The read-path analog of buildTemporalGuidanceBlock
 * (rag/temporal-guidance.ts): a pure function over UserRepresentationEntry[] that
 * returns a FIXED-shape system-prompt block string, or `null` when there is nothing
 * to inject (empty input → no block → the caller pushes nothing → byte-identity).
 *
 * Load-bearing RED-first assertions:
 * - empty → null (the no-entries gate; the caller pushes nothing → default-OFF byte-identity).
 * - entries → a deterministic block CONTAINING the fixed <user_profile> header + every
 *   entry's content; grouped by entryType in a FIXED order; BYTE-STABLE for a given input
 *   (call twice → toEqual) and INVARIANT to input ordering (shuffled input → same block).
 * - PURE: no store call, no clock, no model — the formatter takes ONLY the entries and
 *   returns string|null, so the same input always yields the same output (the LLM-free
 *   read-path constraint: this is a deterministic format, not a recall lane).
 */

import type { MentalModel, UserRepresentationEntry } from "@comis/core";
import { describe, it, expect } from "vitest";
import { buildProfileBlock, buildUserRepresentationBlock } from "./user-representation-block.js";

/** Build a representation entry with controllable fields (neutral defaults). */
function makeEntry(overrides: Partial<UserRepresentationEntry> & Pick<UserRepresentationEntry, "entryType" | "content">): UserRepresentationEntry {
  return {
    id: overrides.id ?? `id-${overrides.content}`,
    entryType: overrides.entryType,
    content: overrides.content,
    trust: overrides.trust ?? "learned",
    createdAt: overrides.createdAt ?? 1_000,
    ...(overrides.sourceMemoryId !== undefined ? { sourceMemoryId: overrides.sourceMemoryId } : {}),
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
  };
}

describe("buildUserRepresentationBlock", () => {
  it("returns null for an empty array (no entries → no block → caller pushes nothing)", () => {
    expect(buildUserRepresentationBlock([])).toBeNull();
  });

  it("returns a deterministic block containing the fixed header and every entry's content", () => {
    const entries: UserRepresentationEntry[] = [
      makeEntry({ entryType: "preference", content: "likes terse replies", createdAt: 2_000 }),
      makeEntry({ entryType: "identity", content: "name is Sam", createdAt: 1_000 }),
    ];

    const block = buildUserRepresentationBlock(entries);

    expect(block).not.toBeNull();
    // The fixed system-prompt header (a <user_profile> block, the §7.3-guidance analog).
    expect(block).toContain("<user_profile>");
    expect(block).toContain("</user_profile>");
    // Every entry's content is present.
    expect(block).toContain("name is Sam");
    expect(block).toContain("likes terse replies");
  });

  it("is byte-stable for a given input (same entries → identical block across calls)", () => {
    const entries: UserRepresentationEntry[] = [
      makeEntry({ entryType: "instruction", content: "always reply in English", createdAt: 3_000, id: "c" }),
      makeEntry({ entryType: "identity", content: "name is Sam", createdAt: 1_000, id: "a" }),
      makeEntry({ entryType: "preference", content: "likes terse replies", createdAt: 2_000, id: "b" }),
    ];

    const first = buildUserRepresentationBlock(entries);
    const second = buildUserRepresentationBlock(entries);

    expect(first).toEqual(second);
    expect(first).not.toBeNull();
  });

  it("is invariant to input ordering (a shuffled input yields the byte-identical block)", () => {
    const a = makeEntry({ entryType: "identity", content: "name is Sam", createdAt: 1_000, id: "a" });
    const b = makeEntry({ entryType: "preference", content: "likes terse replies", createdAt: 2_000, id: "b" });
    const c = makeEntry({ entryType: "relationship", content: "manages a team of five", createdAt: 1_500, id: "c" });
    const d = makeEntry({ entryType: "instruction", content: "always reply in English", createdAt: 3_000, id: "d" });

    const ordered = buildUserRepresentationBlock([a, b, c, d]);
    const shuffled = buildUserRepresentationBlock([d, b, a, c]);

    expect(shuffled).toEqual(ordered);
  });

  it("groups entries by type in the fixed order identity → preference → relationship → instruction", () => {
    const entries: UserRepresentationEntry[] = [
      makeEntry({ entryType: "instruction", content: "INSTRUCTION_LINE", createdAt: 1_000 }),
      makeEntry({ entryType: "relationship", content: "RELATIONSHIP_LINE", createdAt: 1_000 }),
      makeEntry({ entryType: "preference", content: "PREFERENCE_LINE", createdAt: 1_000 }),
      makeEntry({ entryType: "identity", content: "IDENTITY_LINE", createdAt: 1_000 }),
    ];

    const block = buildUserRepresentationBlock(entries)!;

    const idxIdentity = block.indexOf("IDENTITY_LINE");
    const idxPreference = block.indexOf("PREFERENCE_LINE");
    const idxRelationship = block.indexOf("RELATIONSHIP_LINE");
    const idxInstruction = block.indexOf("INSTRUCTION_LINE");

    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeLessThan(idxPreference);
    expect(idxPreference).toBeLessThan(idxRelationship);
    expect(idxRelationship).toBeLessThan(idxInstruction);
  });

  it("orders entries within a group deterministically by createdAt then id", () => {
    const entries: UserRepresentationEntry[] = [
      makeEntry({ entryType: "preference", content: "PREF_LATER", createdAt: 5_000, id: "z" }),
      makeEntry({ entryType: "preference", content: "PREF_EARLIER", createdAt: 1_000, id: "a" }),
      makeEntry({ entryType: "preference", content: "PREF_SAME_TIME_B", createdAt: 3_000, id: "b" }),
      makeEntry({ entryType: "preference", content: "PREF_SAME_TIME_A", createdAt: 3_000, id: "a" }),
    ];

    const block = buildUserRepresentationBlock(entries)!;

    // createdAt ascending: 1_000 < 3_000 (id a before id b) < 5_000.
    expect(block.indexOf("PREF_EARLIER")).toBeLessThan(block.indexOf("PREF_SAME_TIME_A"));
    expect(block.indexOf("PREF_SAME_TIME_A")).toBeLessThan(block.indexOf("PREF_SAME_TIME_B"));
    expect(block.indexOf("PREF_SAME_TIME_B")).toBeLessThan(block.indexOf("PREF_LATER"));
  });
});

// ---------------------------------------------------------------------------
// FOLD-03 EQUIVALENCE ORACLE (Phase 225 Plan 02). The fold replaces the
// userRepresentationStore.read → buildUserRepresentationBlock(UserRepresentationEntry[])
// read path with a mentalModelStore.list(scope,"profile") → buildProfileBlock(MentalModel)
// path. This is the no-regression guard: capture the PRE-fold <user_profile>
// block for a fixture covering all 4 prefix-types as the EQUIVALENCE TARGET,
// then assert the NEW buildProfileBlock (given a kind:profile MentalModel whose
// structuredBody.sections carry the SAME 4 facts) renders EQUIVALENT-OR-BETTER:
// the same <user_profile> wrapper, the same facts, the same fixed group order.
// The RED fires if a fact is DROPPED (we assert against the captured PRE-fold
// target, NOT a snapshot of the new output — snapshotting the new output would
// false-green a regression).
// ---------------------------------------------------------------------------
describe("buildProfileBlock — FOLD-03 equivalence with the pre-fold <user_profile> block", () => {
  // The four facts, one per prefix-type, shared by BOTH the pre-fold entries and
  // the post-fold MentalModel — so the two render paths see the SAME facts.
  const FACT_IDENTITY = "name is Sam";
  const FACT_PREFERENCE = "likes terse replies";
  const FACT_RELATIONSHIP = "manages a team of five";
  const FACT_INSTRUCTION = "always reply in English";

  /** The PRE-fold entries (the legacy read path's input), all 4 prefix-types. */
  const preFoldEntries: UserRepresentationEntry[] = [
    makeEntry({ entryType: "identity", content: FACT_IDENTITY, createdAt: 1_000, id: "a" }),
    makeEntry({ entryType: "preference", content: FACT_PREFERENCE, createdAt: 2_000, id: "b" }),
    makeEntry({ entryType: "relationship", content: FACT_RELATIONSHIP, createdAt: 1_500, id: "c" }),
    makeEntry({ entryType: "instruction", content: FACT_INSTRUCTION, createdAt: 3_000, id: "d" }),
  ];

  /** The captured PRE-fold equivalence TARGET (the block the fold must reproduce). */
  const ORACLE_PREFOLD_BLOCK = buildUserRepresentationBlock(preFoldEntries)!;

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

  it("is pure + byte-stable (same input → byte-identical output across calls)", () => {
    expect(buildProfileBlock(makeProfileModel())).toEqual(buildProfileBlock(makeProfileModel()));
  });

  it("returns undefined for a profile doc with no usable sections (→ caller pushes nothing → byte-identity)", () => {
    const empty: MentalModel = { ...makeProfileModel(), structuredBody: { sections: [] }, body: "" };
    expect(buildProfileBlock(empty)).toBeUndefined();
  });
});
