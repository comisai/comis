// SPDX-License-Identifier: Apache-2.0
//
// The SUMMARIZER prompts carry the LANGUAGE_PRESERVATION_INSTRUCTION; the
// cron-driven LTM-learning prompts need the same rule. Empirically a
// language-blind profile prompt TRANSLATES Hebrew source facts into English
// ("קוראים לי יוסי כהן" → "is named Yossi Cohen"), violating the preservation
// invariant (preservation, not translation). These prompts must carry the same
// explicit preservation instruction (don't depend on the model mirroring the
// input — small models translate rather than mirror).
// Structural field keys + code identifiers stay verbatim.
//
// All LTM-learning generation runs through the ONE reflection engine, so the
// guard pins its prompts (the skill REFLECT prompt + the kind:"profile"
// PROFILE_REFLECT + the kind:"topic" TOPIC_REFLECT), which carry the SAME
// preservation instruction.
import { describe, it, expect } from "vitest";
import { MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION } from "./memory-prompt-language.js";
import { PROFILE_REFLECT_PROMPT, TOPIC_REFLECT_PROMPT } from "./reflection-prompt.js";

describe("LTM-learning (reflection) prompts preserve the source language", () => {
  it("the shared instruction names the never-translate rule AND the verbatim-key carve-out", () => {
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/never translate/i);
    // structural keys + identifiers must be exempt so the JSON contract + snake_case predicates survive
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/verbatim/i);
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/entryType|predicate|patternType|field key/i);
  });

  // The profile + topic reflection prompts distill USER FACTS / OBSERVATIONS — the
  // source-language translation hazard this guard exists for. The skill REFLECT_PROMPT
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
