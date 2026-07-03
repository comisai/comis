// SPDX-License-Identifier: Apache-2.0
/**
 * Pure personalization + faithfulness dataset loaders (the on-mission tier):
 * PrefEval, PerLTQA, PersonaMem, HaluMem.
 *
 * These four loaders cover the personalization / preference-following and the
 * memory-faithfulness / hallucination axes of the benchmark suite. Each is a
 * pure, defensive parser in the discipline of the sibling `locomo-loader.ts` /
 * `longmemeval-loader.ts`: it returns `Result<…, Error>` (NEVER throws), reads
 * every field of the UNTRUSTED dataset JSON defensively (type-guards before
 * access), and emits the harness ingest shape — dated documents on one channel
 * and the question/qa list (carrying the gold the judge grades against) on a
 * SEPARATE channel. The gold (answers, and HaluMem's hallucination labels) is
 * NEVER serialized into document content (the anti-leak invariant).
 *
 * Documented external formats (full schema is operator-verified):
 *   - PrefEval (ICLR 2025 Oral; amazon-science/PrefEval): preference-adherence
 *     triplets `{ preference, query, gold }` -> `{ items: { preference, query,
 *     answer }[] }`. The on-mission preference-following lane (uncontested).
 *   - PerLTQA (Elvin-Yiming-Du/PerLTQA): personal episodic+semantic QA
 *     `{ profile, qa[] }` -> a dated profile document + `qa[]`. Chinese-origin;
 *     the loader is LANGUAGE-AGNOSTIC — the content string carries whatever
 *     encoding the source uses (a non-ASCII bio round-trips unharmed through
 *     JSON.stringify; the fixture proves this).
 *   - PersonaMem / -v2 (bowen-upenn/PersonaMem): evolving persona
 *     `{ persona_sessions[], probes[] }` -> dated session documents + probe
 *     questions (the late-session value the persona EVOLVED to is the gold).
 *   - HaluMem (MemTensor/HaluMem; CC-BY-NC-ND + COI caveats): memory
 *     hallucination at extract/update/QA `{ memory_ops[], qa[],
 *     hallucination_labels }` -> `{ docs, qa, hallucinationLabels }` with the
 *     hallucination labels on a SEPARATE gold channel (never doc content).
 *
 * The full corpora are OPERATOR-PLACED under `$COMIS_BENCH_DATA` (documented in
 * DATASETS.md) and are NEVER committed — only the tiny
 * neutral-placeholder fixtures in `__fixtures__/{prefeval,perltqa,personamem,
 * halumem}-sample.json` ship with the repo (licensing + leak hygiene).
 *
 * PURE parsers. Import ONLY @comis/shared (Result) + Node stdlib types. The
 * agent->memory architecture cut (architecture-graph.test.ts) FORBIDS any import
 * of the memory package here — the gated harness is the only file that may import
 * the memory adapter. Mirrors the discipline of longmemeval-loader.ts /
 * locomo-loader.ts.
 *
 * SECURITY (ASVS V5): every field is read defensively and a structural mismatch
 * returns `err`, never throws. Outputs are built with LITERAL keys only
 * and dataset-keyed maps use `Map`/literal writes, so an attacker-shaped
 * `__proto__`/`constructor` key cannot pollute `Object.prototype`.
 * Content is only ever `JSON.stringify`'d into an opaque `content` string, NEVER
 * `eval`/`Function` (AGENTS.md §2.2). The synthesized-date and the
 * (reused) PersonaMem date parser are anchored/bounded -> ReDoS-safe.
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";

// --------------------------------------------------------------------------
// Shared, self-contained helpers (re-declared locally; the loaders are
// intentionally self-contained — the locomo/longmemeval precedent).
// --------------------------------------------------------------------------

/** Narrow an unknown to a non-null object (defensive parse helper). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Fixed epoch base for SYNTHESIZED per-index `createdAt` values (2024-01-01Z).
 * Several of these formats carry no per-document timestamp; the loaders date such
 * documents deterministically so the document ordering is stable and monotonic.
 * This is loader metadata, NOT a claim about the real document date — it mirrors
 * the MemoryAgentBench loader's synthesized-date discipline.
 */
const SYNTH_EPOCH_BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
/** One hour per index — keeps synthesized dates strictly increasing. */
const SYNTH_EPOCH_STEP_MS = 3_600_000;

