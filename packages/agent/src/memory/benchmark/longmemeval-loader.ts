// SPDX-License-Identifier: Apache-2.0
/**
 * Pure LongMemEval dataset loader (BENCH-01, the parse half).
 *
 * Parses a LongMemEval question item (one `haystack_sessions[i]` -> one dated
 * document) and STRIPS the per-turn `has_answer` eval-leak flag before emitting
 * any document content. Records `answer_session_ids` per question so the
 * gold-map builder (gold-map.ts) can resolve session-level gold (Assumption A2).
 *
 * PURE parser. Imports ONLY @comis/shared (Result) + Node stdlib types. The
 * agent->memory architecture cut (architecture-graph.test.ts:133) FORBIDS any
 * import of the memory package here — the gated harness (Plan 88-03, a
 * `.test.ts`) is the only file that may import the memory adapter. This file
 * mirrors the discipline of recall-eval.ts:14-18.
 *
 * SECURITY (ASVS V5): the dataset JSON is UNTRUSTED external input. Every field
 * is read defensively (type-guarded before access) and a structural mismatch
 * returns `err`, never throws. Outputs are built with LITERAL keys only
 * (`stripHasAnswer` never indexes by a dataset-supplied key for write) so an
 * attacker-shaped `__proto__`/`constructor` key cannot pollute. No `eval` /
 * `Function` — dataset content is only ever `JSON.stringify`'d into an opaque
 * `content` string, never interpreted (AGENTS.md §2.2).
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";

/** One ingestable dated document (one per haystack session). */
export interface LongMemEvalDoc {
  /** The question this session belongs to (carried for the harness to map). */
  questionId: string;
  /** The dataset session id (the gold-map side-map key, never a MemoryEntry.id). */
  sessionId: string;
  /** `JSON.stringify` of the has_answer-stripped turns. NEVER contains has_answer. */
  content: string;
  /** Session date as positive epoch-ms (the dated-document createdAt). */
  createdAt: number;
}

/** Parsed LongMemEval output: documents + question text + session-level gold. */
export interface LongMemEvalParsed {
  docs: LongMemEvalDoc[];
  /**
   * Question text under `query` (uniform with LocomoParsed.qa[].query) so the
   * harness reads `q.query` across BOTH datasets.
   */
  questions: Array<{ questionId: string; query: string }>;
  /** questionId -> set of dataset answer_session_ids (session-level gold, A2). */
  answerSessionIdsByQuestion: Map<string, Set<string>>;
}

/**
 * Drop `has_answer` (and any other non-`{role,content}` label key) from each
 * turn before serialize. NEVER serialize `has_answer` (Pitfall 1 / T-88-01-01).
 *
 * Builds each output with LITERAL keys only — a dataset-supplied key is never
 * used to index a write, so `__proto__`/`constructor` cannot pollute.
 */
export function stripHasAnswer(
  turns: Array<Record<string, unknown>>,
): Array<{ role: unknown; content: unknown }> {
  return turns.map((t) => ({ role: t.role, content: t.content }));
}

/**
 * Days in a given 0-based month for a given year (Gregorian, leap-aware). Pure
 * arithmetic — no `Date` instance, so it stays clear of the `new Date` / `Date.now`
 * globals ban (globals-classifier.ts:228-236) while still rejecting impossible
 * calendar days (Feb 30, Apr 31) that `Date.UTC` would silently roll over.
 */
function daysInUtcMonth(year: number, monthIdx: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[monthIdx];
}

