// SPDX-License-Identifier: Apache-2.0
/**
 * The offline DIRECTIONAL relationship builder prompt + its lenient, total parser.
 *
 * Mirrors `memory-user-representation-prompt.ts` (the prompt + lenient-total-parser
 * pattern). Split out of the builder job so the verbose prompt + the cleanest
 * defined-I/O unit (string → typed value) get no-mock RED→GREEN coverage, and the
 * daemon's seam imports the prompt + parser from HERE — keeping the prompt string
 * agent-internal (it never crosses into the daemon, mirroring how
 * {@link createUserRepresentationSeam} keeps `USER_REPRESENTATION_PROMPT` private).
 *
 * The DELTA from the per-user profile builder: a relationship candidate is
 * DIRECTIONAL — it carries a `subjectUserId` (the speaker, attributed from the
 * sender-prefixed source line) and an `aboutUserId` (whom the statement concerns,
 * extracted by the model) plus the free relationship `content`. A→B is a DISTINCT
 * candidate from B→A; the parser never symmetrizes. There is NO prefix-type
 * vocabulary (unlike the four per-user-profile `entryType`s) — the edge is
 * `subject → about` + free content (the port carries no relationship-kind enum).
 *
 * The single anti-laundering invariant (shared with the per-user profile builder):
 * the model has NO trust field. Trust is the builder job's CODE-computed source-trust
 * ceiling — capped at the high-trust floor (`system`/`learned`); `external` is
 * structurally excluded (the port type + the DB CHECK constraint). Any `trust` the model emits anyway
 * is STRIPPED by the lenient `z.object` (unknown keys dropped, NOT rejected) — it
 * can never influence the stored edge. A candidate missing either directional
 * endpoint (`subjectUserId` or `aboutUserId`) is dropped (the per-item `safeParse`
 * fails THAT element, the rest still parse).
 *
 * @module
 */

import { z } from "zod";
import { parseLenientJson } from "./llm-json.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One DIRECTIONAL relationship candidate the build() seam emits — the parsed shape
 * the job consumes. NO `trust` field: the LLM has no say in trust; the job sets it
 * in CODE at the source ceiling. The `(subjectUserId, aboutUserId)` pair
 * is the directional edge — subject's representation OF about; it is NEVER
 * symmetrized.
 */
export interface RelationshipCandidate {
  /** The SUBJECT of the edge — whose belief/statement this is (the speaker). */
  subjectUserId: string;
  /** The OBJECT of the edge — whom the relationship content concerns. */
  aboutUserId: string;
  /** The relationship text (conversation-derived; the job runs `validateMemoryWrite` on it before upsert). */
  content: string;
}

/** The typed output of one INJECTED build() call: zero-or-more directional candidates. */
export type RelationshipBuildOutput = RelationshipCandidate[];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The offline directional relationship builder system prompt. The model
 * receives a small set of HIGH-TRUST, multi-party source memories from ONE channel
 * (the builder has already excluded `external`-trust sources — the model never sees
 * them). Each source line is SENDER-PREFIXED `- [userId]: content` so the
 * model can attribute who said/believes WHAT about WHOM and emit DIRECTIONAL edges.
 *
 * It explicitly does NOT choose a trust level (the job sets trust in CODE at the
 * source ceiling) and emits ONLY directional edges that carry both endpoints — a
 * parser drops anything else, and the job's `validateMemoryWrite` is the redaction
 * firewall on every candidate.
 */
export const RELATIONSHIP_PROMPT = `You are modeling DIRECTIONAL relationships between participants in a group conversation from a small set of trusted memories.

Each memory line is prefixed with the SPEAKER who produced it, like "- [user_123]: ...". Identify durable, high-signal DIRECTIONAL relationships: who (the subject) said or believes something about WHOM (the about) — for example, that one participant trusts, manages, dislikes, collaborates with, or reports to another.

A relationship is DIRECTIONAL: "user_a trusts user_b" is DISTINCT from "user_b trusts user_a". Emit ONE edge per directional fact; never collapse or symmetrize them.

Return ONLY valid JSON: an ARRAY of objects of the form
[ { "subjectUserId": "...", "aboutUserId": "...", "content": "..." }, ... ]

- "subjectUserId": the speaker/holder of the belief (the user id from the line prefix).
- "aboutUserId": the OTHER participant the relationship concerns (a user id).
- "content": the durable directional relationship, stated once, concisely. Omit transient, low-signal, or speculative claims.

Emit ONLY edges that have BOTH a subjectUserId and an aboutUserId. Do NOT include a trust level. Do NOT mark anything as superseded or deleted.
Return [] if the memories establish no durable directional relationship. No markdown fences, no commentary.`;

/**
 * Build the builder system prompt for one source-memory set. The source text is
 * appended so the daemon's seam can keep this prompt assembly agent-internal — it
 * imports this helper rather than embedding the prompt string itself. Counts-only
 * callers never log the returned text (it embeds source content).
 */
export function buildRelationshipPrompt(sourceText: string): string {
  return `${RELATIONSHIP_PROMPT}\n\nThe trusted memories:\n${sourceText}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * LENIENT per-candidate schema. `z.object` (NOT `strictObject`) so any smuggled
 * `trust`/`trustLevel` field is STRIPPED, not rejected: a valid candidate is never
 * discarded over an extra field, and a smuggled trust value (even a forbidden
 * `external`) is dropped before it can reach the store. Both directional endpoints
 * are REQUIRED non-empty strings — a candidate missing `subjectUserId` or
 * `aboutUserId` fails the per-item parse, dropping THAT candidate (the rest survive).
 */
const CandidateSchema = z.object({
  subjectUserId: z.string().min(1),
  aboutUserId: z.string().min(1),
  content: z.string().min(1),
});

/**
 * Parse raw build()-seam text into a {@link RelationshipBuildOutput}.
 *
 * TOTAL function — NEVER throws (the non-fatal contract at the parse boundary): a
 * malformed/adversarial payload returns `[]` so the job continues. Steps: strip
 * fences → `JSON.parse` inside try/catch (parse error → `[]`) → require a
 * top-level ARRAY (a bare object / null / scalar → `[]`) → per element
 * `safeParse` against the lenient schema, KEEPING only the successes (a smuggled
 * `trust` stripped; an endpoint-less or empty-content candidate dropped). The
 * returned candidates carry ONLY `{ subjectUserId, aboutUserId, content }` — never
 * `trust`.
 */
export function parseRelationshipOutput(raw: string): RelationshipBuildOutput {
  const json: unknown = parseLenientJson(raw);
  // parseLenientJson tolerates narration around the payload (live finding
  // 2026-06-11 — the whole-string parse degraded valid payloads).
  if (json === undefined) return [];
  if (!Array.isArray(json)) return [];

  const out: RelationshipBuildOutput = [];
  for (const element of json) {
    const parsed = CandidateSchema.safeParse(element);
    if (!parsed.success) continue;
    // Reconstruct from the parsed fields ONLY — z.object strips unknown keys, but
    // building the object explicitly makes the "no trust" guarantee structural.
    out.push({
      subjectUserId: parsed.data.subjectUserId,
      aboutUserId: parsed.data.aboutUserId,
      content: parsed.data.content,
    });
  }
  return out;
}

