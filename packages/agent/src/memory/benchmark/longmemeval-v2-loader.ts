// SPDX-License-Identifier: Apache-2.0
/**
 * Pure LongMemEval-V2 dataset loader (the academic-core HEADLINE loader).
 *
 * LongMemEval-V2 (HuggingFace `LongMemEval`, the v2 / `_s` split; upstream
 * github.com/xiaowu0162/LongMemEval) shares the v1 fixture family — each
 * `haystack_sessions[i]` -> one dated document, keyed by
 * `haystack_session_ids[i]`, dated by `haystack_dates[i]` in the
 * `"YYYY/MM/DD (Day) HH:MM"` form. This loader is therefore a near-copy of the
 * sibling `longmemeval-loader.ts` (v1) with a v2 module-doc: the documented v2
 * schema is byte-identical to v1, so the parse + date + anti-leak discipline is
 * reused verbatim. The small helpers (`isObject`/`isStringArray`/
 * `parseHaystackDate`/`stripHasAnswer`/`daysInUtcMonth`) are re-declared LOCALLY
 * rather than cross-imported — the loaders are intentionally self-contained (the
 * locomo/longmemeval precedent), so a v2 schema drift can be type-guarded here
 * without coupling the two files.
 *
 * The full LongMemEval-V2 corpus is OPERATOR-PLACED under `$COMIS_BENCH_DATA`
 * (documented in DATASETS.md) and is NEVER committed — only the tiny
 * neutral-placeholder fixture in `__fixtures__/longmemeval-v2-sample.json` ships
 * with the repo (licensing + leak hygiene).
 *
 * Like v1, it STRIPS the per-turn `has_answer` eval-leak flag before emitting any
 * document content, and records `answer_session_ids` per question so the
 * gold-map builder can resolve session-level gold.
 *
 * PURE parser. Imports ONLY @comis/shared (Result) + Node stdlib types. The
 * agent->memory architecture cut (architecture-graph.test.ts:133) FORBIDS any
 * import of the memory package here — the gated harness is the only file that may
 * import the memory adapter. Mirrors the discipline of longmemeval-loader.ts.
 *
 * SECURITY (ASVS V5): the dataset JSON is UNTRUSTED external input. Every field
 * is read defensively (type-guarded before access) and a structural mismatch
 * returns `err`, never throws. Outputs are built with LITERAL keys only
 * (`stripHasAnswer` never indexes a write by a dataset-supplied key) so an
 * attacker-shaped `__proto__`/`constructor` session id cannot pollute. No `eval`
 * / `Function` — dataset content is only ever `JSON.stringify`'d into an opaque
 * `content` string, never interpreted (AGENTS.md §2.2). The anchored, bounded
 * date regex is ReDoS-safe.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";

/**
 * One ingestable dated document (one per haystack session).
 *
 * No per-doc `questionId` — the harness keys the gold side-map on `sessionId`
 * and resolves question-level gold through `LongMemEvalV2Parsed`'s separate
 * `questions[]` / `answerSessionIdsByQuestion` channel, so a per-doc question id
 * would be dead weight that overstates the contract.
 */
export interface LongMemEvalV2Doc {
  /** The dataset session id (the gold-map side-map key, never a MemoryEntry.id). */
  sessionId: string;
  /** `JSON.stringify` of the has_answer-stripped turns. NEVER contains has_answer. */
  content: string;
  /** Session date as positive epoch-ms (the dated-document createdAt). */
  createdAt: number;
}

/** Parsed LongMemEval-V2 output: documents + question text + session-level gold. */
export interface LongMemEvalV2Parsed {
  docs: LongMemEvalV2Doc[];
  /**
   * Question text under `query` (uniform with v1 / LocomoParsed.qa[].query) so
   * the harness reads `q.query` across ALL datasets, PLUS the judge's two
   * separate channels: `category` (the LongMemEval `question_type`, used to
   * select the per-category judge rubric) and `answer` (the gold answer the
   * judge grades against). Both ride HERE on the question-list channel ONLY —
   * never in `docs[].content` (the anti-leak invariant): the gold is
   * read directly by the judge and is never ingested into the store.
   */
  questions: Array<{ questionId: string; query: string; category: string; answer: string }>;
  /** questionId -> set of dataset answer_session_ids (session-level gold). */
  answerSessionIdsByQuestion: Map<string, Set<string>>;
}