/** Synthesize a deterministic, strictly-increasing per-index epoch-ms. */
function synthCreatedAt(index: number): number {
  return SYNTH_EPOCH_BASE_MS + index * SYNTH_EPOCH_STEP_MS;
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
 * Parse the LongMemEval-family `"YYYY/MM/DD (Day) HH:MM"` date form to epoch ms
 * (PersonaMem session dates use this form).
 *
 * Anchored, bounded regex (`^...$`, fixed-width classes, no nested quantifiers)
 * -> linear-time, no ReDoS. Builds the epoch with `Date.UTC(...)` (a
 * static-method call, NOT a flagged global). Returns `err` (no throw) when the
 * regex does not match OR a component is out of range: `Date.UTC` silently ROLLS
 * OVER out-of-range-but-numeric components, so every component is range-checked
 * BEFORE `Date.UTC`, and the day is validated against the actual month length
 * (leap-aware) so impossible calendar days (Feb 30) are rejected.
 */
function parseHaystackDate(raw: string): Result<number, Error> {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/.exec(raw);
  if (match === null) {
    return err(new Error("unparseable persona date"));
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
    return err(new Error("unparseable persona date"));
  }
  const epoch = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(epoch)) {
    return err(new Error("unparseable persona date"));
  }
  return ok(epoch);
}

/** One ingestable dated document (uniform with the other loaders' doc shape). */
export interface PersonalizationDoc {
  /** A literal-keyed session id (never a raw dataset key used to index a write). */
  sessionId: string;
  /** `JSON.stringify` of the source content. NEVER contains the gold. */
  content: string;
  /** Positive epoch-ms createdAt (parsed-from-source or synthesized, deterministic). */
  createdAt: number;
}

/**
 * One question with the judge channels. `query` carries the question text under
 * the SAME field name as every other loader (LongMemEval/LoCoMo) so the harness
 * reads `q.query` uniformly; `answer` (the gold) + `category` ride HERE only,
 * never in `docs[].content` (the anti-leak invariant).
 */
export interface PersonalizationQa {
  questionId: string;
  query: string;
  answer: string;
  category: string;
}

// --------------------------------------------------------------------------
// PrefEval — preference-adherence triplets.
// --------------------------------------------------------------------------

/** One PrefEval preference-adherence item (preference + query + gold answer). */
export interface PrefEvalItem {
  /** The user preference the answer must adhere to. */
  preference: string;
  /** The question/instruction text (uniform `query` field). */
  query: string;
  /** The PrefEval `gold` mapped to `answer` (the judge channel; "" when absent). */
  answer: string;
}

/** Parsed PrefEval output: the preference-adherence items. */
export interface PrefEvalParsed {
  items: PrefEvalItem[];
}

/**
 * Parse PrefEval preference-adherence triplets into `{ items: { preference,
 * query, answer }[] }`.
 *
 * Accepts the documented shapes: an `{ items: [...] }` wrapper, a bare ARRAY of
 * triplets (the public file), or a SINGLE triplet object (the vendored fixture).
 * Each triplet must carry a non-empty `preference` and `query`; `gold` maps to
 * `answer` and defaults to "" (judge parity). Fail-fast: a malformed item returns
 * `err` NAMING its index. TOTAL over untrusted input (never throws).
 *
 * PrefEval is a preference-following eval, NOT a corpus-ingest eval — it emits no
 * documents (there is no haystack to retrieve from; the preference + query are the
 * whole probe), so only the items channel is returned.
 */
export function loadPrefEval(raw: unknown): Result<PrefEvalParsed, Error> {
  // Unwrap `{ items: [...] }`, accept a bare array, or wrap a single object.
  let triplets: unknown[];
  if (isObject(raw) && Array.isArray(raw.items)) {
    triplets = raw.items;
  } else if (Array.isArray(raw)) {
    triplets = raw;
  } else if (isObject(raw)) {
    triplets = [raw];
  } else {
    return err(new Error("PrefEval input must be an object, an array, or an items wrapper"));
  }

  const items: PrefEvalItem[] = [];
  for (let i = 0; i < triplets.length; i++) {
    const t = triplets[i];
    if (!isObject(t)) {
      return err(new Error(`PrefEval item ${i} must be an object`));
    }
    const preference = t.preference;
    if (typeof preference !== "string" || preference.length === 0) {
      return err(new Error(`PrefEval item ${i} missing preference`));
    }
    const query = t.query;
    if (typeof query !== "string" || query.length === 0) {
      return err(new Error(`PrefEval item ${i} missing query`));
    }
    const answer = typeof t.gold === "string" ? t.gold : "";
    items.push({ preference, query, answer });
  }

  return ok({ items });
}

// --------------------------------------------------------------------------
// PerLTQA — personal episodic+semantic QA.
// --------------------------------------------------------------------------

/** Parsed PerLTQA output: the dated profile document(s) + the personal qa list. */
export interface PerLtqaParsed {
  docs: PersonalizationDoc[];
  qa: PersonalizationQa[];
}

