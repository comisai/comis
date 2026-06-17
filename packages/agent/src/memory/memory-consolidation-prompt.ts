// SPDX-License-Identifier: Apache-2.0
/**
 * The consolidation MERGE prompt + its lenient, total parser.
 *
 * Split out of `memory-consolidation-job.ts` (sibling to `memory-extraction.ts`)
 * so the verbose prompt + the cleanest defined-I/O unit (string → value) get
 * no-mock RED→GREEN coverage and the job file stays under the 800-line cap.
 *
 * The LLM contract is MERGE-ONLY (design §6.3): the model collapses a
 * homogeneous cluster of near-duplicate memories into ONE concise factual
 * statement. It emits `{ content, confidence?, sourceIds? }` and NOTHING ELSE —
 * it has NO trust field and NO supersede field. Trust is computed in CODE
 * (`minTrust`, the ceiling); supersession is out of scope (non-destructive).
 * Any `trustLevel`/`supersededIds` the model emits anyway is
 * STRIPPED by the lenient `z.object` (unknown keys dropped), so it can never
 * influence the stored observation.
 *
 * @module
 */

import { z } from "zod";
import { parseLenientJson } from "./llm-json.js";
import { MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION } from "./memory-prompt-language.js";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The MERGE-only consolidation system prompt (design §6.3).
 *
 * Each call receives ONE homogeneous sub-cluster (a single trust level + tag
 * scope — the caller partitions via `groupByTrustAndTagScope`). The
 * model merges the cluster into a single statement; it explicitly does NOT
 * choose a trust level and does NOT mark anything superseded.
 */
export const CONSOLIDATION_PROMPT = `You merge several near-duplicate memories about the same fact into ONE concise statement.

You receive a small set of memories that are already known to be about the same thing.
Output a SINGLE merged factual statement that preserves their combined meaning, stated once,
concisely, without losing any distinct detail.

Return ONLY valid JSON of the form:
{ "content": "the merged statement", "confidence": 0.0-1.0, "sourceIds"?: ["..."] }

- "content": the merged fact, stated once.
- "confidence": your confidence (0.0-1.0) that the merge is faithful.
- "sourceIds": optional — the ids of the inputs you merged.

Do NOT include a trust level. Do NOT mark anything as superseded or deleted.
Output the merged statement only. No markdown fences, no commentary.
${MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION}`;

/**
 * The GENERALIZE-only synthesis system prompt (GENERAL-01, design §WS6).
 *
 * DISTINCT from {@link CONSOLIDATION_PROMPT}: where consolidation MERGES
 * near-duplicates of the SAME fact into one statement, generalization ABSTRACTS
 * a cluster that recurs across MULTIPLE distinct contexts into one HIGHER-ORDER
 * statement of the general pattern ("the user prefers concise answers in
 * general") — not a verbatim copy. Same MERGE-style output contract (`{ content,
 * confidence? }`, no trust field, no supersede field — trust is computed in CODE
 * via `minTrust`, and the higher-order memory is a NEW non-destructive node), so
 * the existing {@link parseConsolidationResult} parses it.
 *
 * The cluster input fed to this prompt is UNTRUSTED and MUST be
 * `wrapExternalContent`-wrapped by the caller before the LLM (SEC-01 new stage).
 */
export const GENERALIZATION_PROMPT = `You synthesize ONE higher-order general statement from several memories that share a pattern across DIFFERENT situations.

You receive a small set of memories already known to recur across multiple distinct contexts.
Output a SINGLE higher-order statement that captures the GENERAL pattern they share — what is true "in general"
— rather than restating any one of them verbatim. Abstract the shared preference/fact; do not invent specifics
that are not supported by the inputs.

Return ONLY valid JSON of the form:
{ "content": "the higher-order general statement", "confidence": 0.0-1.0 }

- "content": the general statement, stated once.
- "confidence": your confidence (0.0-1.0) that the generalization is faithful to the inputs.

Do NOT include a trust level. Do NOT mark anything as superseded or deleted.
Output the general statement only. No markdown fences, no commentary.
${MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION}`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * LENIENT result schema for the MERGE-only contract. `z.object` (NOT
 * `strictObject`) so an unrequested LLM key (a benign `note`, or a contract
 * violation like `trustLevel`/`supersededIds`) is STRIPPED, not rejected — a
 * valid merge is never discarded over an extra field, and a smuggled trust
 * field is dropped before it can reach the store.
 */
const ConsolidationResultSchema = z.object({
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceIds: z.array(z.string()).optional(),
});

/** The parsed merge result the job consumes. */
export type ConsolidationResult = z.infer<typeof ConsolidationResultSchema>;

/**
 * Parse raw LLM text into a {@link ConsolidationResult}.
 *
 * TOTAL function — NEVER throws (the non-fatal contract at the parse boundary,
 * mirroring `parseExtractionResult`): malformed/adversarial payloads return
 * `undefined` so the job WARNs + continues. Steps:
 *   1. strip markdown code fences,
 *   2. `JSON.parse` inside try/catch (parse error → `undefined`),
 *   3. `safeParse` against the lenient schema (missing/empty content, wrong
 *      shape, or out-of-range confidence → `undefined`; unknown keys stripped).
 *
 * The model's MERGE-only contract has no trust field — any `trustLevel` /
 * `supersededIds` it emits is stripped here, never propagated.
 */
export function parseConsolidationResult(text: string): ConsolidationResult | undefined {
  const cleaned = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  const json: unknown = parseLenientJson(cleaned);
  // parseLenientJson tolerates narration around the payload (live finding
  // 2026-06-11 — the whole-string parse degraded valid payloads).
  if (json === undefined) return undefined;
  const parsed = ConsolidationResultSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