/**
 * Drop `has_answer` (and any other non-`{role,content}` label key) from each
 * turn before serialize. NEVER serialize `has_answer` (the anti-leak
 * invariant).
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
 * globals ban while still rejecting impossible calendar days (Feb 30, Apr 31)
 * that `Date.UTC` would silently roll over.
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
 * -> linear-time, no ReDoS. Builds the epoch with `Date.UTC(...)`
 * (a static-method call, NOT a flagged global). Returns `err` (no throw) when the
 * regex does not match OR a component is out of range: `Date.UTC` silently ROLLS
 * OVER out-of-range-but-numeric components, so every component is range-checked
 * BEFORE `Date.UTC`, and the day is validated against the actual month length
 * (leap-aware) so impossible calendar days (Feb 30) are rejected.
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
 * Parse a LongMemEval-V2 question item into dated documents + session-level gold.
 *
 * Defensively reads every field (UNTRUSTED external input, ASVS V5): guards
 * array/string types before access and returns `err` on a structural mismatch.
 * For each haystack session: `content = JSON.stringify(stripHasAnswer(session))`
 * (has_answer dropped), `createdAt` from `parseHaystackDate` (an unparseable date
 * short-circuits to `err`), `sessionId = haystack_session_ids[i]`. The judge
 * channels (`category` from `question_type` with an "unknown" fallback; `answer`
 * from top-level `raw.answer`) ride the questions[] channel only.
 */
export function loadLongMemEvalV2(raw: unknown): Result<LongMemEvalV2Parsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("LongMemEval-V2 item must be an object"));
  }
  const questionId = raw.question_id;
  if (typeof questionId !== "string" || questionId.length === 0) {
    return err(new Error("LongMemEval-V2 item missing question_id"));
  }
  const query = raw.question;
  if (typeof query !== "string" || query.length === 0) {
    return err(new Error("LongMemEval-V2 item missing question text"));
  }
  // Judge channels — read defensively (the loader is TOTAL over untrusted JSON
  // and never throws on a missing/hostile field). `answer` defaults to ""
  // (v1/locomo parity); `category` (the `question_type`) gets a literal
  // "unknown" fallback so an absent/non-string field degrades to the DEFAULT
  // judge rubric. Both stay on the questions[] channel (never content).
  const answer = typeof raw.answer === "string" ? raw.answer : "";
  const category = typeof raw.question_type === "string" ? raw.question_type : "unknown";
  const sessions = raw.haystack_sessions;
  if (!Array.isArray(sessions)) {
    return err(new Error("LongMemEval-V2 item missing haystack_sessions"));
  }
  const sessionIds = raw.haystack_session_ids;
  if (!isStringArray(sessionIds)) {
    return err(new Error("LongMemEval-V2 item missing haystack_session_ids"));
  }
  const dates = raw.haystack_dates;
  if (!isStringArray(dates)) {
    return err(new Error("LongMemEval-V2 item missing haystack_dates"));
  }
  if (sessions.length !== sessionIds.length || sessions.length !== dates.length) {
    return err(new Error("LongMemEval-V2 haystack arrays length mismatch"));
  }
  const answerSessionIds = raw.answer_session_ids;
  if (!isStringArray(answerSessionIds)) {
    return err(new Error("LongMemEval-V2 item missing answer_session_ids"));
  }

  const docs: LongMemEvalV2Doc[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    if (!Array.isArray(session)) {
      return err(new Error("LongMemEval-V2 haystack session must be an array of turns"));
    }
    const turns = session.filter(isObject);
    if (turns.length !== session.length) {
      return err(new Error("LongMemEval-V2 haystack turn must be an object"));
    }
    const dateResult = parseHaystackDate(dates[i]);
    if (!dateResult.ok) {
      return dateResult;
    }
    docs.push({
      sessionId: sessionIds[i],
      content: JSON.stringify(stripHasAnswer(turns)),
      createdAt: dateResult.value,
    });
  }

  const answerSessionIdsByQuestion = new Map<string, Set<string>>();
  answerSessionIdsByQuestion.set(questionId, new Set(answerSessionIds));

  return ok({
    docs,
    questions: [{ questionId, query, category, answer }],
    answerSessionIdsByQuestion,
  });
}

/**
 * Load a FULL LongMemEval-V2 dataset (full-set half). The operator-placed
 * file is an ARRAY of question items; a single item object is also accepted
 * (back-compat with the vendored single-item fixture). Each item is parsed by
 * {@link loadLongMemEvalV2}.
 *
 * Each item is an INDEPENDENT `(haystack, question)` pair — the harness ingests
 * each into its OWN store (the standard LongMemEval protocol). Merging haystacks
 * across items would add cross-item distractor noise the benchmark never
 * intended, inflating difficulty and breaking comparability with published
 * numbers — so this loader only SEPARATES the items; per-item isolation is the
 * harness's job.
 *
 * Fail-fast: a malformed item returns `err` NAMING its index (an operator fixes
 * the data rather than silently benchmarking on a subset). TOTAL over untrusted
 * input (never throws): defers every field check to the per-item parser.
 */
export function loadLongMemEvalV2Dataset(raw: unknown): Result<LongMemEvalV2Parsed[], Error> {
  const items = Array.isArray(raw) ? raw : [raw];
  const out: LongMemEvalV2Parsed[] = [];
  for (let i = 0; i < items.length; i++) {
    const parsed = loadLongMemEvalV2(items[i]);
    if (!parsed.ok) {
      return err(new Error(`LongMemEval-V2 item ${i}: ${parsed.error.message}`));
    }
    out.push(parsed.value);
  }
  return ok(out);
}
