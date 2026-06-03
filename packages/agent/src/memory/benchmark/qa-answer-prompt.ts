// SPDX-License-Identifier: Apache-2.0
/**
 * Pure answer-prompt builder — formats the RECALLED context into the
 * prompt the gated harness sends to the answer model, then has the
 * judge grade that answer. Drives the "better memory" claim end-to-end: recall ->
 * answer -> judge.
 *
 * Mirrors the cut-clean, type-only seam of `recall-eval.ts` (the pure
 * `@comis/core`-types-only consumer): the agent->memory architecture cut
 * (test/architecture/architecture-graph.test.ts:133) forbids importing the
 * memory package from agent `src`, so the recalled-result type is imported as a
 * TYPE ONLY from `@comis/core` (exactly recall-eval.ts:33). The live store +
 * recall wiring lives in the gated `.test.ts` (the single cut escape hatch).
 *
 * SYSTEM/USER SPLIT: the answer prompt is split into
 * {@link ANSWER_SYSTEM_PROMPT} (the system preamble — role/behavior instruction)
 * and {@link buildAnswerPrompt} (the USER content — the question + the formatted
 * Retrieved-Context block, with NO preamble), so the gated harness can call
 * `completeSimple({ systemPrompt: ANSWER_SYSTEM_PROMPT, messages: [{ role:
 * "user", content: buildAnswerPrompt(...) }] })` cleanly without duplicating the
 * preamble into the user turn.
 *
 * GLOBALS: dated anchors are formatted via the sanctioned `systemDateFrom`
 * indirection (packages/core/src/runtime/system-time.ts:34) — never the raw
 * Date constructor or wall-clock read (this is `src/`; the globals rule scopes
 * to src/**).
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";
import { systemDateFrom } from "@comis/core";

/**
 * The answer-model system preamble (the system slot ONLY — the role/behavior
 * instruction). A minimal faithful port of the LongMemEval answer prompt (a
 * minimal faithful port is sufficient; elaborate guidance is optional polish).
 * Kept SEPARATE from {@link buildAnswerPrompt} so the user turn never duplicates it.
 */
export const ANSWER_SYSTEM_PROMPT =
  "You are a helpful assistant that must answer the question based ONLY on the " +
  "retrieved previous conversations. If the retrieved context does not contain " +
  "the answer, say you don't know.";

/** Explicit sentinel for an empty recall — keeps the prompt total (never throws). */
const EMPTY_CONTEXT_SENTINEL = "(no retrieved context)";

/**
 * Format the recalled results into the Retrieved-Context block.
 *
 * Each result renders its `entry.content` prefixed with a dated anchor derived
 * from `occurredAt ?? createdAt` (the event time when known, else the record
 * time) via `systemDateFrom(...).toISOString()`. An empty array yields the
 * explicit {@link EMPTY_CONTEXT_SENTINEL} — the formatter is TOTAL and never
 * throws on the empty-recall case.
 *
 * Pure: no clock read (the timestamps come from the entries), no I/O, no
 * memory-package import.
 */
export function formatAnswerContext(ranked: ReadonlyArray<MemorySearchResult>): string {
  if (ranked.length === 0) {
    return EMPTY_CONTEXT_SENTINEL;
  }
  return ranked
    .map((r, i) => {
      const anchorMs = r.entry.occurredAt ?? r.entry.createdAt;
      const date = systemDateFrom(anchorMs).toISOString();
      return `[${i + 1}] (${date}) ${r.entry.content}`;
    })
    .join("\n");
}

/**
 * Build the USER content of the answer prompt (the system preamble lives in
 * {@link ANSWER_SYSTEM_PROMPT}, NOT here). Carries the question, the optional
 * question date (an explicit `"unknown"` sentinel when absent), and the
 * formatted Retrieved-Context block, ending with the `Answer:` cue.
 *
 * Pure: no clock, no I/O, no memory-package import.
 */
export function buildAnswerPrompt(
  question: string,
  context: string,
  questionDate?: string,
): string {
  return (
    `Question: ${question}\n` +
    `Question Date: ${questionDate ?? "unknown"}\n\n` +
    `Retrieved Context:\n${context}\n\n` +
    "Answer:"
  );
}
