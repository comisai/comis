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

import type { UserRepresentationEntry } from "@comis/core";
import { describe, it, expect } from "vitest";
import { buildUserRepresentationBlock } from "./user-representation-block.js";

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
