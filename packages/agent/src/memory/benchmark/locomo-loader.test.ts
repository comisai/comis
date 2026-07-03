// SPDX-License-Identifier: Apache-2.0
/**
 * UNGATED unit tests for the pure LoCoMo loader.
 *
 * TIER: default CI / fast unit tier (no model, no dataset download, no store).
 * Runs over the tiny vendored neutral-placeholder fixture in __fixtures__/.
 *
 * Loader-to-harness contracts proven here:
 * - questionId stability: each kept qa carries a stable `questionId = `${sample_id}:${qaIdx}``
 *   over the ORIGINAL (pre-category-5-filter) index, so a skipped item leaves a
 *   GAP rather than shifting later ids. The harness reads it verbatim.
 * - query field: each qa exposes its question text under `query` (NOT `question`),
 *   uniform with LongMemEval. The UNGATED guard asserts every kept qa has a
 *   defined, non-empty `query` (catches the undefined-query bug that would
 *   silently zero the LoCoMo recall lane).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadLocomo, loadLocomoDataset, parseLocomoEvidence } from "./locomo-loader.js";
import { buildGoldMap } from "./gold-map.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(
  readFileSync(join(fixtureDir, "__fixtures__", "locomo-sample.json"), "utf8"),
) as unknown;

describe("loadLocomoDataset (full-dataset per-sample iteration)", () => {
  it("parses an ARRAY of samples into one parsed result per sample", () => {
    const r = loadLocomoDataset([RAW, RAW]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(2);
  });
  it("accepts a SINGLE sample object as a one-element array (fixture back-compat)", () => {
    const r = loadLocomoDataset(RAW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(1);
  });
  it("fails fast naming the offending index when a sample is malformed", () => {
    const r = loadLocomoDataset([RAW, { not: "valid" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("sample 1");
  });
});

describe("parseLocomoEvidence (D<sess>:<dia> -> session-qualified ref)", () => {
  it("returns the FULL session-qualified ref for each evidence string", () => {
    // The session prefix MUST be preserved end-to-end so two sessions
    // sharing a dia index never collide. Keying on the bare 2nd segment
    // ("5","3") silently overwrites the gold side-map; the full ref is unique
    // by construction.
    expect(parseLocomoEvidence(["D1:5", "D2:3"])).toEqual(["D1:5", "D2:3"]);
  });

  it("filters out entries without a colon", () => {
    expect(parseLocomoEvidence(["malformed", "D1:7"])).toEqual(["D1:7"]);
  });

  it("drops a degenerate entry with an empty dia segment (no colliding empty key)", () => {
    // "D1:" / "D2:" parse to an empty dia segment; keyed on the bare segment
    // alone, both would become "" and collide on a single side-map key. They must
    // be dropped so they cannot collapse two sessions onto one empty key.
    expect(parseLocomoEvidence(["D1:", "D2:"])).toEqual([]);
    expect(parseLocomoEvidence(["D1:", "D1:7"])).toEqual(["D1:7"]);
  });

  it("returns [] for undefined evidence", () => {
    expect(parseLocomoEvidence(undefined)).toEqual([]);
  });
});

describe("loadLocomo (LoCoMo date-time parsing: 12-hour -> epoch ms)", () => {
  function diaAt(dateTime: string): unknown {
    return {
      sample_id: "c",
      conversation: {
        session_1_date_time: dateTime,
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
      },
      qa: [],
    };
  }
  function createdAt(dateTime: string): number {
    const parsed = loadLocomo(diaAt(dateTime));
    if (!parsed.ok) throw new Error("expected ok");
    return parsed.value.docs[0].createdAt;
  }

  it("maps 12:00 am to midnight (hour 0) UTC", () => {
    expect(createdAt("12:00 am on 8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 0, 0));
  });

  it("maps 12:30 pm to noon UTC", () => {
    expect(createdAt("12:30 pm on 8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 12, 30));
  });

  it("maps an afternoon pm time by adding 12 hours", () => {
    expect(createdAt("1:00 pm on 8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 13, 0));
  });

  it("maps a morning am time directly", () => {
    expect(createdAt("9:30 am on 9 May, 2023")).toBe(Date.UTC(2023, 4, 9, 9, 30));
  });

  it("returns err on an unknown month name", () => {
    expect(loadLocomo(diaAt("1:00 pm on 8 Smarch, 2023")).ok).toBe(false);
  });

  it("returns err on an out-of-range hour", () => {
    expect(loadLocomo(diaAt("13:00 pm on 8 May, 2023")).ok).toBe(false);
  });

  it("returns err on an out-of-range day instead of rolling over", () => {
    // Without a day range check, a day like 99 would roll into a later month
    // via Date.UTC. The day must be range-checked (1-31) like the other
    // components and return err when OOR.
    expect(loadLocomo(diaAt("1:00 pm on 99 May, 2023")).ok).toBe(false); // day 99
    expect(loadLocomo(diaAt("1:00 pm on 0 May, 2023")).ok).toBe(false); // day 0
    expect(loadLocomo(diaAt("1:00 pm on 32 May, 2023")).ok).toBe(false); // day 32
  });

  it("returns err on a day that rolls over within a valid month (round-trip)", () => {
    // Feb 30 is numerically in-range but rolls into March — the round-trip
    // guard must reject it.
    expect(loadLocomo(diaAt("1:00 pm on 30 February, 2023")).ok).toBe(false);
  });

  it("returns err on a malformed date-time string", () => {
    expect(loadLocomo(diaAt("sometime yesterday")).ok).toBe(false);
  });
});

describe("loadLocomo (category-5 adversarial items excluded from recall gold)", () => {
  it("drops the category:5 item, keeping the two real-evidence qa items", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.qa.length).toBe(2);
    // none of the kept items is the adversarial "Not mentioned" question
    for (const q of parsed.value.qa) {
      expect(q.query).not.toContain("undisclosed placeholder secret");
    }
  });
});

describe("loadLocomo (one dated document per session; qa never in content)", () => {
  it("emits one doc per session_N with positive epoch-ms createdAt", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.docs.length).toBe(2);
    for (const doc of parsed.value.docs) {
      expect(Number.isInteger(doc.createdAt)).toBe(true);
      expect(doc.createdAt).toBeGreaterThan(0);
    }
  });

  it("never serializes the qa block (answers/evidence) into document content", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const doc of parsed.value.docs) {
      expect(doc.content).not.toContain("evidence");
      expect(doc.content).not.toContain("category");
      expect(doc.content).not.toContain("Not mentioned");
    }
  });

  it("ingests only {speaker,text,dia_id} per turn", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const turns = JSON.parse(parsed.value.docs[0].content) as Array<Record<string, unknown>>;
    expect(turns[0]).toEqual({ speaker: "user_a", text: "Neutral placeholder opening line.", dia_id: "D1:1" });
    expect(Object.keys(turns[0]).sort()).toEqual(["dia_id", "speaker", "text"]);
  });
});

describe("loadLocomo (each session doc records its dia_id set)", () => {
  it("records the dia_ids contained in each session document", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const byId = new Map(parsed.value.docs.map((d) => [d.sessionId, d.diaIds]));
    expect(byId.get("session_1")).toEqual(["D1:1", "D1:2"]);
    expect(byId.get("session_2")).toEqual(["D2:3", "D2:4"]);
  });
});

describe("loadLocomo (session-qualified gold refs never collide cross-session)", () => {
  // Two sessions whose dia indices COLLIDE on the bare 2nd segment ("1" in both
  // D1:1 and D2:1). Keyed by the bare dia index alone, the side-map would overwrite
  // session_1's uuid with session_2's, silently zeroing a lane. With the full
  // session-qualified ref the two gold refs ("D1:1" vs "D2:1") are distinct and
  // resolve to DISTINCT documents. This is an UNGATED proof (no model, no store):
  // it builds the side-map exactly as the harness does (keyed by doc.diaIds) and
  // resolves the gold through buildGoldMap.
  const COLLIDING = {
    sample_id: "collide",
    conversation: {
      session_1_date_time: "1:00 pm on 8 May, 2023",
      session_1: [{ speaker: "user_a", text: "first", dia_id: "D1:1" }],
      session_2_date_time: "1:00 pm on 9 May, 2023",
      session_2: [{ speaker: "user_b", text: "second", dia_id: "D2:1" }],
    },
    qa: [
      { question: "from session one?", answer: "first", evidence: ["D1:1"], category: 1 },
      { question: "from session two?", answer: "second", evidence: ["D2:1"], category: 1 },
    ],
  };

  it("emits distinct diaIds carrying the session prefix per session", () => {
    const parsed = loadLocomo(COLLIDING);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const byId = new Map(parsed.value.docs.map((d) => [d.sessionId, d.diaIds]));
    expect(byId.get("session_1")).toEqual(["D1:1"]);
    expect(byId.get("session_2")).toEqual(["D2:1"]);
  });

  it("resolves two sessions sharing a dia index to DISTINCT gold ids", () => {
    const parsed = loadLocomo(COLLIDING);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { docs, qa } = parsed.value;

    // Build the side-map the way the harness does: one uuid per ingested doc,
    // keyed by the doc's (full) dia refs. If doc.diaIds were parsed to the bare
    // index, both docs would key "1" and the second set() would clobber the
    // first.
    const ingestedIdByRef = new Map<string, string>();
    const uuidBySession = new Map<string, string>();
    let n = 0;
    for (const doc of docs) {
      const uuid = `uuid-${n++}`;
      uuidBySession.set(doc.sessionId, uuid);
      for (const ref of doc.diaIds) ingestedIdByRef.set(ref, uuid);
    }
    // Both gold keys must survive — no empty/colliding key.
    expect(ingestedIdByRef.size).toBe(2);

    const goldRefs = new Map<string, Set<string>>();
    for (const item of qa) goldRefs.set(item.questionId, new Set(item.goldDiaIds));
    const goldMap = buildGoldMap(goldRefs, ingestedIdByRef);

    const sess1Uuid = uuidBySession.get("session_1");
    const sess2Uuid = uuidBySession.get("session_2");
    expect(sess1Uuid).not.toBe(sess2Uuid);
    // q[0] -> session_1's doc; q[1] -> session_2's doc; NOT the same id.
    expect([...(goldMap.get("collide:0") ?? [])]).toEqual([sess1Uuid]);
    expect([...(goldMap.get("collide:1") ?? [])]).toEqual([sess2Uuid]);
  });
});

describe("loadLocomo (stable questionId = `${sample_id}:${qaIdx}`)", () => {
  it("synthesizes ids over the ORIGINAL pre-filter index (gaps, no collision)", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const ids = parsed.value.qa.map((q) => q.questionId);
    // qa[0] kept -> conv1:0 ; qa[1] (category 5) skipped -> gap ; qa[2] kept -> conv1:2
    expect(ids).toEqual(["conv1:0", "conv1:2"]);
  });

  it("maps gold dia_ids onto the kept qa via parseLocomoEvidence (full session-qualified refs)", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Gold refs carry the session prefix so they key the side-map by the
    // SAME full form as doc.diaIds — `evidence: ["D1:1"]` -> `["D1:1"]`.
    const first = parsed.value.qa.find((q) => q.questionId === "conv1:0");
    expect(first?.goldDiaIds).toEqual(["D1:1"]);
    const third = parsed.value.qa.find((q) => q.questionId === "conv1:2");
    expect(third?.goldDiaIds).toEqual(["D2:3", "D1:2"]);
  });
});

describe("loadLocomo (question text under `query`, never empty)", () => {
  it("exposes question text under query (uniform with LongMemEval)", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = parsed.value.qa.find((q) => q.questionId === "conv1:0");
    expect(first?.query).toBe("What did user_a say in the opening placeholder line?");
  });

  it("every kept qa item has a defined, non-empty query (ungated guard)", () => {
    const parsed = loadLocomo(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const q of parsed.value.qa) {
      expect(typeof q.query === "string" && q.query.length > 0).toBe(true);
    }
  });
});

describe("loadLocomo (defensive parse of untrusted input)", () => {
  it("returns err on non-object input", () => {
    expect(loadLocomo(null).ok).toBe(false);
    expect(loadLocomo(42).ok).toBe(false);
  });

  it("returns err when conversation is missing", () => {
    expect(loadLocomo({ sample_id: "x", qa: [] }).ok).toBe(false);
  });

  it("returns err when a kept qa has a non-string question (structural mismatch)", () => {
    const bad = {
      sample_id: "conv2",
      conversation: {
        session_1_date_time: "1:00 pm on 8 May, 2023",
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
      },
      qa: [{ answer: "a", evidence: ["D1:1"], category: 1 }],
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("ignores non-session_N conversation keys (prototype-pollution guard)", () => {
    const withProto = {
      sample_id: "conv3",
      conversation: {
        __proto__: { polluted: true },
        speaker_a: "user_a",
        session_1_date_time: "1:00 pm on 8 May, 2023",
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
      },
      qa: [],
    };
    const parsed = loadLocomo(withProto);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.docs.length).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns err when sample_id is empty", () => {
    expect(loadLocomo({ sample_id: "", conversation: {}, qa: [] }).ok).toBe(false);
  });

  it("returns err when a session_N value is not an array", () => {
    const bad = {
      sample_id: "c",
      conversation: { session_1: "not-an-array", session_1_date_time: "1:00 pm on 8 May, 2023" },
      qa: [],
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("returns err when a session turn is not an object", () => {
    const bad = {
      sample_id: "c",
      conversation: { session_1: ["bad-turn"], session_1_date_time: "1:00 pm on 8 May, 2023" },
      qa: [],
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("returns err when session_N_date_time is missing", () => {
    const bad = {
      sample_id: "c",
      conversation: { session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }] },
      qa: [],
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("returns err when a session date-time is unparseable (propagates)", () => {
    const bad = {
      sample_id: "c",
      conversation: {
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
        session_1_date_time: "garbage",
      },
      qa: [],
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("returns err when qa is not an array", () => {
    const bad = {
      sample_id: "c",
      conversation: {
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
        session_1_date_time: "1:00 pm on 8 May, 2023",
      },
      qa: "not-an-array",
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("returns err when a qa item is not an object", () => {
    const bad = {
      sample_id: "c",
      conversation: {
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
        session_1_date_time: "1:00 pm on 8 May, 2023",
      },
      qa: ["bad-qa"],
    };
    expect(loadLocomo(bad).ok).toBe(false);
  });

  it("tolerates a kept qa with no answer + no evidence array (defaults applied)", () => {
    const ok = {
      sample_id: "c",
      conversation: {
        session_1: [{ speaker: "user_a", text: "hi", dia_id: "D1:1" }],
        session_1_date_time: "1:00 pm on 8 May, 2023",
      },
      qa: [{ question: "q?", category: 1 }],
    };
    const parsed = loadLocomo(ok);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.qa[0]).toEqual({
      questionId: "c:0",
      query: "q?",
      answer: "",
      goldDiaIds: [],
    });
  });
});
