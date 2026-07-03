// SPDX-License-Identifier: Apache-2.0
/**
 * Pure LoCoMo dataset loader (the parse half).
 *
 * Parses a LoCoMo sample's `conversation` into one dated document per session
 * (`session_N` + `session_N_date_time`), ingesting ONLY `{speaker,text,dia_id}`
 * per turn — the `qa` block (answers + evidence) is NEVER serialized into
 * document content (the gold lives outside the conversation).
 * Normalizes `qa[].evidence` `"D<sess>:<dia>"` strings to
 * SESSION-QUALIFIED gold refs (the full `"D<sess>:<dia>"`, NOT the bare dia
 * index — the prefix prevents cross-session collisions) and excludes
 * `category === 5` adversarial items from the recall-gold qa list.
 *
 * PURE parser. Imports ONLY @comis/shared (Result) + Node stdlib types. The
 * agent->memory architecture cut (architecture-graph.test.ts:133) FORBIDS any
 * import of the memory package here — the gated harness (a
 * `.test.ts`) is the only file that may import the memory adapter. Mirrors the
 * discipline of the sibling longmemeval-loader.ts.
 *
 * SECURITY (ASVS V5): the dataset JSON is UNTRUSTED external input. Every field
 * is read defensively and a structural mismatch returns `err`, never throws.
 * Conversation keys are matched against an anchored allowlist (`/^session_\d+$/`)
 * so `__proto__`/`constructor`/non-matching keys are ignored; outputs are built
 * with LITERAL keys only (no write indexed by a raw dataset key) so attacker-
 * shaped keys cannot pollute. No `eval` / `Function` — content is
 * only ever `JSON.stringify`'d, never interpreted (AGENTS.md §2.2).
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";

/** One ingestable dated document (one per LoCoMo session). */
export interface LocomoDoc {
  /** The dataset session id (`session_N`) — the gold-map side-map key. */
  sessionId: string;
  /** `JSON.stringify` of the `{speaker,text,dia_id}` turns. NEVER contains qa. */
  content: string;
  /** Session date as positive epoch-ms (the dated-document createdAt). */
  createdAt: number;
  /**
   * The SESSION-QUALIFIED dia refs (`"D<sess>:<dia>"`) contained in this session
   * — the harness keys the gold side-map on these verbatim, so they MUST match
   * the form `parseLocomoEvidence` emits for `qa[].goldDiaIds`.
   */
  diaIds: string[];
}

/** Parsed LoCoMo output: documents + the recall-gold qa list. */
export interface LocomoParsed {
  docs: LocomoDoc[];
  /**
   * Kept qa items (category-5 excluded). `questionId` is the
   * gold-map key the harness joins on (`${sample_id}:${qaIdx}`, original pre-filter index);
   * `query` (NOT `question`) carries the question text under the SAME field name
   * as LongMemEvalParsed.questions[].query so the harness reads `q.query`
   * uniformly across both datasets.
   */
  qa: Array<{ questionId: string; query: string; answer: string; goldDiaIds: string[] }>;
}

/**
 * Normalize LoCoMo `evidence` `"D<session>:<dia>"` strings to SESSION-QUALIFIED
 * gold refs.
 *
 * Keeps the FULL `"D<session>:<dia>"` ref (NOT the bare 2nd colon-segment). The
 * session prefix is load-bearing: keying the gold side-map on only the dia index
 * lets two sessions that share a dia index (or two degenerate `"D1:"`/`"D2:"`
 * entries that both reduce to an empty index) silently overwrite each other,
 * zeroing a recall lane against the WRONG document. The full ref is
 * unique by construction, and the loader's `doc.diaIds` carry the same full form,
 * so both sides of the side-map key identically.
 *
 * Pure string ops: keep entries whose dia portion (everything after the FIRST
 * colon) is non-empty — this drops the degenerate `"D1:"` (empty after the
 * colon) so it can never produce a colliding empty key. No regex -> no ReDoS
 * surface. Returns `[]` for undefined/empty evidence.
 */
export function parseLocomoEvidence(evidence: string[] | undefined): string[] {
  return (evidence ?? []).filter((e) => {
    const colon = e.indexOf(":");
    // Must contain a colon AND a non-empty dia segment after it (drops "D1:").
    return colon !== -1 && colon < e.length - 1;
  });
}

/** Anchored allowlist for conversation session keys (no ReDoS — bounded `\d+`). */
const SESSION_KEY = /^session_(\d+)$/;

/** Lowercased month-name -> 0-based month index (Date.UTC arg). */
const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

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
 * Parse the LoCoMo `session_N_date_time` form `"H:MM am|pm on D Month, YYYY"`
 * to epoch ms.
 *
 * Anchored, bounded regex (`^...$`, fixed-width/bounded classes, no nested
 * quantifiers) -> linear-time, no ReDoS. Builds the epoch with
 * `Date.UTC(...)` (a static-method call, NOT a flagged global — globals-
 * classifier.ts:228-236 flags only `Date.now` and `new Date`).
 *
 * Returns `err` (no throw) on a structural mismatch, an unknown month, or an
 * out-of-range component. `Date.UTC` silently ROLLS OVER
 * out-of-range-but-numeric components, so the `Number.isNaN` guard alone is dead
 * code for those inputs. The day is bounded (1-31) consistently with hour/minute
 * AND validated against the actual month length (leap-aware), so day 99 — or an
 * impossible calendar day like Feb 30 — is rejected rather than rolled into a
 * later month.
 */
