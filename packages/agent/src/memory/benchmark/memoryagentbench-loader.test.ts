// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure MemoryAgentBench loader.
 *
 * TIER: default CI / fast unit tier (no model, no dataset download, no store).
 * Runs over the tiny vendored neutral-placeholder fixture in __fixtures__/.
 *
 * MemoryAgentBench (arXiv 2507.05257, MIT) has four ability splits —
 * accurate-retrieval, test-time-learning, long-range, conflict-resolution. The
 * loader emits `{ docs, questions[], abilityType }`; each question carries
 * `abilityType` as its `category` so the existing aggregateAccuracy harness
 * scores per-ability (the Conflict-Resolution split being the headline).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadMemoryAgentBench,
  loadMemoryAgentBenchDataset,
  type MemoryAgentBenchAbility,
} from "./memoryagentbench-loader.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(
  readFileSync(join(fixtureDir, "__fixtures__", "memoryagentbench-sample.json"), "utf8"),
) as unknown;

/** Build a minimal valid MemoryAgentBench item for a given ability. */
function item(ability: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ability,
    documents: ["neutral placeholder doc one", "neutral placeholder doc two"],
    questions: [
      { question_id: "q1", question: "placeholder question one?", answer: "a1" },
      { question_id: "q2", question: "placeholder question two?", answer: "a2" },
    ],
    ...extra,
  };
}

describe("loadMemoryAgentBench (conflict-resolution: the headline split)", () => {
  it("parses the vendored conflict-resolution fixture into docs + questions + abilityType", () => {
    const parsed = loadMemoryAgentBench(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.abilityType).toBe("conflict-resolution");
    expect(parsed.value.docs.length).toBe(2);
    expect(parsed.value.questions.length).toBe(2);
    const q = parsed.value.questions[0];
    expect(q.questionId).toBe("mab_cr_1");
    expect(q.query).toBe("What is user_a's current placeholder color preference after the correction?");
    expect(q.answer).toBe("green");
    // The ability rides the question category so aggregateAccuracy scores per-ability.
    expect(q.category).toBe("conflict-resolution");
  });

  it("emits one dated doc per source document with a positive integer createdAt", () => {
    const parsed = loadMemoryAgentBench(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const doc of parsed.value.docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
      expect(typeof doc.sessionId).toBe("string");
      expect(doc.sessionId.length).toBeGreaterThan(0);
    }
    // Deterministic, strictly increasing per index (a stable synthesized date).
    expect(parsed.value.docs[0].createdAt).toBeLessThan(parsed.value.docs[1].createdAt);
  });
});

describe("loadMemoryAgentBench (all four ability splits parse)", () => {
  const abilities: MemoryAgentBenchAbility[] = [
    "accurate-retrieval",
    "test-time-learning",
    "long-range",
    "conflict-resolution",
  ];
  for (const ability of abilities) {
    it(`parses the ${ability} ability split tagging questions with abilityType`, () => {
      const parsed = loadMemoryAgentBench(item(ability));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.abilityType).toBe(ability);
      for (const q of parsed.value.questions) {
        expect(q.category).toBe(ability);
      }
    });
  }

  it("returns err on an unknown ability split (defensive — not in the closed union)", () => {
    const r = loadMemoryAgentBench(item("teleportation"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("ability");
  });

  it("returns err when ability is missing or non-string", () => {
    const noAbility = { documents: ["d"], questions: [{ question_id: "q", question: "q?" }] };
    expect(loadMemoryAgentBench(noAbility).ok).toBe(false);
    expect(loadMemoryAgentBench({ ...noAbility, ability: 42 }).ok).toBe(false);
  });
});

describe("loadMemoryAgentBench (accepts documents OR sessions for the doc array)", () => {
  it("reads the doc array from `sessions` when `documents` is absent", () => {
    const viaSessions = {
      ability: "long-range",
      sessions: ["neutral placeholder session one", "neutral placeholder session two"],
      questions: [{ question_id: "q1", question: "q?", answer: "a" }],
    };
    const parsed = loadMemoryAgentBench(viaSessions);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.docs.length).toBe(2);
  });

  it("accepts object-shaped documents (serialized to content), not just strings", () => {
    const objDocs = {
      ability: "accurate-retrieval",
      documents: [{ title: "doc a", body: "placeholder body a" }],
      questions: [{ question_id: "q1", question: "q?", answer: "a" }],
    };
    const parsed = loadMemoryAgentBench(objDocs);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.docs.length).toBe(1);
    // Content is the JSON.stringify of the source document — never eval'd.
    expect(parsed.value.docs[0].content).toContain("placeholder body a");
  });
});

