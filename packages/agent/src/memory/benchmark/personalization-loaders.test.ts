// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure personalization + faithfulness loaders
 * (SUITE-07): PrefEval, PerLTQA, PersonaMem, HaluMem.
 *
 * TIER: default CI / fast unit tier (no model, no dataset download, no store).
 * Runs over the tiny vendored neutral-placeholder fixtures in __fixtures__/.
 *
 * Mirrors locomo-loader.test.ts's defensive-parse shape. Each loader:
 *   - parses its valid vendored fixture into the harness ingest shape,
 *   - returns `err` (never throws) on a missing required field / hostile input,
 *   - is prototype-pollution-safe (a `__proto__` key never mutates Object.prototype),
 *   - keeps gold (answers, HaluMem hallucination labels) OFF document content
 *     (the anti-leak invariant, T-99-07-03).
 *
 * PerLTQA additionally proves a non-ASCII (Chinese) placeholder round-trips
 * through the content string unharmed (the loader is language-agnostic).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadPrefEval,
  loadPerLtqa,
  loadPersonaMem,
  loadHaluMem,
} from "./personalization-loaders.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, "__fixtures__", name), "utf8")) as unknown;
}
const PREFEVAL = fixture("prefeval-sample.json");
const PERLTQA = fixture("perltqa-sample.json");
const PERSONAMEM = fixture("personamem-sample.json");
const HALUMEM = fixture("halumem-sample.json");

// --------------------------------------------------------------------------
// PrefEval
// --------------------------------------------------------------------------

