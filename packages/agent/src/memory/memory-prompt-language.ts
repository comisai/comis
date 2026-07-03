// SPDX-License-Identifier: Apache-2.0
/**
 * The shared language-preservation instruction for the cron-driven LTM-learning
 * prompts (consolidation / deductive+inductive reasoning / user-representation).
 *
 * The SUMMARIZER prompts carry a preservation sentence so a Hebrew conversation
 * summarizes in Hebrew. The
 * LTM-learning prompts generate NEW human-readable text from stored memories the
 * same way — a folded observation, an inferred fact, a profile entry — and would
 * otherwise be language-blind. The user-representation prompt in particular carries
 * English templates ("is named X", "is N years old") that bias the model to
 * TRANSLATE Hebrew source facts into an English profile (live-confirmed:
 * "קוראים לי יוסי כהן" → "is named Yossi Cohen"), violating the
 * preservation-not-translation invariant and degrading the per-user
 * profile for non-Latin users — sharply on small/nano models, which do NOT
 * reliably mirror the input language on their own.
 *
 * This is the LTM-learning sibling of context-engine's
 * LANGUAGE_PRESERVATION_INSTRUCTION (summarizers). It is single-sourced:
 * imported by all three prompt modules, never copied. It carves out the
 * structural field keys (`entryType`/`predicate`/`patternType` — the JSON
 * contract + the snake_case predicate machine keys) and code identifiers so the
 * parse contracts and graph keys stay English/verbatim while the human-readable
 * VALUES follow the source language.
 *
 * Latin/English source ⇒ English output (byte-identical intent for the English
 * path): "the dominant language of the source" of English memories is English,
 * so the instruction is a no-op for Latin deployments.
 *
 * @module
 */

/** Single-sourced language-preservation rule for the LTM-learning prompts. */
export const MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION =
  "Write every human-readable value in the dominant language of the source memories — if the memories are in Hebrew, respond in Hebrew; if Arabic, in Arabic; never translate. Keep the structural field keys (entryType, predicate, patternType) and any code identifiers, file paths, and tool names verbatim in English.";
