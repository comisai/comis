// SPDX-License-Identifier: Apache-2.0
/**
 * The PURE deterministic per-user-profile formatter (the v2.31 FOLD-01 read path).
 * The read-path analog of {@link buildTemporalGuidanceBlock} (rag/temporal-guidance.ts):
 * a pure function over a `kind:"profile"` {@link MentalModel} that returns a FIXED-shape
 * system-prompt block (a `<user_profile>` block, the §7.3-guidance analog), or
 * `undefined` when there is nothing to inject. When it returns `undefined` the caller
 * pushes NOTHING onto `memorySections` — that is the default-OFF byte-identity no-op
 * (a user with no profile leaves the prompt byte-identical to today's).
 *
 * Wiring: prompt-assembly reads the profile LLM-FREE
 * (`mentalModelStore.list(scope, "profile")`, a deterministic store read — NO model
 * call) and pushes this block onto `memorySections`, exactly like the
 * temporal-guidance block. This is the milestone's #1 binding constraint: the
 * recall HOT PATH stays LLM-free — the read is a deterministic store.list + this
 * pure format, never a recall lane / reasoning seam.
 *
 * v2.31 Phase 225-05: the legacy `buildUserRepresentationBlock(UserRepresentationEntry[])`
 * formatter (the old `userRepresentationStore.read` path) was DELETED with the standalone
 * user-representation subsystem. `buildProfileBlock` is the sole survivor — it renders the
 * SAME `<user_profile>` envelope from the folded kind:"profile" doc.
 *
 * Imports ONLY @comis/core TYPES — the agent-package production source must not
 * import the memory package (architecture.test.ts "agent -> memory cut"). The
 * profile `content` was already redaction-checked + `validateLearnedDocBody`-clean +
 * high-trust at WRITE time; this read-side formatter does not
 * re-validate — it deterministically formats trusted-at-write rows.
 *
 * @module
 */

import type { MentalModel } from "@comis/core";

/** The four PREFIX-TYPE section ids the `PROFILE_REFLECT_PROMPT` emits (the fold's
 *  profile-doc section vocabulary). A code-local literal union — the deleted
 *  `UserRepresentationType` taxonomy folded into these section ids. */
type ProfileSectionId = "identity" | "preference" | "relationship" | "instruction";

/**
 * The fixed group order. The profile reads top-to-bottom as: WHO the user is
 * (identity) → WHAT they prefer (preference) → HOW they relate (relationship) →
 * WHAT they instruct (instruction). A fixed array so the block ordering is pinned
 * in CODE and cannot drift.
 */
const GROUP_ORDER: ReadonlyArray<ProfileSectionId> = [
  "identity",
  "preference",
  "relationship",
  "instruction",
];

/** The human-facing heading for each group (fixed prose, no content echo). */
const GROUP_HEADING: Readonly<Record<ProfileSectionId, string>> = {
  identity: "Identity",
  preference: "Preferences",
  relationship: "Relationships",
  instruction: "Standing instructions",
};

/**
 * Build the per-user profile system-prompt block from a `kind:"profile"`
 * {@link MentalModel} — the FOLD-01 (Phase 225) read-path replacement for the
 * deleted legacy `buildUserRepresentationBlock`. The fold rewired the `<user_profile>`
 * source from the deleted `userRepresentationStore` (a `UserRepresentationEntry[]`)
 * to the mental-model store (a `kind:"profile"` doc whose `structuredBody.sections`
 * are keyed by the four PREFIX-TYPE ids the `PROFILE_REFLECT_PROMPT` emits —
 * `identity` / `preference` / `relationship` / `instruction`).
 *
 * PURE + byte-stable (the legacy formatter's contract): it
 * takes ONLY the doc and returns `string | undefined`, with NO store call, no
 * wall-clock read, no model, no `Result` wrapper (the sanctioned pure format
 * carve-out). It maps each prefix-type section onto the SAME fixed
 * {@link GROUP_ORDER} groups + the SAME code-pinned {@link GROUP_HEADING} prose +
 * the SAME `<user_profile>` wrapper as the legacy formatter — so the block is
 * EQUIVALENT-OR-BETTER (FOLD-03): same wrapper, same facts, same fixed group order
 * (the heading is taken from CODE, never the doc's own — so it cannot drift from
 * the pinned prose). A section whose id is not a known prefix type is ignored
 * (forward-compatible); a section with an empty body contributes no heading.
 *
 * Returns `undefined` when the doc has NO usable section content (no
 * structuredBody, or every prefix-type section is empty/absent) — the caller then
 * pushes NOTHING onto `memorySections`, the default-OFF byte-identity no-op (a user
 * with no profile leaves the prompt byte-identical to today's). The doc's `content`
 * was redaction-checked + `validateLearnedDocBody`-clean + high-trust at WRITE time;
 * this read-side formatter does not re-validate.
 */
export function buildProfileBlock(doc: MentalModel): string | undefined {
  const sections = doc.structuredBody?.sections ?? [];
  if (sections.length === 0) {
    return undefined;
  }

  // Index the doc's sections by their prefix-type id (the last one wins on a
  // duplicate id — the AST is a single ordered list, duplicates are not expected).
  const byId = new Map<string, string>();
  for (const section of sections) {
    byId.set(section.id, section.body);
  }

  const lines: string[] = [
    "<user_profile>",
    "What we know about this user (durable profile; trust-checked at write time):",
  ];

  let emitted = 0;
  for (const entryType of GROUP_ORDER) {
    const body = byId.get(entryType)?.trim();
    if (body === undefined || body.length === 0) {
      continue;
    }
    lines.push(`### ${GROUP_HEADING[entryType]}`);
    lines.push(body);
    emitted += 1;
  }

  // No prefix-type section carried content ⇒ nothing to inject ⇒ byte-identity.
  if (emitted === 0) {
    return undefined;
  }

  lines.push("</user_profile>");
  return lines.join("\n");
}
