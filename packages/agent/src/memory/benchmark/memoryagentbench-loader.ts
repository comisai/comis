// SPDX-License-Identifier: Apache-2.0
/**
 * Pure MemoryAgentBench dataset loader (SUITE-08 — the academic-core
 * conflict-resolution headline).
 *
 * MemoryAgentBench (arXiv 2507.05257, ICLR 2026; github.com/HUST-AI-HYZ/
 * MemoryAgentBench, MIT; UCSD/McAuley) defines FOUR memory abilities —
 * Accurate Retrieval, Test-Time Learning, Long-Range Understanding, and
 * Conflict Resolution. Each item is `{ documents/sessions[], questions[],
 * ability }`. This loader emits the harness ingest shape
 * `{ docs, questions[], abilityType }`: one dated document per source document,
 * and each question tagged with `abilityType` as its `category` so the EXISTING
 * `aggregateAccuracy` (qa-accuracy.ts) scores per-ability with no new scorer.
 * The Conflict-Resolution split is the SUITE-08 headline (it maps to Comis's
 * Track-F contradiction handling).
 *
 * The full MemoryAgentBench corpus is OPERATOR-PLACED under `$COMIS_BENCH_DATA`
 * (documented in Plan 08's DATASETS.md) and is NEVER committed — only the tiny
 * neutral-placeholder fixture in `__fixtures__/memoryagentbench-sample.json`
 * ships with the repo (licensing + leak hygiene, T-99-07-05).
 *
 * The source format carries no per-document timestamp, so the loader SYNTHESIZES
 * a deterministic, strictly-increasing per-index `createdAt` from a fixed epoch
 * base (`SYNTH_EPOCH_BASE_MS`) plus `index * SYNTH_EPOCH_STEP_MS`. This is
 * documented dataset metadata, not a real date — it only needs to be stable and
 * monotonic so the dated-document ordering matches the source document order.
 *
 * PURE parser. Imports ONLY @comis/shared (Result) + Node stdlib types. The
 * agent->memory architecture cut (architecture-graph.test.ts:133) FORBIDS any
 * import of the memory package here — the gated harness is the only file that may
 * import the memory adapter. Mirrors the discipline of longmemeval-loader.ts /
 * locomo-loader.ts.
 *
 * SECURITY (ASVS V5): the dataset JSON is UNTRUSTED external input. Every field
 * is read defensively (type-guarded before access) and a structural mismatch —
 * including an ability outside the closed union — returns `err`, never throws
 * (T-99-07). Document content is only ever `JSON.stringify`'d (or kept verbatim
 * when already a string) into an opaque `content` string, NEVER `eval`/`Function`
 * (T-99-07-04 / AGENTS.md §2.2); a hostile `__proto__` key inside a document is
 * just serialized text and never indexes a write, so it cannot pollute
 * (T-99-07-01). Gold answers ride the questions[] channel only — never doc
 * content (T-99-07-03).
 *
 * @module
 */

import { ok, err, type Result } from "@comis/shared";

/**
 * The four MemoryAgentBench ability splits (the closed union — an ability outside
 * this set is a structural mismatch and returns `err`). Conflict-Resolution is the
 * SUITE-08 headline.
 */
export type MemoryAgentBenchAbility =
  | "accurate-retrieval"
  | "test-time-learning"
  | "long-range"
  | "conflict-resolution";

/** Closed allowlist of the four abilities (membership check; no regex -> no ReDoS). */
const ABILITIES: ReadonlySet<string> = new Set<MemoryAgentBenchAbility>([
  "accurate-retrieval",
  "test-time-learning",
  "long-range",
  "conflict-resolution",
]);

/**
 * Fixed epoch base for the SYNTHESIZED per-document `createdAt` (2024-01-01T00:00Z).
 * MemoryAgentBench documents carry no timestamp; the loader dates them
 * deterministically so the document ordering is stable and monotonic. This is
 * loader metadata, NOT a claim about the real document date.
 */
const SYNTH_EPOCH_BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
/** One hour per document index — keeps synthesized dates strictly increasing. */
const SYNTH_EPOCH_STEP_MS = 3_600_000;

/** One ingestable dated document (one per MemoryAgentBench source document). */
export interface MemoryAgentBenchDoc {
  /** A synthesized per-index session id (`doc_<i>`) — literal-keyed, never a dataset key. */
  sessionId: string;
  /** `JSON.stringify` of the source document (string docs kept verbatim). NEVER the gold. */
  content: string;
  /** Synthesized positive epoch-ms createdAt (deterministic, strictly increasing per index). */
  createdAt: number;
}

/**
 * Parsed MemoryAgentBench output: documents + the ability-tagged question list +
 * the ability split.
 */
export interface MemoryAgentBenchParsed {
  docs: MemoryAgentBenchDoc[];
  /**
   * Question text under `query` (uniform with the other loaders) PLUS the judge's
   * two channels: `category` = the `abilityType` (so `aggregateAccuracy` buckets
   * per-ability) and `answer` (the gold the judge grades against). The gold rides
   * HERE only — never in `docs[].content` (the anti-leak invariant, T-99-07-03).
   */
  questions: Array<{ questionId: string; query: string; category: string; answer: string }>;
  /** The MemoryAgentBench ability split this item belongs to (the SUITE-08 headline = conflict-resolution). */
  abilityType: MemoryAgentBenchAbility;
}

