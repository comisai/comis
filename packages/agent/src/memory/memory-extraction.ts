// SPDX-License-Identifier: Apache-2.0
/**
 * Pure, deterministic helpers for the structured memory-extraction job.
 * Extracted into this sibling of
 * `memory-review-job.ts` so the verbose prompt + the cleanest defined-I/O
 * units (string/number → value) live apart from the job's I/O — keeping the
 * job file under the 800-line cap and giving these functions no-mock,
 * RED→GREEN unit coverage. The job wires these into `runMemoryReview`.
 *
 * Contents:
 * - {@link STRUCTURED_PROMPT}: the Hindsight-style system prompt instructing the
 *   LLM to emit `{ memories: [{ content, occurredAt?(ISO), entities[], memoryType?, causes? }] }`,
 *   convert relative dates to absolute ISO 8601, always include the
 *   "user" entity, emit explicit cause→effect `causes`,
 *   apply ✅/❌ selectivity, and respond in the source language.
 * - {@link parseExtractionResult}: a TOTAL parser — fence-strip + JSON.parse +
 *   `MemoryExtractionResultSchema.safeParse`. Returns `undefined` on ANY failure
 *   and NEVER throws (the non-fatal contract at the parse boundary).
 * - {@link resolveOccurredAt}: resolve an LLM-emitted ISO date to epoch ms against
 *   an INJECTED reference `nowMs`. Sanity-bounded; `undefined` for
 *   absent/unparseable/absurd values. Reads NO clock itself (no `Date.now()` /
 *   `new Date()` — uses the sanctioned `systemDateFrom` indirection only).
 *
 * @module
 */

import { MemoryExtractionResultSchema, StructuredMemorySchema, systemDateFrom, type MemoryExtractionResult } from "@comis/core";
import { parseLenientJson } from "./llm-json.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sanity bounds for {@link resolveOccurredAt}, applied against the injected
 * reference `nowMs` (never a wall-clock read).
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HUNDRED_YEARS_MS = 100 * 365 * ONE_DAY_MS;

/**
 * The Hindsight-style structured-extraction system prompt (design §6.1).
 *
 * Instructs the LLM to emit the `{ memories: [...] }` envelope the parser
 * validates, convert ALL relative temporal expressions to absolute ISO 8601,
 * always include the "user" entity, apply ✅/❌ selectivity,
 * and RESPOND IN THE SAME LANGUAGE AS THE CONVERSATION. Kept lean —
 * this constant is the reason the prompt lives in a sibling, not in the job.
 */
export const STRUCTURED_PROMPT = `You analyze chat session histories and extract durable facts about the user.

For each fact, output an object: { "content", "occurredAt"?, "entities", "memoryType"?, "causes"? }
- "content": the fact, stated concisely.
- "occurredAt": if the fact references WHEN something happened, convert ALL relative temporal
  expressions ("yesterday", "last month", "two weeks ago") to an ABSOLUTE ISO 8601 timestamp.
  Omit "occurredAt" entirely if no event time is implied.
- "entities": an array of name strings — the people, things, and topics the fact mentions,
  e.g. "entities": ["user", "Dana", "Acme"]. ALWAYS include "user" when the
  fact is about the user. Resolve coreferences: replace pronouns and generic references
  ("she", "my boss", "the project") with the concrete canonical name they refer to
  ("Dana", "Acme"), and use the SAME canonical spelling for every mention so repeat
  references fold together. Omit an entity you cannot concretely name.
- "memoryType": one of working|episodic|semantic|procedural (default semantic).
- "causes": if this fact CAUSES or leads to another durable fact, list each consequence as
  { "effect": "<the consequence, stated as a concise fact>" }. Only include a causal link when
  the cause→effect relationship is EXPLICIT in the conversation. Omit "causes" otherwise.

✅ Extract durable facts: stable preferences, identity facts, durable relationships,
   dated commitments, decisions.
❌ Skip filler: greetings, acknowledgements, transient mood, one-off chit-chat or logistics,
   system/assistant messages, or anything already obvious or restating an earlier fact.

RESPOND IN THE SAME LANGUAGE AS THE CONVERSATION. If the conversation is in Spanish, the
"content" must be in Spanish.

Return ONLY valid JSON of the form: { "memories": [ ... ] }
No markdown fences, no commentary. If nothing qualifies: { "memories": [] }`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw LLM text into a validated {@link MemoryExtractionResult}.
 *
 * TOTAL function — it NEVER throws (the non-fatal contract at the parse
 * boundary): adversarial or malformed payloads return `undefined`, so a bad
 * payload cannot crash the caller (the job advances the watermark on
 * `undefined`). Steps:
 *   1. strip markdown code fences (same regex as the replaced flat parser),
 *   2. `JSON.parse` inside try/catch (parse error → `undefined`),
 *   3. `MemoryExtractionResultSchema.safeParse` (schema mismatch → `undefined`).
 *
 * The schema is LENIENT: a benign extra LLM key (e.g. `confidence`)
 * is stripped, not rejected, so a valid memory is never discarded over an
 * unrequested field. The OLD flat `[{content, session}]` array shape is rejected
 * (it is not the `{ memories: [...] }` envelope).
 */
export function parseExtractionResult(text: string): MemoryExtractionResult | undefined {
  // parseLenientJson tolerates the narration-before-JSON pattern observed
  // live 2026-06-11 (the whole-string parse degraded a VALID extraction to
  // "invalid output, skipping" on a fact-rich conversation).
  const json = parseLenientJson(text);
  if (json === undefined) return undefined;
  const parsed = MemoryExtractionResultSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  // Per-memory salvage (live finding 2026-06-11): one malformed element used
  // to fail the envelope and discard EVERY fact in the batch. Re-validate
  // element-by-element and keep the valid memories; undefined only when the
  // envelope itself is unusable.
  if (typeof json !== "object" || json === null) return undefined;
  const rawMemories = (json as { memories?: unknown }).memories;
  if (!Array.isArray(rawMemories)) return undefined;
  const memories = rawMemories
    .map((m) => StructuredMemorySchema.safeParse(m))
    .filter((r): r is { success: true; data: MemoryExtractionResult["memories"][number] } => r.success)
    .map((r) => r.data);
  return { memories };
}

// ---------------------------------------------------------------------------
// Date resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an LLM-emitted ISO 8601 date string to epoch ms, validated against
 * the INJECTED reference `nowMs`. The caller passes
 * `clock.now()` — this function reads NO clock itself and contains no
 * `Date.now()` / `new Date()` (it uses the sanctioned `systemDateFrom`
 * indirection for the known ISO value only).
 *
 * Returns `undefined` (→ `occurredAt` left absent, falling back to `createdAt`)
 * when the date is:
 *   - absent,
 *   - unparseable (non-finite),
 *   - far-future (> now + 1 day — a likely parse artifact), or
 *   - absurd-past (> 100 years before now).
 * These bounds reject a poisoned date from steering temporal ranking.
 */
export function resolveOccurredAt(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined;
  const ms = systemDateFrom(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  if (ms > nowMs + ONE_DAY_MS) return undefined;
  if (ms < nowMs - ONE_HUNDRED_YEARS_MS) return undefined;
  return ms;
}
