// SPDX-License-Identifier: Apache-2.0
/**
 * The two reasoning specialist prompts (DEDUCTIVE + INDUCTIVE) + their lenient,
 * total parsers.
 *
 * Mirrors `memory-consolidation-prompt.ts` (the prompt + lenient-total-parser
 * pattern). Split out of the reasoning job so the verbose prompts + the
 * cleanest defined-I/O unit (string → typed value) get no-mock RED→GREEN coverage
 * and the job file stays under the 800-line cap.
 *
 * Two specialist LLM contracts, both with the SAME anti-laundering invariant: the
 * model has NO trust field and NO supersede field. Trust is computed in CODE
 * (the job caps deductive at source-trust, floors inductive at ≤ learned);
 * supersession is the trust-first KG's concern (`upsertTriple`),
 * never the model's. Any `trustLevel`/`supersededIds` the model emits anyway is
 * STRIPPED by the lenient `z.object` (unknown keys dropped, NOT rejected), so it
 * can never influence the stored knowledge or observation.
 *
 *   - DEDUCTIVE: "connect evidence" → a `{ subject, predicate, object,
 *     confidence? }` S/P/O candidate (the shipped TripleCandidate shape,
 *     triple-extraction-job.ts). The job writes it via the trust-first
 *     `upsertTriple`.
 *   - INDUCTIVE: "identify a behavioral tendency" → a `{ content,
 *     patternType?, confidence? }` pattern. `patternType` is the Honcho-derived
 *     CLOSED enum — it MUST stay identical to `MemoryEntry.patternType`
 *     (memory-entry.ts) so the parser never accepts a value the domain rejects.
 *
 * @module
 */

import { z } from "zod";
import { parseLenientJson } from "./llm-json.js";
import { MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION } from "./memory-prompt-language.js";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * The DEDUCTIVE reasoning system prompt. Each call receives ONE
 * homogeneous evidence cluster (a single trust level + tag scope — the caller
 * partitions via `groupByTrustAndTagScope`); the model connects the evidence into
 * a single S/P/O fact. It explicitly does NOT choose a trust level and does NOT
 * mark anything superseded — trust is the job's code-computed source-trust cap,
 * and the trust-first KG handles supersession.
 */
export const DEDUCTIVE_PROMPT = `You are a detective connecting evidence into a single factual relationship.

You receive a small set of related memories that are already known to share a trust level and scope.
Infer the SINGLE most-supported subject-predicate-object fact they jointly establish.

Return ONLY valid JSON of the form:
{ "subject": "...", "predicate": "...", "object": "...", "confidence"?: 0.0-1.0 }

- "subject": the entity the fact is about.
- "predicate": the relationship (a short snake_case verb phrase, e.g. located_in, works_at).
- "object": the value the subject relates to.
- "confidence": optional — your confidence (0.0-1.0) that the evidence supports this fact.

Do NOT include a trust level. Do NOT mark anything as superseded or deleted.
Output the single fact only. No markdown fences, no commentary.
${MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION}`;

/**
 * The INDUCTIVE reasoning system prompt. Each call receives ONE
 * homogeneous evidence cluster; the model identifies a single behavioral
 * tendency. It explicitly does NOT choose a trust level (the job floors inductive
 * observations at ≤ learned in CODE) and does NOT mark anything superseded.
 *
 * The `patternType` enumeration here MUST stay identical to the domain enum
 * (`MemoryEntry.patternType`) — a mismatch would let the parser accept a value
 * the domain rejects (or vice versa).
 */
export const INDUCTIVE_PROMPT = `You are a psychologist identifying a behavioral tendency from a person's history.

You receive a small set of related memories that are already known to share a trust level and scope.
Identify the SINGLE most-supported behavioral pattern they jointly reveal, stated once, concisely.

Return ONLY valid JSON of the form:
{ "content": "...", "patternType"?: "preference"|"behavior"|"personality"|"tendency"|"correlation", "confidence"?: 0.0-1.0 }

- "content": the inferred tendency, stated once.
- "patternType": optional — one of preference, behavior, personality, tendency, correlation.
- "confidence": optional — your confidence (0.0-1.0) that the evidence supports this pattern.

Do NOT include a trust level. Do NOT mark anything as superseded or deleted.
Output the single pattern only. No markdown fences, no commentary.
${MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION}`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * LENIENT result schema for the INDUCTIVE contract. `z.object` (NOT
 * `strictObject`) so an unrequested LLM key — a benign extra, or a contract
 * violation like `trustLevel`/`supersededIds` — is STRIPPED, not rejected: a valid
 * pattern is never discarded over an extra field, and a smuggled trust field is
 * dropped before it can reach the store. `patternType` is `.optional()`, so an
 * out-of-set value fails THAT field and is omitted (the pattern still parses
 * without it) — the enum is closed (matches `MemoryEntry.patternType`).
 */
const InductiveResultSchema = z.object({
  content: z.string().min(1),
  patternType: z
    .enum(["preference", "behavior", "personality", "tendency", "correlation"])
    .optional()
    .catch(undefined),
  confidence: z.number().min(0).max(1).optional(),
});

/**
 * LENIENT result schema for the DEDUCTIVE contract. `z.object` (NOT
 * `strictObject`) so any smuggled `trustLevel`/`supersededIds` is STRIPPED. Reuses
 * the shipped S/P/O TripleCandidate shape (triple-extraction-job.ts) — the job
 * binds trust + sourceTrust in CODE.
 */
const DeductiveResultSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

/** The parsed inductive pattern the job consumes. */
export type InductiveResult = z.infer<typeof InductiveResultSchema>;
/** The parsed deductive S/P/O candidate the job consumes. */
export type DeductiveResult = z.infer<typeof DeductiveResultSchema>;

/**
 * Strip markdown code fences from raw LLM text (mirrors
 * `parseConsolidationResult`'s cleaning step).
 */
function stripFences(text: string): string {
  return text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
}

/**
 * Parse raw LLM text into an {@link InductiveResult}.
 *
 * TOTAL function — NEVER throws (the non-fatal contract at the parse boundary):
 * a malformed/adversarial payload returns `undefined` so the job WARNs +
 * continues. Steps: strip fences → `JSON.parse` inside try/catch (parse error →
 * `undefined`) → `safeParse` against the lenient schema (missing/empty content,
 * wrong shape, or out-of-range confidence → `undefined`; unknown keys —
 * INCLUDING a smuggled `trustLevel`/`supersededIds` — stripped; an out-of-set
 * `patternType` omitted).
 */
export function parseInductiveResult(text: string): InductiveResult | undefined {
  const json: unknown = parseLenientJson(text);
  // parseLenientJson tolerates narration around the payload (live finding
  // 2026-06-11 — the whole-string parse degraded valid payloads).
  if (json === undefined) return undefined;
  const parsed = InductiveResultSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Parse raw LLM text into a {@link DeductiveResult}.
 *
 * TOTAL function — NEVER throws (same shape as {@link parseInductiveResult}): a
 * malformed/adversarial payload returns `undefined`; a smuggled
 * `trustLevel`/`supersededIds` is stripped; a missing/empty S/P/O or an
 * out-of-range confidence yields `undefined`.
 */
export function parseDeductiveResult(text: string): DeductiveResult | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch {
    return undefined;
  }
  const parsed = DeductiveResultSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