function parseLocomoDate(raw: string): Result<number, Error> {
  const match =
    /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})$/.exec(raw);
  if (match === null) {
    return err(new Error("unparseable locomo date"));
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3];
  const day = Number(match[4]);
  const monthIdx = MONTHS[match[5].toLowerCase()];
  const year = Number(match[6]);
  if (
    monthIdx === undefined ||
    hour < 1 ||
    hour > 12 ||
    minute > 59 ||
    day < 1 ||
    day > daysInUtcMonth(year, monthIdx)
  ) {
    return err(new Error("unparseable locomo date"));
  }
  // 12-hour -> 24-hour: 12am -> 0, 12pm -> 12, else pm adds 12.
  if (meridiem === "am") {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  const epoch = Date.UTC(year, monthIdx, day, hour, minute);
  if (Number.isNaN(epoch)) {
    return err(new Error("unparseable locomo date"));
  }
  return ok(epoch);
}

/** Narrow an unknown to a non-null object (defensive parse helper). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse a LoCoMo sample into dated session documents + the recall-gold qa list.
 *
 * Defensively parses UNTRUSTED external input (ASVS V5). Iterates the
 * `conversation` object's `session_N` arrays (anchored allowlist, paired with
 * `session_N_date_time`), building each document's content from ONLY
 * `{speaker,text,dia_id}` per turn. Collects qa by iterating the ORIGINAL qa
 * array with its zero-based index `qaIdx`: skips `category === 5`, and for each
 * KEPT item sets `questionId = `${sample_id}:${qaIdx}`` (original index, so a
 * skipped category-5 item leaves a gap rather than shifting later ids — stable,
 * collision-free), `query` = the LoCoMo source `question` field
 * MAPPED to `query` (the query-field normalization; an absent/empty source question is a
 * structural mismatch -> `err`), and `goldDiaIds = parseLocomoEvidence(...)`.
 */
export function loadLocomo(raw: unknown): Result<LocomoParsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("LoCoMo sample must be an object"));
  }
  const sampleId = raw.sample_id;
  if (typeof sampleId !== "string" || sampleId.length === 0) {
    return err(new Error("LoCoMo sample missing sample_id"));
  }
  const conversation = raw.conversation;
  if (!isObject(conversation)) {
    return err(new Error("LoCoMo sample missing conversation"));
  }

  // Collect session_N keys via the anchored allowlist (prototype-pollution guard:
  // __proto__/constructor and non-matching keys are skipped), ordered by index.
  const sessionKeys = Object.keys(conversation)
    .map((key) => ({ key, match: SESSION_KEY.exec(key) }))
    .filter((x): x is { key: string; match: RegExpExecArray } => x.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  const docs: LocomoDoc[] = [];
  for (const { key } of sessionKeys) {
    const turnsRaw = conversation[key];
    if (!Array.isArray(turnsRaw)) {
      return err(new Error(`LoCoMo ${key} must be an array of turns`));
    }
    const turns = turnsRaw.filter(isObject);
    if (turns.length !== turnsRaw.length) {
      return err(new Error(`LoCoMo ${key} turn must be an object`));
    }
    const dateTimeRaw = conversation[`${key}_date_time`];
    if (typeof dateTimeRaw !== "string") {
      return err(new Error(`LoCoMo ${key} missing ${key}_date_time`));
    }
    const dateResult = parseLocomoDate(dateTimeRaw);
    if (!dateResult.ok) {
      return dateResult;
    }
    const ingestTurns = turns.map((t) => ({
      speaker: t.speaker,
      text: t.text,
      dia_id: t.dia_id,
    }));
    const diaIds = turns
      .map((t) => t.dia_id)
      .filter((d): d is string => typeof d === "string");
    docs.push({
      sessionId: key,
      content: JSON.stringify(ingestTurns),
      createdAt: dateResult.value,
      diaIds,
    });
  }

  const qaRaw = raw.qa;
  if (!Array.isArray(qaRaw)) {
    return err(new Error("LoCoMo sample missing qa array"));
  }
  const qa: LocomoParsed["qa"] = [];
  for (let qaIdx = 0; qaIdx < qaRaw.length; qaIdx++) {
    const item = qaRaw[qaIdx];
    if (!isObject(item)) {
      return err(new Error("LoCoMo qa item must be an object"));
    }
    if (item.category === 5) {
      continue; // adversarial: no real evidence — skip for recall (leaves a gap)
    }
    const query = item.question;
    if (typeof query !== "string" || query.length === 0) {
      return err(new Error("LoCoMo qa item missing question text"));
    }
    const answer = typeof item.answer === "string" ? item.answer : "";
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((e): e is string => typeof e === "string")
      : undefined;
    qa.push({
      questionId: `${sampleId}:${qaIdx}`,
      query,
      answer,
      goldDiaIds: parseLocomoEvidence(evidence),
    });
  }

  return ok({ docs, qa });
}

/**
 * Load a FULL LoCoMo dataset (full-set half). The public `locomo10.json` is
 * an ARRAY of samples; a single sample object is also accepted (back-compat with the
 * vendored single-sample fixture). Each sample is parsed by {@link loadLocomo}.
 *
 * Each sample is an INDEPENDENT conversation — the harness ingests each into its OWN
 * store. Merging samples would cross-pollinate distractors the benchmark never
 * intended (breaking comparability), so this loader only SEPARATES the samples;
 * per-sample isolation is the harness's job.
 *
 * Fail-fast: a malformed sample returns `err` NAMING its index. TOTAL over untrusted
 * input (never throws): defers every field check to the per-sample parser.
 */
export function loadLocomoDataset(raw: unknown): Result<LocomoParsed[], Error> {
  const samples = Array.isArray(raw) ? raw : [raw];
  const out: LocomoParsed[] = [];
  for (let i = 0; i < samples.length; i++) {
    const parsed = loadLocomo(samples[i]);
    if (!parsed.ok) {
      return err(new Error(`LoCoMo sample ${i}: ${parsed.error.message}`));
    }
    out.push(parsed.value);
  }
  return ok(out);
}
