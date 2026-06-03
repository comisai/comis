// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildRelationshipBlock — the PURE deterministic channel-relationship
 * formatter (read side). The directional analog of
 * buildUserRepresentationBlock (user-representation-block.ts): a pure function over
 * RelationshipEntry[] that returns a FIXED-shape system-prompt block string, or
 * `null` when there is nothing to inject (empty input → no block → the caller pushes
 * nothing → byte-identity).
 *
 * Load-bearing RED-first assertions (mirror the user-profile block contract):
 * - empty → null (the no-edges gate; the caller pushes nothing → default-OFF byte-identity).
 * - edges → a deterministic block CONTAINING the fixed <channel_relationships> header +
 *   every edge's directional content (subject → about + content); BYTE-STABLE for a given
 *   input (call twice → toEqual) and INVARIANT to input ordering (a shuffled input → the
 *   byte-identical block).
 * - the byte-stability sort is (subjectUserId, aboutUserId, createdAt, id) — the relationship
 *   edge has NO group/entryType vocabulary (the enum is intentionally omitted), so there
 *   is no GROUP_ORDER: the single 4-key sort is the whole within-block order.
 * - PURE: no store call, no clock, no model — the formatter takes ONLY the entries and
 *   returns string|null, so the same input always yields the same output (the LLM-free
 *   read-path constraint: this is a deterministic format, not a recall lane).
 */

import type { RelationshipEntry } from "@comis/core";
import { describe, it, expect } from "vitest";
import { buildRelationshipBlock } from "./relationship-block.js";

/** Build a relationship edge with controllable fields (neutral defaults). */
function makeEdge(
  overrides: Partial<RelationshipEntry> &
    Pick<RelationshipEntry, "subjectUserId" | "aboutUserId" | "content">,
): RelationshipEntry {
  return {
    id: overrides.id ?? `id-${overrides.subjectUserId}-${overrides.aboutUserId}-${overrides.content}`,
    subjectUserId: overrides.subjectUserId,
    aboutUserId: overrides.aboutUserId,
    content: overrides.content,
    trust: overrides.trust ?? "learned",
    createdAt: overrides.createdAt ?? 1_000,
    ...(overrides.sourceMemoryId !== undefined ? { sourceMemoryId: overrides.sourceMemoryId } : {}),
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
  };
}

describe("buildRelationshipBlock", () => {
  it("returns null for an empty array (no edges → no block → caller pushes nothing)", () => {
    expect(buildRelationshipBlock([])).toBeNull();
  });

  it("returns a deterministic block containing the fixed header and every edge's directional content", () => {
    const edges: RelationshipEntry[] = [
      makeEdge({ subjectUserId: "alice", aboutUserId: "bob", content: "trusts on logistics", createdAt: 2_000 }),
      makeEdge({ subjectUserId: "carol", aboutUserId: "dave", content: "manages directly", createdAt: 1_000 }),
    ];

    const block = buildRelationshipBlock(edges);

    expect(block).not.toBeNull();
    // The fixed system-prompt header (a <channel_relationships> block).
    expect(block).toContain("<channel_relationships>");
    expect(block).toContain("</channel_relationships>");
    // Every edge's directional content is present (subject, about, and the relationship text).
    expect(block).toContain("alice");
    expect(block).toContain("bob");
    expect(block).toContain("trusts on logistics");
    expect(block).toContain("carol");
    expect(block).toContain("dave");
    expect(block).toContain("manages directly");
  });

  it("is byte-stable for a given input (same edges → identical block across calls)", () => {
    const edges: RelationshipEntry[] = [
      makeEdge({ subjectUserId: "carol", aboutUserId: "dave", content: "manages directly", createdAt: 3_000, id: "c" }),
      makeEdge({ subjectUserId: "alice", aboutUserId: "bob", content: "trusts on logistics", createdAt: 1_000, id: "a" }),
      makeEdge({ subjectUserId: "alice", aboutUserId: "carol", content: "mentors", createdAt: 2_000, id: "b" }),
    ];

    const first = buildRelationshipBlock(edges);
    const second = buildRelationshipBlock(edges);

    expect(first).toEqual(second);
    expect(first).not.toBeNull();
  });

  it("is invariant to input ordering (a shuffled input yields the byte-identical block)", () => {
    // Distinct on each of the four sort keys so a shuffle exercises the full comparator.
    const a = makeEdge({ subjectUserId: "alice", aboutUserId: "bob", content: "trusts on logistics", createdAt: 1_000, id: "a" });
    const b = makeEdge({ subjectUserId: "alice", aboutUserId: "carol", content: "mentors", createdAt: 2_000, id: "b" });
    const c = makeEdge({ subjectUserId: "bob", aboutUserId: "alice", content: "reports to", createdAt: 1_500, id: "c" });
    const d = makeEdge({ subjectUserId: "carol", aboutUserId: "dave", content: "manages directly", createdAt: 3_000, id: "d" });

    const ordered = buildRelationshipBlock([a, b, c, d]);
    const shuffled = buildRelationshipBlock([d, b, a, c]);

    expect(shuffled).toEqual(ordered);
  });

  it("orders edges deterministically by subjectUserId, then aboutUserId, then createdAt, then id", () => {
    // Same subject (alice) with two abouts → about breaks the tie before createdAt.
    // Same (subject, about) with two createdAt → createdAt breaks before id.
    // Same (subject, about, createdAt) with two ids → id is the final stable tie-break.
    const edges: RelationshipEntry[] = [
      makeEdge({ subjectUserId: "bob", aboutUserId: "alice", content: "SUBJECT_BOB", createdAt: 1_000, id: "z" }),
      makeEdge({ subjectUserId: "alice", aboutUserId: "carol", content: "ABOUT_CAROL", createdAt: 1_000, id: "m" }),
      makeEdge({ subjectUserId: "alice", aboutUserId: "bob", content: "ABOUT_BOB_LATE", createdAt: 5_000, id: "m" }),
      makeEdge({ subjectUserId: "alice", aboutUserId: "bob", content: "ABOUT_BOB_EARLY_IDB", createdAt: 1_000, id: "b" }),
      makeEdge({ subjectUserId: "alice", aboutUserId: "bob", content: "ABOUT_BOB_EARLY_IDA", createdAt: 1_000, id: "a" }),
    ];

    const block = buildRelationshipBlock(edges)!;

    const idxIdA = block.indexOf("ABOUT_BOB_EARLY_IDA");
    const idxIdB = block.indexOf("ABOUT_BOB_EARLY_IDB");
    const idxLate = block.indexOf("ABOUT_BOB_LATE");
    const idxAboutCarol = block.indexOf("ABOUT_CAROL");
    const idxSubjectBob = block.indexOf("SUBJECT_BOB");

    // id ascending within equal (subject, about, createdAt): a before b.
    expect(idxIdA).toBeLessThan(idxIdB);
    // createdAt ascending within equal (subject, about): early (1_000) before late (5_000).
    expect(idxIdB).toBeLessThan(idxLate);
    // aboutUserId ascending within equal subject (alice): "bob" before "carol".
    expect(idxLate).toBeLessThan(idxAboutCarol);
    // subjectUserId ascending: "alice" group before "bob" group.
    expect(idxAboutCarol).toBeLessThan(idxSubjectBob);
  });
});