/**
 * Parse a PerLTQA `{ profile, qa[] }` sample into a dated profile document + the
 * personal qa list.
 *
 * The `profile` (episodic+semantic personal context) becomes ONE dated document
 * (`content = JSON.stringify(profile)`, dated by a synthesized epoch since the
 * source carries no profile timestamp). The `qa[]` carries the gold on its own
 * channel; an absent/non-string answer defaults to "", and a per-item
 * `question_id` is reused if present else synthesized (`perltqa:<i>`). A missing
 * `qa` array, or a qa item without question text, is a structural mismatch -> `err`.
 *
 * LANGUAGE-AGNOSTIC: the profile + question text are carried through the content /
 * query strings verbatim (JSON.stringify preserves any encoding), so a
 * Chinese-origin sample round-trips unharmed.
 *
 * The `profile` is read VERBATIM into `JSON.stringify` — a hostile `__proto__`
 * key inside it becomes serialized text only and never indexes a write, so it
 * cannot pollute the prototype.
 */
export function loadPerLtqa(raw: unknown): Result<PerLtqaParsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("PerLTQA sample must be an object"));
  }
  const qaRaw = raw.qa;
  if (!Array.isArray(qaRaw)) {
    return err(new Error("PerLTQA sample missing qa array"));
  }

  // The profile is OPTIONAL context; when present it becomes one dated doc.
  const docs: PersonalizationDoc[] = [];
  if (raw.profile !== undefined) {
    docs.push({
      sessionId: "perltqa_profile",
      content: JSON.stringify(raw.profile),
      createdAt: synthCreatedAt(0),
    });
  }

  const qa: PersonalizationQa[] = [];
  for (let i = 0; i < qaRaw.length; i++) {
    const item = qaRaw[i];
    if (!isObject(item)) {
      return err(new Error(`PerLTQA qa item ${i} must be an object`));
    }
    const query = item.question;
    if (typeof query !== "string" || query.length === 0) {
      return err(new Error(`PerLTQA qa item ${i} missing question text`));
    }
    const questionId =
      typeof item.question_id === "string" && item.question_id.length > 0
        ? item.question_id
        : `perltqa:${i}`;
    const answer = typeof item.answer === "string" ? item.answer : "";
    qa.push({ questionId, query, answer, category: "perltqa" });
  }

  return ok({ docs, qa });
}

// --------------------------------------------------------------------------
// PersonaMem — evolving persona.
// --------------------------------------------------------------------------

/** Parsed PersonaMem output: the dated session documents + the probe questions. */
export interface PersonaMemParsed {
  docs: PersonalizationDoc[];
  qa: PersonalizationQa[];
}

/**
 * Parse a PersonaMem `{ persona_sessions[], probes[] }` sample into dated session
 * documents + probe questions.
 *
 * Each `persona_sessions[i]` becomes one dated document: `content =
 * JSON.stringify(session.turns)` (the gold lives on the probe channel, never in
 * the turns), dated from `session.date` (the `"YYYY/MM/DD (Day) HH:MM"` form) when
 * present, else a synthesized strictly-increasing epoch. A literal-keyed
 * `pm_doc_<i>` session id is used (the dataset `session_id` is recorded into the
 * content only, never used to index a write). Each `probes[i]` becomes a question
 * (the value the persona EVOLVED to is the gold). A missing `persona_sessions` or
 * `probes` array, or a probe without question text, is a structural mismatch ->
 * `err`. TOTAL over untrusted input (never throws).
 */
export function loadPersonaMem(raw: unknown): Result<PersonaMemParsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("PersonaMem sample must be an object"));
  }
  const sessionsRaw = raw.persona_sessions;
  if (!Array.isArray(sessionsRaw)) {
    return err(new Error("PersonaMem sample missing persona_sessions array"));
  }
  const probesRaw = raw.probes;
  if (!Array.isArray(probesRaw)) {
    return err(new Error("PersonaMem sample missing probes array"));
  }

  const docs: PersonalizationDoc[] = [];
  for (let i = 0; i < sessionsRaw.length; i++) {
    const session = sessionsRaw[i];
    if (!isObject(session)) {
      return err(new Error(`PersonaMem session ${i} must be an object`));
    }
    // Date from the source when present; else a synthesized strictly-increasing
    // epoch (deterministic, so the session ordering is stable).
    let createdAt: number;
    if (typeof session.date === "string") {
      const dateResult = parseHaystackDate(session.date);
      if (!dateResult.ok) {
        return dateResult;
      }
      createdAt = dateResult.value;
    } else {
      createdAt = synthCreatedAt(i);
    }
    // Ingest ONLY the turns (the gold lives on the probe channel). The turns are
    // serialized verbatim; a hostile key inside them is serialized text only.
    docs.push({
      sessionId: `pm_doc_${i}`,
      content: JSON.stringify(session.turns ?? []),
      createdAt,
    });
  }

  const qa: PersonalizationQa[] = [];
  for (let i = 0; i < probesRaw.length; i++) {
    const probe = probesRaw[i];
    if (!isObject(probe)) {
      return err(new Error(`PersonaMem probe ${i} must be an object`));
    }
    const query = probe.question;
    if (typeof query !== "string" || query.length === 0) {
      return err(new Error(`PersonaMem probe ${i} missing question text`));
    }
    const questionId =
      typeof probe.probe_id === "string" && probe.probe_id.length > 0
        ? probe.probe_id
        : `personamem:${i}`;
    const answer = typeof probe.answer === "string" ? probe.answer : "";
    qa.push({ questionId, query, answer, category: "personamem" });
  }

  return ok({ docs, qa });
}

