// SPDX-License-Identifier: Apache-2.0
/**
 * The shared language-preservation instruction for the cron-driven LTM-learning
 * prompts (consolidation / deductive+inductive reasoning / user-representation).
 *
 * GEN-01 (v2.22 multilingual-excellence) added a preservation sentence to the
 * SUMMARIZER prompts so a Hebrew conversation summarizes in Hebrew. The
 * LTM-learning prompts generate NEW human-readable text from stored memories the
 * same way — a folded observation, an inferred fact, a profile entry — and were
 * left language-blind. The user-representation prompt in particular carries
 * English templates ("is named X", "is N years old") that bias the model to
 * TRANSLATE Hebrew source facts into an English profile (live-confirmed
 * 2026-06-13: "קוראים לי יוסי כהן" → "is named Yossi Cohen"), violating design
 * invariant I5 (preservation, not translation) and degrading the per-user
 * profile for non-Latin users — sharply on small/nano models, which the design
 * (§7.3) treats as the center of gravity and which do NOT reliably mirror the
 * input language on their own.
 *
 * This is the LTM-learning sibling of context-engine's
 * LANGUAGE_PRESERVATION_INSTRUCTION (summarizers). It is single-sourced (I7):
 * imported by all three prompt modules, never copied. It carves out the
 * structural field keys (`entryType`/`predicate`/`patternType` — the JSON
 * contract + the snake_case predicate machine keys) and code identifiers so the
 * parse contracts and graph keys stay English/verbatim while the human-readable
 * VALUES follow the source language.
 *
 * Latin/English source ⇒ English output (I1 byte-identical intent): "the
 * dominant language of the source" of English memories is English, so the
 * instruction is a no-op for Latin deployments.
 *
 * @module
 */

/** Single-sourced (I7) language-preservation rule for the LTM-learning prompts. */
export const MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION =
  "Write every human-readable value in the dominant language of the source memories — if the memories are in Hebrew, respond in Hebrew; if Arabic, in Arabic; never translate. Keep the structural field keys (entryType, predicate, patternType) and any code identifiers, file paths, and tool names verbatim in English.";
