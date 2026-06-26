// SPDX-License-Identifier: Apache-2.0
//
// v2.22 GEN-01 follow-up (live-found 2026-06-13): GEN-01 added the
// LANGUAGE_PRESERVATION_INSTRUCTION to the SUMMARIZER prompts, but the
// cron-driven LTM-learning prompts were left language-blind. Empirically a
// profile prompt TRANSLATES Hebrew source facts into English ("קוראים לי יוסי כהן"
// → "is named Yossi Cohen"), violating design invariant I5 (preservation, not
// translation). These prompts must carry the same explicit preservation instruction
// (don't depend on the model mirroring the input — the design's center of gravity is
// small models, which translate). Structural field keys + code identifiers stay verbatim.
//
// v2.31 Phase 225-05: the standalone consolidation / reasoning / user-representation
// prompts were DELETED — their LTM-learning work folded into the ONE reflection engine.
// The guard now pins the SURVIVING reflection prompts (the FOLD replacements: the skill
// REFLECT prompt + the kind:"profile" PROFILE_REFLECT + the kind:"topic" TOPIC_REFLECT),
// which carry the SAME preservation instruction.
import { describe, it, expect } from "vitest";
import { MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION } from "./memory-prompt-language.js";
import { PROFILE_REFLECT_PROMPT, TOPIC_REFLECT_PROMPT } from "./reflection-prompt.js";

describe("LTM-learning (reflection) prompts preserve the source language (GEN-01 follow-up)", () => {
  it("the shared instruction names the never-translate rule AND the verbatim-key carve-out", () => {
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/never translate/i);
    // structural keys + identifiers must be exempt so the JSON contract + snake_case predicates survive
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/verbatim/i);
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/entryType|predicate|patternType|field key/i);
  });

  // The profile + topic reflection prompts distill USER FACTS / OBSERVATIONS (the source-language
  // translation hazard the original consolidation/reasoning/user-representation prompts had — those
  // were deleted in Phase 225-05 and these are their FOLD replacements). The skill REFLECT_PROMPT
  // distills a task PLAYBOOK (no per-user fact corpus) and is intentionally not in this guard.
  for (const [name, prompt] of [
    ["profile reflection (PROFILE_REFLECT_PROMPT)", PROFILE_REFLECT_PROMPT],
    ["topic reflection (TOPIC_REFLECT_PROMPT)", TOPIC_REFLECT_PROMPT],
  ] as const) {
    it(`${name} embeds the language-preservation instruction (no Hebrew→English translation)`, () => {
      expect(prompt).toContain(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION);
    });
  }
});
