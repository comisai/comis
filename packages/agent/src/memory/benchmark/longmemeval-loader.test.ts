// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure LongMemEval loader (BENCH-01).
 *
 * TIER: default CI / fast unit tier (no model, no dataset download, no store).
 * Runs over the tiny vendored neutral-placeholder fixture in __fixtures__/.
 *
 * The eval-integrity control (Test 1, the mandated RED test from Pitfall 1):
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
  stripHasAnswer,
  parseHaystackDate,
} from "./longmemeval-loader.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(
  readFileSync(join(fixtureDir, "__fixtures__", "longmemeval-sample.json"), "utf8"),
) as unknown;

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
  it("emits one doc per session with a positive epoch-ms createdAt and carried ids", () => {
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
      expect(doc.questionId).toBe("q_example_1");
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
});
