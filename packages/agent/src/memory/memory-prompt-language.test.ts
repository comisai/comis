// SPDX-License-Identifier: Apache-2.0
//
// v2.22 GEN-01 follow-up (live-found 2026-06-13): GEN-01 added the
// LANGUAGE_PRESERVATION_INSTRUCTION to the SUMMARIZER prompts, but the
// cron-driven LTM-learning prompts (consolidation / deductive+inductive
// reasoning / user-representation) were left language-blind. Empirically the
// user-representation prompt TRANSLATES Hebrew source facts into an English
// profile ("קוראים לי יוסי כהן" → "is named Yossi Cohen"), violating design
// invariant I5 (preservation, not translation) and re-opening the G4 recall
// hole for the per-user profile on small/nano deployments. These prompts must
// carry the same explicit preservation instruction (don't depend on the model
// mirroring the input — the design's center of gravity is small models, which
// translate). Structural field keys (entryType/predicate/patternType) and code
// identifiers stay verbatim — the instruction says so.
import { describe, it, expect } from "vitest";
import { MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION } from "./memory-prompt-language.js";
import { CONSOLIDATION_PROMPT } from "./memory-consolidation-prompt.js";
import { DEDUCTIVE_PROMPT, INDUCTIVE_PROMPT } from "./memory-reasoning-prompt.js";
import { USER_REPRESENTATION_PROMPT } from "./memory-user-representation-prompt.js";

describe("LTM-learning prompts preserve the source language (GEN-01 follow-up)", () => {
  it("the shared instruction names the never-translate rule AND the verbatim-key carve-out", () => {
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/never translate/i);
    // structural keys + identifiers must be exempt so the JSON contract + snake_case predicates survive
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/verbatim/i);
    expect(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION).toMatch(/entryType|predicate|patternType|field key/i);
  });

  for (const [name, prompt] of [
    ["consolidation", CONSOLIDATION_PROMPT],
    ["deductive reasoning", DEDUCTIVE_PROMPT],
    ["inductive reasoning", INDUCTIVE_PROMPT],
    ["user representation", USER_REPRESENTATION_PROMPT],
  ] as const) {
    it(`${name} prompt embeds the language-preservation instruction (no Hebrew→English translation)`, () => {
      expect(prompt).toContain(MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION);
    });
  }
});