// --------------------------------------------------------------------------
// HaluMem — memory hallucination at extract/update/QA.
// --------------------------------------------------------------------------

/** Parsed HaluMem output: docs + qa + the hallucination labels on a SEPARATE gold channel. */
export interface HaluMemParsed {
  docs: PersonalizationDoc[];
  qa: PersonalizationQa[];
  /**
   * questionId -> whether the answer is a hallucination (the faithfulness gold).
   * Rides a SEPARATE channel — NEVER in `docs[].content` (the anti-leak
   * invariant). A `Map` (not a plain object), so an untrusted question id cannot
   * pollute the prototype.
   */
  hallucinationLabels: Map<string, boolean>;
}

/**
 * Parse a HaluMem `{ memory_ops[], qa[], hallucination_labels }` sample into
 * `{ docs, qa, hallucinationLabels }`.
 *
 * Each `memory_ops[i]` (an extract/update memory operation) becomes one dated
 * document: `content = JSON.stringify(op)`, dated by a synthesized
 * strictly-increasing epoch (the source carries no per-op timestamp). The `qa[]`
 * carries the question text + gold answer; a missing answer defaults to "", a
 * missing question text is `err`. The `hallucination_labels` (the faithfulness
 * gold) are folded into a `Map<questionId, boolean>` on a SEPARATE channel and are
 * NEVER serialized into document content. An ABSENT `hallucination_labels` block
 * yields an empty map (the labels are optional gold, not a structural
 * requirement). TOTAL over untrusted input (never throws).
 */
export function loadHaluMem(raw: unknown): Result<HaluMemParsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("HaluMem sample must be an object"));
  }
  const qaRaw = raw.qa;
  if (!Array.isArray(qaRaw)) {
    return err(new Error("HaluMem sample missing qa array"));
  }

  // Memory ops -> dated documents (the gold/labels are NEVER ingested here).
  const opsRaw = Array.isArray(raw.memory_ops) ? raw.memory_ops : [];
  const docs: PersonalizationDoc[] = [];
  for (let i = 0; i < opsRaw.length; i++) {
    docs.push({
      sessionId: `halumem_op_${i}`,
      content: JSON.stringify(opsRaw[i]),
      createdAt: synthCreatedAt(i),
    });
  }

  const qa: PersonalizationQa[] = [];
  for (let i = 0; i < qaRaw.length; i++) {
    const item = qaRaw[i];
    if (!isObject(item)) {
      return err(new Error(`HaluMem qa item ${i} must be an object`));
    }
    const query = item.question;
    if (typeof query !== "string" || query.length === 0) {
      return err(new Error(`HaluMem qa item ${i} missing question text`));
    }
    const questionId =
      typeof item.question_id === "string" && item.question_id.length > 0
        ? item.question_id
        : `halumem:${i}`;
    const answer = typeof item.answer === "string" ? item.answer : "";
    qa.push({ questionId, query, answer, category: "halumem" });
  }

  // Hallucination labels -> a Map keyed by questionId (the separate gold channel).
  // A Map write by an untrusted key is prototype-safe; absent labels -> empty map.
  const hallucinationLabels = new Map<string, boolean>();
  if (Array.isArray(raw.hallucination_labels)) {
    for (const label of raw.hallucination_labels) {
      if (!isObject(label)) {
        continue;
      }
      const qid = label.question_id;
      if (typeof qid !== "string" || qid.length === 0) {
        continue;
      }
      hallucinationLabels.set(qid, label.hallucinated === true);
    }
  }

  return ok({ docs, qa, hallucinationLabels });
}
