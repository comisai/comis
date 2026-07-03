// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure LongMemEval-V2 loader (the academic-core
 * headline loader).
 *
 * TIER: default CI / fast unit tier (no model, no dataset download, no store).
 * Runs over the tiny vendored neutral-placeholder fixture in __fixtures__/.
 *
 * Mirrors longmemeval-loader.test.ts: LongMemEval-V2 is the same
 * `haystack_sessions` family as v1, so the loader is a near-copy with a v2
 * module-doc. The eval-integrity control: no emitted document's
 * stringified `content` may contain the substring "has_answer" — the fixture
 * carries `has_answer: true` on one turn so a naive `JSON.stringify(session)`
 * would leak it and fail this test pre-strip.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadLongMemEvalV2,
  loadLongMemEvalV2Dataset,
  stripHasAnswer,
  parseHaystackDate,
} from "./longmemeval-v2-loader.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(
  readFileSync(join(fixtureDir, "__fixtures__", "longmemeval-v2-sample.json"), "utf8"),
) as unknown;

describe("loadLongMemEvalV2Dataset (full-dataset per-item iteration)", () => {
  it("parses an ARRAY of items into one parsed result per item", () => {
    const r = loadLongMemEvalV2Dataset([RAW, RAW]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });
  it("accepts a SINGLE item object as a one-element array (fixture back-compat)", () => {
    const r = loadLongMemEvalV2Dataset(RAW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(1);
  });
  it("fails fast naming the offending index when an item is malformed", () => {
    const r = loadLongMemEvalV2Dataset([RAW, { not: "a valid item" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("item 1");
  });
});

describe("loadLongMemEvalV2 (eval-integrity: no has_answer leakage)", () => {
  it("emits documents whose content never contains the substring has_answer", () => {
    const parsed = loadLongMemEvalV2(RAW);
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
});

describe("loadLongMemEvalV2 (one dated document per haystack session)", () => {
  it("emits one doc per session with a positive epoch-ms createdAt and the session id", () => {
    const parsed = loadLongMemEvalV2(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { docs } = parsed.value;
    expect(docs.length).toBe(2);
    expect(docs[0].sessionId).toBe("session_v2_0001");
    expect(docs[1].sessionId).toBe("session_v2_0002");
    for (const doc of docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
      // The harness keys on sessionId and resolves gold via
      // answerSessionIdsByQuestion / questions[]; no per-doc questionId.
      expect("questionId" in doc).toBe(false);
    }
    // session 1 (earlier date) < session 2 (later date)
    expect(docs[0].createdAt).toBeLessThan(docs[1].createdAt);
  });

  it("records the question text under `query` (uniform with v1/LoCoMo)", () => {
    const parsed = loadLongMemEvalV2(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.questions.length).toBe(1);
    const q = parsed.value.questions[0];
    expect(q.questionId).toBe("q2_example_1");
    expect(typeof q.query).toBe("string");
    expect(q.query.length).toBeGreaterThan(0);
  });
});

describe("loadLongMemEvalV2 (judge category + gold answer side-channel)", () => {
  it("emits the judge category from question_type on questions[]", () => {
    const parsed = loadLongMemEvalV2(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.questions[0].category).toBe("multi-session");
  });

  it("emits the gold answer from top-level raw.answer on questions[]", () => {
    const parsed = loadLongMemEvalV2(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.questions[0].answer).toBe("placeholder topic beta");
  });

  it("falls back to the literal \"unknown\" when question_type is absent/non-string", () => {
    const base = {
      question_id: "q1",
      question: "q",
      haystack_sessions: [[{ role: "user", content: "hi" }]],
      haystack_session_ids: ["s1"],
      haystack_dates: ["2023/05/20 (Sat) 02:21"],
      answer_session_ids: ["s1"],
    };
    const noType = loadLongMemEvalV2(base);
    expect(noType.ok).toBe(true);
    if (!noType.ok) return;
    expect(noType.value.questions[0].category).toBe("unknown");
    const badType = loadLongMemEvalV2({ ...base, question_type: 42 });
    expect(badType.ok).toBe(true);
    if (!badType.ok) return;
    expect(badType.value.questions[0].category).toBe("unknown");
    expect(noType.value.questions[0].answer).toBe("");
  });

  it("ANTI-LEAK: category/answer are NOT spliced into docs[].content", () => {
    const parsed = loadLongMemEvalV2(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const category = parsed.value.questions[0].category;
    const rawObj = RAW as { haystack_sessions: Array<Array<Record<string, unknown>>> };
    parsed.value.docs.forEach((doc, i) => {
      const expected = JSON.stringify(stripHasAnswer(rawObj.haystack_sessions[i]));
      expect(doc.content).toBe(expected);
      expect(doc.content).not.toContain("has_answer");
      expect(doc.content).not.toContain(`"category"`);
      expect(doc.content).not.toContain(category);
    });
  });
});

describe("loadLongMemEvalV2 (prototype-pollution-safe over hostile haystack keys)", () => {
  it("does not pollute Object.prototype from a __proto__ session id", () => {
    // A hostile haystack_session_ids carrying __proto__ must not mutate the
    // prototype: the loader builds outputs with literal keys only and never
    // indexes a write by a raw dataset key.
    const hostile = {
      question_id: "q1",
      question: "q",
      haystack_sessions: [[{ role: "user", content: "hi" }]],
      haystack_session_ids: ["__proto__"],
      haystack_dates: ["2023/05/20 (Sat) 02:21"],
      answer_session_ids: ["__proto__"],
    };
    const parsed = loadLongMemEvalV2(hostile);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.docs[0].sessionId).toBe("__proto__");
    // No write keyed by the dataset string reached Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

describe("parseHaystackDate (YYYY/MM/DD (Day) HH:MM -> epoch ms)", () => {
  it("parses a well-formed date to a positive integer epoch-ms (UTC)", () => {
    const r = parseHaystackDate("2024/01/15 (Mon) 03:42");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(Date.UTC(2024, 0, 15, 3, 42));
  });

  it("returns err on an unparseable date (no throw)", () => {
    expect(parseHaystackDate("not a date").ok).toBe(false);
  });

  it("returns err on out-of-range components instead of rolling over", () => {
    expect(parseHaystackDate("2023/13/20 (Sat) 02:21").ok).toBe(false); // month 13
    expect(parseHaystackDate("2023/02/30 (Thu) 02:21").ok).toBe(false); // Feb 30 round-trip
  });
});

describe("loadLongMemEvalV2 (records answer session ids for gold resolution)", () => {
  it("maps questionId -> Set of answer_session_ids (session-level gold)", () => {
    const parsed = loadLongMemEvalV2(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const gold = parsed.value.answerSessionIdsByQuestion.get("q2_example_1");
    expect(gold).toBeInstanceOf(Set);
    expect(gold?.has("session_v2_0002")).toBe(true);
    expect(gold?.has("session_v2_0001")).toBe(false);
  });
});

describe("loadLongMemEvalV2 (defensive parse of untrusted input)", () => {
  const base = {
    question_id: "q1",
    question: "q",
    haystack_sessions: [[{ role: "user", content: "hi" }]],
    haystack_session_ids: ["s1"],
    haystack_dates: ["2023/05/20 (Sat) 02:21"],
    answer_session_ids: ["s1"],
  };

  it("returns err on a non-object input", () => {
    expect(loadLongMemEvalV2(null).ok).toBe(false);
    expect(loadLongMemEvalV2("nope").ok).toBe(false);
  });

  it("returns err when question_id is missing/empty", () => {
    expect(loadLongMemEvalV2({ ...base, question_id: "" }).ok).toBe(false);
  });

  it("returns err when question text is missing/empty", () => {
    expect(loadLongMemEvalV2({ ...base, question: "" }).ok).toBe(false);
  });

  it("returns err when haystack_sessions is missing", () => {
    expect(loadLongMemEvalV2({ question_id: "x" }).ok).toBe(false);
  });

  it("returns err when haystack_session_ids is not a string array", () => {
    expect(loadLongMemEvalV2({ ...base, haystack_session_ids: [1] }).ok).toBe(false);
  });

  it("returns err when haystack_dates is not a string array", () => {
    expect(loadLongMemEvalV2({ ...base, haystack_dates: [123] }).ok).toBe(false);
  });

  it("returns err on a haystack array length mismatch", () => {
    expect(loadLongMemEvalV2({ ...base, haystack_session_ids: ["s1", "s2"] }).ok).toBe(false);
  });

  it("returns err when answer_session_ids is not a string array", () => {
    expect(loadLongMemEvalV2({ ...base, answer_session_ids: "s1" }).ok).toBe(false);
  });

  it("returns err when a session date is unparseable (propagates)", () => {
    expect(loadLongMemEvalV2({ ...base, haystack_dates: ["garbage"] }).ok).toBe(false);
  });

  it("returns err when a haystack session is not an array of turns", () => {
    expect(loadLongMemEvalV2({ ...base, haystack_sessions: ["not-an-array"] }).ok).toBe(false);
  });

  it("returns err when a haystack turn is not an object", () => {
    expect(loadLongMemEvalV2({ ...base, haystack_sessions: [["bad-turn"]] }).ok).toBe(false);
  });
});