/** Narrow an unknown to a non-null object (defensive parse helper). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow an unknown to a `MemoryAgentBenchAbility` (closed-union membership). */
function isAbility(value: unknown): value is MemoryAgentBenchAbility {
  return typeof value === "string" && ABILITIES.has(value);
}

/**
 * Serialize one source document to opaque `content`. A string document is kept
 * VERBATIM (it is already plain text); any other shape (object/number/array) is
 * `JSON.stringify`'d. NEVER `eval`'d / interpreted (T-99-07-04). A hostile
 * `__proto__` key inside an object document becomes serialized text only — it
 * never indexes a write, so it cannot pollute the prototype (T-99-07-01).
 */
function docContent(rawDoc: unknown): string {
  return typeof rawDoc === "string" ? rawDoc : JSON.stringify(rawDoc);
}

/**
 * Parse a MemoryAgentBench item into dated documents + the ability-tagged
 * question list.
 *
 * Defensively reads every field (UNTRUSTED external input, ASVS V5): the ability
 * must be one of the four closed-union splits (else `err`); the doc array is read
 * from `documents` OR `sessions` (the documented `documents/sessions[]` shape) and
 * must be an array; `questions` must be an array of `{ question, ... }` objects.
 * Each document gets a synthesized, strictly-increasing `createdAt` and a
 * literal-keyed `doc_<i>` session id. Each question is tagged with `abilityType`
 * as its `category` so the QA harness scores per-ability; a missing question
 * answer defaults to "" (judge parity), a missing/empty question text is `err`.
 */
export function loadMemoryAgentBench(raw: unknown): Result<MemoryAgentBenchParsed, Error> {
  if (!isObject(raw)) {
    return err(new Error("MemoryAgentBench item must be an object"));
  }
  const ability = raw.ability;
  if (!isAbility(ability)) {
    return err(
      new Error(
        "MemoryAgentBench item missing a valid ability (one of accurate-retrieval, test-time-learning, long-range, conflict-resolution)",
      ),
    );
  }
  // Doc array from `documents` OR `sessions` (the documented documents/sessions[]).
  const docArrayRaw = raw.documents ?? raw.sessions;
  if (!Array.isArray(docArrayRaw)) {
    return err(new Error("MemoryAgentBench item missing documents/sessions array"));
  }
  const questionsRaw = raw.questions;
  if (!Array.isArray(questionsRaw)) {
    return err(new Error("MemoryAgentBench item missing questions array"));
  }

  const docs: MemoryAgentBenchDoc[] = [];
  for (let i = 0; i < docArrayRaw.length; i++) {
    docs.push({
      sessionId: `doc_${i}`,
      content: docContent(docArrayRaw[i]),
      createdAt: SYNTH_EPOCH_BASE_MS + i * SYNTH_EPOCH_STEP_MS,
    });
  }

  const questions: MemoryAgentBenchParsed["questions"] = [];
  for (let i = 0; i < questionsRaw.length; i++) {
    const q = questionsRaw[i];
    if (!isObject(q)) {
      return err(new Error("MemoryAgentBench question must be an object"));
    }
    const query = q.question;
    if (typeof query !== "string" || query.length === 0) {
      return err(new Error("MemoryAgentBench question missing question text"));
    }
    // Question id: prefer the dataset's, else synthesize a stable per-index id.
    const questionId =
      typeof q.question_id === "string" && q.question_id.length > 0
        ? q.question_id
        : `${ability}:${i}`;
    const answer = typeof q.answer === "string" ? q.answer : "";
    questions.push({ questionId, query, category: ability, answer });
  }

  return ok({ docs, questions, abilityType: ability });
}

/**
 * Load a FULL MemoryAgentBench dataset (SUITE-08, full-set half). The
 * operator-placed file is an ARRAY of items; a single item object is also
 * accepted (back-compat with the vendored single-item fixture). Each item is
 * parsed by {@link loadMemoryAgentBench}.
 *
 * Each item is an INDEPENDENT `(documents, questions)` set — the harness ingests
 * each into its OWN store. Fail-fast: a malformed item returns `err` NAMING its
 * index (an operator fixes the data rather than silently benchmarking on a
 * subset). TOTAL over untrusted input (never throws): defers every field check to
 * the per-item parser.
 */
export function loadMemoryAgentBenchDataset(
  raw: unknown,
): Result<MemoryAgentBenchParsed[], Error> {
  const items = Array.isArray(raw) ? raw : [raw];
  const out: MemoryAgentBenchParsed[] = [];
  for (let i = 0; i < items.length; i++) {
    const parsed = loadMemoryAgentBench(items[i]);
    if (!parsed.ok) {
      return err(new Error(`MemoryAgentBench item ${i}: ${parsed.error.message}`));
    }
    out.push(parsed.value);
  }
  return ok(out);
}