describe("loadPrefEval (preference-adherence triplets -> { preference, query, answer }[])", () => {
  it("parses the vendored fixture (items wrapper) into preference/query/answer items", () => {
    const r = loadPrefEval(PREFEVAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(2);
    const first = r.value.items[0];
    expect(first.preference).toBe(
      "user_a prefers concise, bulleted placeholder answers over long prose.",
    );
    expect(first.query).toBe("Summarize the placeholder onboarding steps for user_a.");
    // The PrefEval `gold` becomes `answer` (the judge channel).
    expect(first.answer).toContain("bulleted list");
  });

  it("accepts a bare ARRAY of triplets (the public-file shape)", () => {
    const arr = [
      { preference: "p1", query: "q1?", gold: "g1" },
      { preference: "p2", query: "q2?", gold: "g2" },
    ];
    const r = loadPrefEval(arr);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(2);
    expect(r.value.items[1].answer).toBe("g2");
  });

  it("accepts a SINGLE triplet object (fixture back-compat)", () => {
    const r = loadPrefEval({ preference: "p", query: "q?", gold: "g" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(1);
  });

  it("defaults a missing gold to the empty string (judge parity)", () => {
    const r = loadPrefEval([{ preference: "p", query: "q?" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0].answer).toBe("");
  });

  it("returns err when a triplet is missing its preference", () => {
    expect(loadPrefEval([{ query: "q?", gold: "g" }]).ok).toBe(false);
  });

  it("returns err when a triplet is missing its query", () => {
    expect(loadPrefEval([{ preference: "p", gold: "g" }]).ok).toBe(false);
  });

  it("fails fast naming the offending index when an item is malformed", () => {
    const r = loadPrefEval([{ preference: "p", query: "q?", gold: "g" }, { gold: "g" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("1");
  });

  it("returns err on a non-object / hostile input (never throws)", () => {
    expect(loadPrefEval(null).ok).toBe(false);
    expect(loadPrefEval(42).ok).toBe(false);
    expect(loadPrefEval("nope").ok).toBe(false);
  });

  it("does not pollute Object.prototype from a hostile __proto__ key", () => {
    const hostile = JSON.parse('[{"preference":"p","query":"q?","gold":"g","__proto__":{"polluted":true}}]') as unknown;
    const r = loadPrefEval(hostile);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// PerLTQA
// --------------------------------------------------------------------------

describe("loadPerLtqa (personal episodic+semantic QA -> dated profile doc + qa[])", () => {
  it("parses the vendored fixture into a dated profile doc + qa list", () => {
    const r = loadPerLtqa(PERLTQA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.docs.length).toBeGreaterThanOrEqual(1);
    for (const doc of r.value.docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
      expect(typeof doc.sessionId).toBe("string");
      expect(doc.sessionId.length).toBeGreaterThan(0);
    }
    expect(r.value.qa.length).toBe(2);
    const first = r.value.qa.find((q) => q.questionId === "perltqa_1");
    expect(first?.query).toBe("What is user_a's favorite placeholder topic?");
    expect(first?.answer).toBe("topic beta");
  });

  it("round-trips a non-ASCII (Chinese) profile + question through content unharmed (language-agnostic)", () => {
    const r = loadPerLtqa(PERLTQA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The profile doc carries the non-ASCII bio verbatim through JSON.stringify.
    const profileDoc = r.value.docs[0];
    expect(profileDoc.content).toContain("占位符简介");
    expect(profileDoc.content).toContain("占位城市");
    // The non-ASCII question text survives on the qa channel.
    const second = r.value.qa.find((q) => q.questionId === "perltqa_2");
    expect(second?.query).toContain("占位城市");
    expect(second?.answer).toBe("占位城市");
  });

  it("synthesizes a stable questionId when the source omits one", () => {
    const noId = {
      profile: { name: "user_a" },
      qa: [{ question: "q?", answer: "a" }],
    };
    const r = loadPerLtqa(noId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.value.qa[0].questionId).toBe("string");
    expect(r.value.qa[0].questionId.length).toBeGreaterThan(0);
  });

  it("defaults a missing answer to the empty string (judge parity)", () => {
    const noAnswer = { profile: { name: "u" }, qa: [{ question_id: "p1", question: "q?" }] };
    const r = loadPerLtqa(noAnswer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.qa[0].answer).toBe("");
  });

  it("never serializes the qa gold (answers) into profile doc content (anti-leak)", () => {
    const r = loadPerLtqa(PERLTQA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const doc of r.value.docs) {
      expect(doc.content).not.toContain("topic beta");
    }
  });

  it("returns err when the qa array is missing", () => {
    expect(loadPerLtqa({ profile: { name: "u" } }).ok).toBe(false);
  });

  it("returns err when a qa item is missing its question text", () => {
    expect(loadPerLtqa({ profile: { name: "u" }, qa: [{ answer: "a" }] }).ok).toBe(false);
  });

  it("returns err on a non-object / hostile input (never throws)", () => {
    expect(loadPerLtqa(null).ok).toBe(false);
    expect(loadPerLtqa(42).ok).toBe(false);
  });

  it("does not pollute Object.prototype from a hostile __proto__ profile key", () => {
    const hostile = JSON.parse(
      '{"profile":{"__proto__":{"polluted":true},"name":"u"},"qa":[{"question":"q?","answer":"a"}]}',
    ) as unknown;
    const r = loadPerLtqa(hostile);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// PersonaMem
// --------------------------------------------------------------------------

describe("loadPersonaMem (evolving persona -> dated session docs + probe questions)", () => {
  it("parses the vendored fixture into dated session docs + probe questions", () => {
    const r = loadPersonaMem(PERSONAMEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.docs.length).toBe(2);
    for (const doc of r.value.docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
    }
    expect(r.value.qa.length).toBe(2);
    const first = r.value.qa.find((q) => q.questionId === "pm_probe_1");
    expect(first?.query).toBe("What is user_a's current placeholder hobby after the latest session?");
    expect(first?.answer).toBe("climbing");
  });

  it("dates session docs from the session date when present (strictly ordered)", () => {
    const r = loadPersonaMem(PERSONAMEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // pm_sess_1 (2024/02/10) precedes pm_sess_2 (2024/03/12).
    expect(r.value.docs[0].createdAt).toBeLessThan(r.value.docs[1].createdAt);
  });

  it("synthesizes a deterministic createdAt when a session omits its date", () => {
    const noDate = {
      persona_sessions: [
        { session_id: "s1", turns: [{ role: "user", content: "hi" }] },
        { session_id: "s2", turns: [{ role: "user", content: "bye" }] },
      ],
      probes: [{ probe_id: "p1", question: "q?", answer: "a" }],
    };
    const r = loadPersonaMem(noDate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.docs[0].createdAt).toBeGreaterThan(0);
    expect(r.value.docs[0].createdAt).toBeLessThan(r.value.docs[1].createdAt);
  });

  it("never serializes the probe gold (answers) into session doc content (anti-leak)", () => {
    const r = loadPersonaMem(PERSONAMEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const doc of r.value.docs) {
      expect(doc.content).not.toContain("climbing");
    }
  });

  it("returns err when persona_sessions is missing", () => {
    expect(loadPersonaMem({ probes: [] }).ok).toBe(false);
  });

  it("returns err when probes is missing", () => {
    expect(loadPersonaMem({ persona_sessions: [] }).ok).toBe(false);
  });

  it("returns err when a probe is missing its question text", () => {
    const bad = {
      persona_sessions: [{ session_id: "s1", turns: [{ role: "user", content: "hi" }] }],
      probes: [{ probe_id: "p1", answer: "a" }],
    };
    expect(loadPersonaMem(bad).ok).toBe(false);
  });

  it("returns err on a non-object / hostile input (never throws)", () => {
    expect(loadPersonaMem(null).ok).toBe(false);
    expect(loadPersonaMem(42).ok).toBe(false);
  });

  it("does not pollute Object.prototype from a hostile __proto__ key in a session", () => {
    const hostile = JSON.parse(
      '{"persona_sessions":[{"__proto__":{"polluted":true},"session_id":"s1","turns":[{"role":"user","content":"hi"}]}],"probes":[{"probe_id":"p1","question":"q?","answer":"a"}]}',
    ) as unknown;
    const r = loadPersonaMem(hostile);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// HaluMem
// --------------------------------------------------------------------------

describe("loadHaluMem (memory hallucination -> { docs, qa, hallucinationLabels } with labels off content)", () => {
  it("parses the vendored fixture into docs + qa + a SEPARATE hallucinationLabels channel", () => {
    const r = loadHaluMem(HALUMEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.docs.length).toBe(2);
    expect(r.value.qa.length).toBe(2);
    const first = r.value.qa.find((q) => q.questionId === "halumem_q1");
    expect(first?.query).toBe("What is the placeholder name of user_a's pet after the update?");
    expect(first?.answer).toBe("Mittens");
    // The hallucination labels ride their own gold channel.
    expect(r.value.hallucinationLabels.get("halumem_q1")).toBe(false);
    expect(r.value.hallucinationLabels.get("halumem_q2")).toBe(true);
  });

  it("keeps the hallucination labels OFF document content (the anti-leak invariant)", () => {
    const r = loadHaluMem(HALUMEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const doc of r.value.docs) {
      expect(doc.content).not.toContain("hallucinated");
      expect(doc.content).not.toContain("hallucination_labels");
      // The gold answers are likewise never in doc content.
      expect(doc.content).not.toContain("Mittens");
    }
  });

  it("emits one dated doc per memory op with a positive integer createdAt", () => {
    const r = loadHaluMem(HALUMEM);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const doc of r.value.docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
    }
    expect(r.value.docs[0].createdAt).toBeLessThan(r.value.docs[1].createdAt);
  });

  it("tolerates an absent hallucination_labels block (empty label map)", () => {
    const noLabels = {
      memory_ops: [{ op: "extract", content: "c" }],
      qa: [{ question_id: "h1", question: "q?", answer: "a" }],
    };
    const r = loadHaluMem(noLabels);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hallucinationLabels.size).toBe(0);
  });

  it("returns err when the qa array is missing", () => {
    expect(loadHaluMem({ memory_ops: [] }).ok).toBe(false);
  });

  it("returns err when a qa item is missing its question text", () => {
    expect(loadHaluMem({ memory_ops: [], qa: [{ answer: "a" }] }).ok).toBe(false);
  });

  it("returns err on a non-object / hostile input (never throws)", () => {
    expect(loadHaluMem(null).ok).toBe(false);
    expect(loadHaluMem(42).ok).toBe(false);
  });

  it("does not pollute Object.prototype from a hostile __proto__ key in a memory op", () => {
    const hostile = JSON.parse(
      '{"memory_ops":[{"__proto__":{"polluted":true},"op":"extract","content":"c"}],"qa":[{"question_id":"h1","question":"q?","answer":"a"}]}',
    ) as unknown;
    const r = loadHaluMem(hostile);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });
});
