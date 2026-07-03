// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure LongMemEval loader.
 *
 * TIER: default CI / fast unit tier (no model, no dataset download, no store).
 * Runs over the tiny vendored neutral-placeholder fixture in __fixtures__/.
 *
 * The eval-integrity control (Test 1):
 * no emitted document's stringified `content` may contain the substring
 * "has_answer" — the fixture carries `has_answer: true` on one turn so a naive
 * `JSON.stringify(session)` would leak it and fail this test pre-strip.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadLongMemEval,
  loadLongMemEvalDataset,
  stripHasAnswer,
  parseHaystackDate,
} from "./longmemeval-loader.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(
  readFileSync(join(fixtureDir, "__fixtures__", "longmemeval-sample.json"), "utf8"),
) as unknown;

describe("loadLongMemEvalDataset (full-dataset per-item iteration)", () => {
  it("parses an ARRAY of items into one parsed result per item", () => {
    const r = loadLongMemEvalDataset([RAW, RAW]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });
  it("accepts a SINGLE item object as a one-element array (fixture back-compat)", () => {
    const r = loadLongMemEvalDataset(RAW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(1);
  });
  it("fails fast naming the offending index when an item is malformed", () => {
    const r = loadLongMemEvalDataset([RAW, { not: "a valid item" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("item 1");
  });
});

describe("loadLongMemEval (eval-integrity: no has_answer leakage)", () => {
  it("emits documents whose content never contains the substring has_answer", () => {
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.docs.length).toBeGreaterThan(0);
    for (const doc of parsed.value.docs) {
      expect(doc.content).not.toContain("has_answer");
    }
  });
});

describe("stripHasAnswer (drops has_answer and any non-{role,content} key)", () => {
  it("returns exactly { role, content } for a turn carrying has_answer", () => {
    const out = stripHasAnswer([{ role: "user", content: "hi", has_answer: true }]);
    expect(out).toEqual([{ role: "user", content: "hi" }]);
    expect(Object.keys(out[0])).toEqual(["role", "content"]);
  });

  it("drops arbitrary extra label keys, keeping only role + content", () => {
    const out = stripHasAnswer([
      { role: "assistant", content: "x", has_answer: false, foo: 1, bar: "y" },
    ]);
    expect(out).toEqual([{ role: "assistant", content: "x" }]);
  });
});

describe("loadLongMemEval (one dated document per haystack session)", () => {
  it("emits one doc per session with a positive epoch-ms createdAt and the session id", () => {
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { docs } = parsed.value;
    expect(docs.length).toBe(2);
    expect(docs[0].sessionId).toBe("session_0001");
    expect(docs[1].sessionId).toBe("session_0002");
    for (const doc of docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
      // The doc carries no per-doc questionId (the harness keys on sessionId and
      // resolves gold via answerSessionIdsByQuestion / questions[]), so the
      // contract is not overstated.
      expect("questionId" in doc).toBe(false);
    }
    // session 1 (earlier date) < session 2 (later date)
    expect(docs[0].createdAt).toBeLessThan(docs[1].createdAt);
  });

  it("records the question text under `query` (uniform with LoCoMo)", () => {
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.questions.length).toBe(1);
    const q = parsed.value.questions[0];
    expect(q.questionId).toBe("q_example_1");
    expect(typeof q.query).toBe("string");
    expect(q.query.length).toBeGreaterThan(0);
  });
});

describe("loadLongMemEval (judge category + gold answer side-channel)", () => {
  it("emits the judge category from question_type on questions[]", () => {
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The fixture carries `question_type: "single-session-user"` (:4) — the
    // judge selects its per-category rubric from this, so the loader must read
    // raw.question_type and surface it as `category` (dropping it would silently
    // route every question to the default rubric).
    expect(parsed.value.questions[0].category).toBe("single-session-user");
  });

  it("emits the gold answer from top-level raw.answer on questions[]", () => {
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The fixture carries `answer: "placeholder topic alpha"` (:6) — the judge
    // grades the model answer against this gold, so the loader must surface it.
    expect(parsed.value.questions[0].answer).toBe("placeholder topic alpha");
  });

  it("falls back to the literal \"unknown\" when question_type is absent/non-string (total over untrusted input)", () => {
    const base = {
      question_id: "q1",
      question: "q",
      haystack_sessions: [[{ role: "user", content: "hi" }]],
      haystack_session_ids: ["s1"],
      haystack_dates: ["2023/05/20 (Sat) 02:21"],
      answer_session_ids: ["s1"],
    };
    // No question_type field at all.
    const noType = loadLongMemEval(base);
    expect(noType.ok).toBe(true);
    if (!noType.ok) return;
    expect(noType.value.questions[0].category).toBe("unknown");
    // A non-string question_type (hostile shape) also falls back, never throws.
    const badType = loadLongMemEval({ ...base, question_type: 42 });
    expect(badType.ok).toBe(true);
    if (!badType.ok) return;
    expect(badType.value.questions[0].category).toBe("unknown");
    // A missing top-level answer falls back to the empty string (locomo parity).
    expect(noType.value.questions[0].answer).toBe("");
  });

  it("ANTI-LEAK: category/answer are NOT spliced into docs[].content", () => {
    // The invariant is that the `category`/`answer` side-channels stay on
    // the questions[] channel and are NEVER concatenated into doc.content —
    // content must remain byte-identical to JSON.stringify(stripHasAnswer(turns)).
    // (Note: the gold-answer PHRASE legitimately occurs inside the haystack
    // conversation — that is the benchmark working as designed, the answer is
    // recallable from the haystack — so a naive "gold substring absent from
    // content" check is wrong. The real guard is "no side-channel injection".)
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const goldAnswer = parsed.value.questions[0].answer;
    const category = parsed.value.questions[0].category;
    expect(goldAnswer.length).toBeGreaterThan(0);
    // Reconstruct the expected content directly from the fixture turns and assert
    // each doc.content matches exactly — proving neither `answer` nor `category`
    // (nor the dropped `has_answer` flag) was folded in.
    const rawObj = RAW as { haystack_sessions: Array<Array<Record<string, unknown>>> };
    parsed.value.docs.forEach((doc, i) => {
      const expected = JSON.stringify(stripHasAnswer(rawObj.haystack_sessions[i]));
      expect(doc.content).toBe(expected);
      expect(doc.content).not.toContain("has_answer");
      expect(doc.content).not.toContain(`"category"`);
      // The category token "single-session-user" is loader metadata, never content.
      expect(doc.content).not.toContain(category);
    });
  });
});

describe("parseHaystackDate (YYYY/MM/DD (Day) HH:MM -> epoch ms)", () => {
  it("parses a well-formed date to a positive integer epoch-ms (UTC)", () => {
    const r = parseHaystackDate("2023/05/20 (Sat) 02:21");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number.isInteger(r.value)).toBe(true);
    expect(r.value).toBe(Date.UTC(2023, 4, 20, 2, 21));
  });

  it("returns err on an unparseable date (no throw)", () => {
    const r = parseHaystackDate("not a date");
    expect(r.ok).toBe(false);
  });

  it("returns err on a structurally-close but invalid date", () => {
    const r = parseHaystackDate("2023-05-20 02:21");
    expect(r.ok).toBe(false);
  });

  it("returns err on out-of-range components instead of rolling over", () => {
    // Date.UTC silently rolls over out-of-range-but-numeric components
    // (month 13 -> next year, day 45, hour 99). The regex's \d{2} classes accept
    // them, so the parser MUST range-check and return err rather than emit a
    // plausible-but-wrong epoch. The Number.isNaN guard never fires for these.
    expect(parseHaystackDate("2023/13/45 (XXX) 99:99").ok).toBe(false); // every field OOR
    expect(parseHaystackDate("2023/13/20 (Sat) 02:21").ok).toBe(false); // month 13
    expect(parseHaystackDate("2023/05/99 (Sat) 02:21").ok).toBe(false); // day 99
    expect(parseHaystackDate("2023/05/20 (Sat) 24:00").ok).toBe(false); // hour 24
    expect(parseHaystackDate("2023/05/20 (Sat) 02:60").ok).toBe(false); // minute 60
    expect(parseHaystackDate("2023/00/20 (Sat) 02:21").ok).toBe(false); // month 00
    expect(parseHaystackDate("2023/05/00 (Sat) 02:21").ok).toBe(false); // day 00
  });

  it("returns err on a day that rolls over within a valid month (round-trip)", () => {
    // Feb 30 is numerically in-range (day 1-31) but rolls into March — the
    // round-trip guard must reject it.
    expect(parseHaystackDate("2023/02/30 (Thu) 02:21").ok).toBe(false);
  });
});

describe("loadLongMemEval (records answer session ids for gold resolution)", () => {
  it("maps questionId -> Set of answer_session_ids (A2 session-level gold)", () => {
    const parsed = loadLongMemEval(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const gold = parsed.value.answerSessionIdsByQuestion.get("q_example_1");
    expect(gold).toBeInstanceOf(Set);
    expect(gold?.has("session_0002")).toBe(true);
    expect(gold?.has("session_0001")).toBe(false);
  });
});

describe("loadLongMemEval (defensive parse of untrusted input)", () => {
  it("returns err on a non-object input", () => {
    expect(loadLongMemEval(null).ok).toBe(false);
    expect(loadLongMemEval("nope").ok).toBe(false);
  });

  it("returns err when haystack_sessions is missing", () => {
    expect(loadLongMemEval({ question_id: "x" }).ok).toBe(false);
  });

  it("returns err when a session date is unparseable (propagates)", () => {
    const bad = {
      question_id: "q1",
      question: "q",
      haystack_sessions: [[{ role: "user", content: "hi" }]],
      haystack_session_ids: ["s1"],
      haystack_dates: ["garbage"],
      answer_session_ids: [],
    };
    expect(loadLongMemEval(bad).ok).toBe(false);
  });

  const base = {
    question_id: "q1",
    question: "q",
    haystack_sessions: [[{ role: "user", content: "hi" }]],
    haystack_session_ids: ["s1"],
    haystack_dates: ["2023/05/20 (Sat) 02:21"],
    answer_session_ids: ["s1"],
  };

  it("returns err when question_id is empty", () => {
    expect(loadLongMemEval({ ...base, question_id: "" }).ok).toBe(false);
  });

  it("returns err when question text is missing/empty", () => {
    expect(loadLongMemEval({ ...base, question: "" }).ok).toBe(false);
  });

  it("returns err when haystack_session_ids is not a string array", () => {
    expect(loadLongMemEval({ ...base, haystack_session_ids: [1] }).ok).toBe(false);
  });

  it("returns err when haystack_dates is not a string array", () => {
    expect(loadLongMemEval({ ...base, haystack_dates: [123] }).ok).toBe(false);
  });

  it("returns err on a haystack array length mismatch", () => {
    expect(
      loadLongMemEval({ ...base, haystack_session_ids: ["s1", "s2"] }).ok,
    ).toBe(false);
  });

  it("returns err when answer_session_ids is not a string array", () => {
    expect(loadLongMemEval({ ...base, answer_session_ids: "s1" }).ok).toBe(false);
  });

  it("returns err when a haystack session is not an array of turns", () => {
    expect(loadLongMemEval({ ...base, haystack_sessions: ["not-an-array"] }).ok).toBe(false);
  });

  it("returns err when a haystack turn is not an object", () => {
    expect(loadLongMemEval({ ...base, haystack_sessions: [["bad-turn"]] }).ok).toBe(false);
  });
});
