// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE deterministic per-user-profile formatter (USER-03, Phase 107). The
 * read-path analog of {@link buildTemporalGuidanceBlock} (rag/temporal-guidance.ts):
 * a pure function over {@link UserRepresentationEntry}[] that returns a FIXED-shape
 * system-prompt block (a `<user_profile>` block, the §7.3-guidance analog), or
 * `null` when there is nothing to inject. When it returns `null` the caller pushes
 * NOTHING onto `memorySections` — that is the default-OFF byte-identity no-op
 * (a user with no profile leaves the prompt byte-identical to today's).
 *
 * Wiring (Plan 107-04): prompt-assembly reads the profile LLM-FREE
 * (`userRepresentationStore.read(scope)`, a deterministic store read — NO model
 * call) and pushes this block onto `memorySections`, exactly like the
 * temporal-guidance block. This is the milestone's #1 binding constraint: the
 * recall HOT PATH stays LLM-free — the read is a deterministic store.read + this
 * pure format, never a recall lane / reasoning seam.
 *
 * PURE: it takes ONLY the entries and returns `string | null`. No store call, no
 * wall-clock read, no model, no `Result` wrapper (the sanctioned pure
 * ranking/format carve-out, AGENTS.md §2.1; mirrors score.ts / temporal-guidance.ts).
 * The SAME input always yields the BYTE-IDENTICAL output, INVARIANT to input
 * ordering — entries are grouped by `entryType` in a FIXED order
 * (identity → preference → relationship → instruction) and ordered WITHIN a group
 * deterministically (by `createdAt` ascending, then `id`), so a shuffled input
 * produces the same block.
 *
 * Imports ONLY @comis/core TYPES — the agent-package production source must not
 * import the memory package (architecture.test.ts "agent -> memory cut"). The
 * profile `content` was already redaction-checked + `validateMemoryWrite`-clean +
 * high-trust at WRITE time (Plan 107-02/03); this read-side formatter does not
 * re-validate — it deterministically formats trusted-at-write rows.
 *
 * @module
 */

import type { UserRepresentationEntry } from "@comis/core";

/**
 * The fixed group order. The profile reads top-to-bottom as: WHO the user is
 * (identity) → WHAT they prefer (preference) → HOW they relate (relationship) →
 * WHAT they instruct (instruction). A fixed array (not the `entryType` union's
 * declaration order) so the block ordering is pinned in CODE and cannot drift if
 * the union is reordered.
 */
const GROUP_ORDER: ReadonlyArray<UserRepresentationEntry["entryType"]> = [
  "identity",
  "preference",
  "relationship",
  "instruction",
];

/** The human-facing heading for each group (fixed prose, no content echo). */
const GROUP_HEADING: Readonly<Record<UserRepresentationEntry["entryType"], string>> = {
  identity: "Identity",
  preference: "Preferences",
  relationship: "Relationships",
  instruction: "Standing instructions",
};

/**
 * Deterministic within-group order: `createdAt` ascending (oldest profile fact
 * first), then `id` ascending as the stable tie-break among equal timestamps.
 * Pure comparator over the entry's own fields — no clock, no external state — so
 * a shuffled input always sorts to the same order (the byte-stability contract).
 */
function compareWithinGroup(a: UserRepresentationEntry, b: UserRepresentationEntry): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the per-user profile system-prompt block (USER-03). Returns `null` for an
 * empty array (no entries → no block → the caller pushes nothing → byte-identity).
 * Otherwise returns a deterministic `<user_profile>` block: a fixed header, then
 * each non-empty group (in {@link GROUP_ORDER}) as a heading + one bullet per
 * entry's `content`, ordered by {@link compareWithinGroup}. Pure and non-mutating:
 * it reads only the entries (never a store, a clock, or a model) and never sorts
 * the caller's array in place.
 */
export function buildUserRepresentationBlock(
  entries: UserRepresentationEntry[],
): string | null {
  if (entries.length === 0) {
    return null;
  }

  const lines: string[] = [
    "<user_profile>",
    "What we know about this user (durable profile; trust-checked at write time):",
  ];

  for (const entryType of GROUP_ORDER) {
    // Copy-then-sort: never mutate the caller's array (purity / re-entrancy).
    const group = entries
      .filter((entry) => entry.entryType === entryType)
      .slice()
      .sort(compareWithinGroup);
    if (group.length === 0) {
      continue;
    }
    lines.push(`### ${GROUP_HEADING[entryType]}`);
    for (const entry of group) {
      lines.push(`- ${entry.content}`);
    }
  }

  lines.push("</user_profile>");
  return lines.join("\n");
}
