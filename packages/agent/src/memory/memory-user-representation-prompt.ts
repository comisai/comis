// SPDX-License-Identifier: Apache-2.0
/**
 * The per-user representation builder prompt + its lenient, total parser.
 *
 * Mirrors `memory-reasoning-prompt.ts` (the prompt + lenient-total-parser
 * pattern). Split out of the builder job so the verbose prompt + the cleanest
 * defined-I/O unit (string → typed value) get no-mock RED→GREEN coverage, and the
 * daemon's seam imports the prompt + parser from HERE — keeping the prompt string
 * agent-internal (it never crosses into the daemon, mirroring how
 * {@link createReasoningSeam} keeps `DEDUCTIVE_PROMPT`/`INDUCTIVE_PROMPT` private).
 *
 * The single anti-laundering invariant: the model has NO trust field. Trust is the
 * profile-builder job's CODE-computed source-trust ceiling — capped at the
 * high-trust floor (`system`/`learned`); `external` is structurally excluded (the
 * port type + the DB CHECK). Any `trust` the model emits anyway is STRIPPED by the
 * lenient `z.object` (unknown keys dropped, NOT rejected) — it
 * can never influence the stored representation. The `entryType` is the CLOSED
 * `identity`/`preference`/`relationship`/`instruction` prefix-type set (DISTINCT
 * from `memoryType` + the trust ladder); a candidate with any other `entryType` is
 * dropped (the per-item `safeParse` fails THAT element, the rest still parse).
 *
 * @module
 */

import { z } from "zod";
import { parseLenientJson } from "./llm-json.js";
import { MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION } from "./memory-prompt-language.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One representation candidate the build() seam emits — the parsed shape the job
 * consumes. NO `trust` field: the LLM has no say in trust; the job sets it in CODE
 * at the source ceiling. `entryType` is the closed prefix-type set.
 */
export interface UserRepresentationCandidate {
  /** The prefix type (identity/preference/relationship/instruction). */
  entryType: "identity" | "preference" | "relationship" | "instruction";
  /** The profile text (conversation-derived; the job runs `validateMemoryWrite` on it before upsert). */
  content: string;
}

/** The typed output of one INJECTED build() call: zero-or-more candidates. */
export type UserRepresentationBuildOutput = UserRepresentationCandidate[];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The per-user representation builder system prompt. The model receives a small
 * set of HIGH-TRUST source memories about ONE user (the builder has
 * already excluded `external`-trust sources — the model never sees them) and
 * distills durable, PREFIX-TYPED profile facts.
 *
 * It explicitly does NOT choose a trust level (the job sets trust in CODE at the
 * source ceiling) and emits ONLY the four prefix types — a parser drops anything
 * else, and the job's `validateMemoryWrite` is the redaction firewall on every
 * candidate.
 */
export const USER_REPRESENTATION_PROMPT = `You are building a concise, durable profile of a single user from a small set of trusted memories about them.

Identify the durable, high-signal facts about this ONE user. Each fact is one of four PREFIX TYPES:
- "identity": a stable fact about who they are (name, role, location, language).
- "preference": something they consistently like, want, or prefer.
- "relationship": a stable relation to a named entity in their own life (e.g. their manager, their team, their project).
- "instruction": a standing instruction they have given about how to be helped.

Return ONLY valid JSON: an ARRAY of objects of the form
[ { "entryType": "identity"|"preference"|"relationship"|"instruction", "content": "..." }, ... ]

- "entryType": exactly one of the four prefix types above.
- "content": the durable fact, stated once, concisely. Omit transient, low-signal, or speculative claims.

Do NOT include a trust level. Do NOT mark anything as superseded or deleted.
Return [] if the memories establish no durable profile fact. No markdown fences, no commentary.
${MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION}`;

/**
 * Build the builder system prompt for one source-memory set. The source text is
 * appended so the daemon's seam can keep this prompt assembly agent-internal — it
 * imports this helper rather than embedding the prompt string itself. Counts-only
 * callers never log the returned text (it embeds source content).
 */
export function buildUserRepresentationPrompt(sourceText: string): string {
  return `${USER_REPRESENTATION_PROMPT}\n\nThe trusted memories:\n${sourceText}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * LENIENT per-candidate schema. `z.object` (NOT `strictObject`) so any smuggled
 * `trust`/`trustLevel` field is STRIPPED, not rejected: a valid candidate is never
 * discarded over an extra field, and a smuggled trust value (even a forbidden
 * `external`) is dropped before it can reach the store. `entryType` is the CLOSED
 * prefix-type enum — an out-of-set value fails the per-item parse, dropping THAT
 * candidate (the rest survive).
 */
const CandidateSchema = z.object({
  entryType: z.enum(["identity", "preference", "relationship", "instruction"]),
  content: z.string().min(1),
});

/**
 * Parse raw build()-seam text into a {@link UserRepresentationBuildOutput}.
 *
 * TOTAL function — NEVER throws (the non-fatal contract at the parse boundary): a
 * malformed/adversarial payload returns `[]` so the job continues. Steps: strip
 * fences → `JSON.parse` inside try/catch (parse error → `[]`) → require a
 * top-level ARRAY (a bare object / null / scalar → `[]`) → per element
 * `safeParse` against the lenient schema, KEEPING only the successes (a smuggled
 * `trust` stripped; an out-of-set `entryType` or empty `content` dropped). The
 * returned candidates carry ONLY `{ entryType, content }` — never `trust`.
 */
export function parseUserRepresentationOutput(raw: string): UserRepresentationBuildOutput {
  const json: unknown = parseLenientJson(raw);
  // parseLenientJson tolerates narration around the payload (live finding
  // 2026-06-11 — the whole-string parse degraded valid payloads).
  if (json === undefined) return [];
  if (!Array.isArray(json)) return [];

  const out: UserRepresentationBuildOutput = [];
  for (const element of json) {
    const parsed = CandidateSchema.safeParse(element);
    if (!parsed.success) continue;
    // Reconstruct from the parsed fields ONLY — z.object strips unknown keys, but
    // building the object explicitly makes the "no trust" guarantee structural.
    out.push({ entryType: parsed.data.entryType, content: parsed.data.content });
  }
  return out;
}