/**
 * Parse the LongMemEval `"YYYY/MM/DD (Day) HH:MM"` date form to epoch ms.
 *
 * Anchored, bounded regex (`^...$`, fixed-width classes, no nested quantifiers)
 * -> linear-time, no ReDoS (T-88-01-04). Builds the epoch with `Date.UTC(...)`
 * (a static-method call, NOT a flagged global — the globals classifier flags
 * only `Date.now` among `Date.*` and `new Date(...)` as a NewExpression, neither
 * of which this uses; globals-classifier.ts:228-236).
 *
 * Returns `err` (no throw) when the regex does not match OR a component is out
 * of range (WR-01). The `\d{2}` classes accept 00-99, and `Date.UTC` silently
 * ROLLS OVER out-of-range-but-numeric components (month 13 -> next year, day 99,
 * hour 99) — so the `Number.isNaN` guard alone is dead code for these inputs.
 * Every component is range-checked BEFORE `Date.UTC`, and the day is validated
 * against the actual month length (leap-aware) so impossible calendar days
 * (Feb 30) are rejected rather than rolled into the next month.
 */
export function parseHaystackDate(raw: string): Result<number, Error> {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(raw);
  if (match === null) {
    return err(new Error("unparseable haystack date"));
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInUtcMonth(year, month - 1) ||
    hour > 23 ||
    minute > 59
  ) {
    return err(new Error("unparseable haystack date"));
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(epoch)) {
    return err(new Error("unparseable haystack date"));
  }
  return ok(epoch);
}

/** Narrow an unknown to a non-null object (defensive parse helper). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow an unknown to a string[] (defensive parse helper). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Parse a LongMemEval question item into dated documents + session-level gold.
 *
 * Defensively reads every field (UNTRUSTED external input, ASVS V5): guards
 * array/string types before access and returns `err` on a structural mismatch.
 * For each haystack session: `content = JSON.stringify(stripHasAnswer(session))`
 * (has_answer dropped), `createdAt` from `parseHaystackDate` (an unparseable
 * date short-circuits to `err`), `sessionId = haystack_session_ids[i]`.
 */
export function loadLongMemEval(raw: unknown): Result<LongMemEvalParsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("LongMemEval item must be an object"));
  }
  const questionId = raw.question_id;
  if (typeof questionId !== "string" || questionId.length === 0) {
    return err(new Error("LongMemEval item missing question_id"));
  }
  const query = raw.question;
  if (typeof query !== "string" || query.length === 0) {
    return err(new Error("LongMemEval item missing question text"));
  }
  const sessions = raw.haystack_sessions;
  if (!Array.isArray(sessions)) {
    return err(new Error("LongMemEval item missing haystack_sessions"));
  }
  const sessionIds = raw.haystack_session_ids;
  if (!isStringArray(sessionIds)) {
    return err(new Error("LongMemEval item missing haystack_session_ids"));
  }
  const dates = raw.haystack_dates;
  if (!isStringArray(dates)) {
    return err(new Error("LongMemEval item missing haystack_dates"));
  }
  if (sessions.length !== sessionIds.length || sessions.length !== dates.length) {
    return err(new Error("LongMemEval haystack arrays length mismatch"));
  }
  const answerSessionIds = raw.answer_session_ids;
  if (!isStringArray(answerSessionIds)) {
    return err(new Error("LongMemEval item missing answer_session_ids"));
  }

  const docs: LongMemEvalDoc[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    if (!Array.isArray(session)) {
      return err(new Error("LongMemEval haystack session must be an array of turns"));
    }
    const turns = session.filter(isObject);
    if (turns.length !== session.length) {
      return err(new Error("LongMemEval haystack turn must be an object"));
    }
    const dateResult = parseHaystackDate(dates[i]);
    if (!dateResult.ok) {
      return dateResult;
    }
    docs.push({
      questionId,
      sessionId: sessionIds[i],
      content: JSON.stringify(stripHasAnswer(turns)),
      createdAt: dateResult.value,
    });
  }

  const answerSessionIdsByQuestion = new Map<string, Set<string>>();
  answerSessionIdsByQuestion.set(questionId, new Set(answerSessionIds));

  return ok({
    docs,
    questions: [{ questionId, query }],
    answerSessionIdsByQuestion,
  });
}
