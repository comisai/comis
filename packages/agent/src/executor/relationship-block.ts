// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE deterministic channel-relationship formatter (read side). The
 * directional analog of {@link buildProfileBlock}
 * (user-representation-block.ts): a pure function over {@link RelationshipEntry}[]
 * that returns a FIXED-shape system-prompt block (a `<channel_relationships>`
 * block), or `null` when there is nothing to inject. When it returns `null` the
 * caller pushes NOTHING onto `memorySections` — that is the default-OFF
 * byte-identity no-op (a channel with no relationship edges leaves the prompt
 * byte-identical to today's).
 *
 * Wiring: prompt-assembly fetches the channel's edges LLM-FREE (a
 * deterministic scoped fetch — NO model call), gated on
 * `socialModeling.enabled && socialModeling.privacyReviewSignedOffBy`,
 * and pushes this block onto `memorySections`, exactly like the user-profile standing
 * block. This is the milestone's #1 binding constraint: the recall HOT PATH stays
 * LLM-free — the fetch is a deterministic scoped lookup + this pure format, never a
 * recall lane / reasoning seam.
 *
 * PURE: it takes ONLY the entries and returns `string | null`. No store call, no
 * wall-clock read, no model, no `Result` wrapper (the sanctioned pure
 * ranking/format carve-out, AGENTS.md §2.1; mirrors score.ts / temporal-guidance.ts
 * / user-representation-block.ts). The SAME input always yields the BYTE-IDENTICAL
 * output, INVARIANT to input ordering — edges are sorted by the fixed 4-key order
 * (`subjectUserId`, then `aboutUserId`, then `createdAt`, then `id`), so a shuffled
 * input produces the same block. A relationship edge has NO group/entryType
 * vocabulary (the enum is intentionally omitted), so there is no GROUP_ORDER — the
 * single 4-key comparator is the whole within-block order.
 *
 * Imports ONLY @comis/core TYPES — the agent-package production source must not
 * import the memory package (architecture.test.ts "agent -> memory cut"). The
 * relationship `content` was already redaction-checked + `validateMemoryWrite`-clean
 * + high-trust at WRITE time; this read-side formatter does not
 * re-validate — it deterministically formats trusted-at-write rows. The directional
 * `(subjectUserId, aboutUserId)` pair is rendered verbatim — A→B and B→A are
 * distinct lines, never symmetrized.
 *
 * @module
 */

import type { RelationshipEntry } from "@comis/core";

/**
 * Deterministic edge order: `subjectUserId` ascending, then `aboutUserId`
 * ascending, then `createdAt` ascending (oldest edge first), then `id` ascending
 * as the stable final tie-break. Pure comparator over the edge's own fields — no
 * clock, no external state — so a shuffled input always sorts to the same order
 * (the byte-stability contract). Unlike the user-profile block there is no
 * entryType to group by; the directional pair leads the sort.
 */
function compareEdges(a: RelationshipEntry, b: RelationshipEntry): number {
  if (a.subjectUserId !== b.subjectUserId) {
    return a.subjectUserId < b.subjectUserId ? -1 : 1;
  }
  if (a.aboutUserId !== b.aboutUserId) {
    return a.aboutUserId < b.aboutUserId ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the channel-relationship system-prompt block (read side).
 * Returns `null` for an empty array (no edges → no block → the caller pushes
 * nothing → byte-identity). Otherwise returns a deterministic
 * `<channel_relationships>` block: a fixed header, then one directional bullet per
 * edge rendering `subjectUserId → aboutUserId: content`, ordered by
 * {@link compareEdges}. Pure and non-mutating: it reads only the entries (never a
 * store, a clock, or a model) and never sorts the caller's array in place.
 */
export function buildRelationshipBlock(entries: RelationshipEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }

  // Copy-then-sort: never mutate the caller's array (purity / re-entrancy).
  const ordered = entries.slice().sort(compareEdges);

  const lines: string[] = [
    "<channel_relationships>",
    "How participants in this channel relate (directional; trust-checked at write time):",
  ];
  for (const edge of ordered) {
    lines.push(`- ${edge.subjectUserId} → ${edge.aboutUserId}: ${edge.content}`);
  }
  lines.push("</channel_relationships>");
  return lines.join("\n");
}