describe("loadMemoryAgentBench (defensive parse of untrusted input)", () => {
  it("returns err on a non-object input (never throws)", () => {
    expect(loadMemoryAgentBench(null).ok).toBe(false);
    expect(loadMemoryAgentBench("nope").ok).toBe(false);
    expect(loadMemoryAgentBench(42).ok).toBe(false);
  });

  it("returns err when the documents/sessions array is missing", () => {
    const noDocs = {
      ability: "accurate-retrieval",
      questions: [{ question_id: "q1", question: "q?" }],
    };
    expect(loadMemoryAgentBench(noDocs).ok).toBe(false);
  });

  it("returns err when documents is not an array", () => {
    expect(loadMemoryAgentBench(item("long-range", { documents: "not-an-array" })).ok).toBe(false);
  });

  it("returns err when questions is missing or not an array", () => {
    const noQ = { ability: "long-range", documents: ["d"] };
    expect(loadMemoryAgentBench(noQ).ok).toBe(false);
    expect(loadMemoryAgentBench({ ...noQ, questions: "nope" }).ok).toBe(false);
  });

  it("returns err when a question is missing its question text", () => {
    const badQ = item("long-range", { questions: [{ question_id: "q1", answer: "a" }] });
    expect(loadMemoryAgentBench(badQ).ok).toBe(false);
  });

  it("defaults a missing question answer to the empty string (judge parity)", () => {
    const noAnswer = item("long-range", {
      questions: [{ question_id: "q1", question: "q?" }],
    });
    const parsed = loadMemoryAgentBench(noAnswer);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.questions[0].answer).toBe("");
  });

  it("returns err when a question is not an object", () => {
    expect(loadMemoryAgentBench(item("long-range", { questions: ["bad-q"] })).ok).toBe(false);
  });
});

describe("loadMemoryAgentBench (prototype-pollution-safe; content stringified only)", () => {
  it("does not pollute Object.prototype from a hostile __proto__ key in a document", () => {
    const hostile = {
      ability: "conflict-resolution",
      documents: [{ "__proto__": { polluted: true }, body: "placeholder" }],
      questions: [{ question_id: "q1", question: "q?", answer: "a" }],
    };
    const parsed = loadMemoryAgentBench(hostile);
    expect(parsed.ok).toBe(true);
    // The document is only ever JSON.stringify'd — no write keyed by a dataset key.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("keeps a string document VERBATIM as content (already plain text, never eval'd)", () => {
    const parsed = loadMemoryAgentBench(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The fixture's documents are plain strings — kept verbatim (NOT re-quoted).
    expect(parsed.value.docs[0].content).toBe(
      "Neutral placeholder document one: user_a stated their placeholder color preference is blue.",
    );
    for (const doc of parsed.value.docs) {
      expect(typeof doc.content).toBe("string");
    }
  });

  it("JSON.stringify's a non-string (object) document into a parseable content string", () => {
    const objDoc = {
      ability: "long-range",
      documents: [{ title: "doc a", body: "placeholder body a" }],
      questions: [{ question_id: "q1", question: "q?", answer: "a" }],
    };
    const parsed = loadMemoryAgentBench(objDoc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // An object document is JSON.stringify'd — so it round-trips through JSON.parse
    // (it is JSON text, never interpreted code).
    const roundTripped = JSON.parse(parsed.value.docs[0].content) as Record<string, unknown>;
    expect(roundTripped).toEqual({ title: "doc a", body: "placeholder body a" });
  });
});

describe("loadMemoryAgentBenchDataset (full-dataset per-item iteration)", () => {
  it("parses an ARRAY of items into one parsed result per item", () => {
    const r = loadMemoryAgentBenchDataset([RAW, RAW]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });

  it("accepts a SINGLE item object as a one-element array (fixture back-compat)", () => {
    const r = loadMemoryAgentBenchDataset(RAW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(1);
  });

  it("fails fast naming the offending index when an item is malformed", () => {
    const r = loadMemoryAgentBenchDataset([RAW, { not: "valid" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("item 1");
  });
});
