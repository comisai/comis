// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure bounded content-free drive-state journal
 * (terminal-drive-journal.ts) — DRIVE-01, CONTEXT §7.1.6 / design §4 Phase B.
 *
 * RED-first: `terminal-drive-journal.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns
 * them GREEN. (Mirrors terminal-dialog-detector.test.ts:1-26 — the "module does
 * not exist on first commit" banner.)
 *
 * The journal is a promoted drive's CROSS-WAKE MEMORY: a bounded, content-free
 * rolling record `{objective, lastClassification, lastScreenDigest, answeredPrompts[],
 * stepsTried[], elapsedMs, interactions, costUsd, truncations}` — NOT an accumulating
 * conversation. A 40h drive accumulates thousands of woken turns; if each appended to
 * a conversation, context would blow. So the journal pins three load-bearing properties:
 *
 *   - BOUNDED (I7, Pitfall 3): `answeredPrompts`/`stepsTried` are oldest-trimmed at
 *     CAP_ANSWERED/CAP_STEPS; an over-cap append drops the OLDEST and increments the
 *     run-total `truncations` breadcrumb — NEVER a silent unbounded append. The
 *     N=10_000-append test is the unbounded-growth pin (a handful of appends does NOT
 *     catch it).
 *   - CONTENT-FREE (I3): the journal stores enums/ids/counts/durations + normalized
 *     prompt/step TAGS + a (caller-supplied, already-redacted) one-line digest ONLY.
 *     A secret-shaped prompt (`sk-…`, `password=hunter2`) is stored as a normalized
 *     tag, never re-expanded into the raw value; the journal never stores raw command
 *     output beyond the one-liner the caller hands in.
 *   - TOTAL (de)serialize (the DUR-02 / Phase-165 recovery contract): `serializeJournal`
 *     → `deserializeJournal` round-trips; a malformed/partial persisted object yields a
 *     SAFE default journal and NEVER throws (mirrors `mapWaitReply`,
 *     terminal-wait-reply.ts:60-84 — never coerce a malformed array to garbage).
 *
 * `lastClassification` is the SHIPPED classifier state union (terminal-classifier.ts:75
 * `"working" | "awaiting-input" | "exited" | "stuck"`) — these tests do NOT invent a
 * new state (I8).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  emptyJournal,
  appendAnswered,
  appendStep,
  updateJournal,
  serializeJournal,
  deserializeJournal,
  CAP_ANSWERED,
  CAP_STEPS,
  type DriveJournal,
} from "./terminal-drive-journal.js";

// ---------------------------------------------------------------------------
// emptyJournal — the safe initial shape
// ---------------------------------------------------------------------------

describe("emptyJournal — the safe initial shape", () => {
  it("returns all-empty arrays, all-zero counts, a sane default classification", () => {
    const j = emptyJournal("drive: build the project");
    expect(j.objective).toBe("drive: build the project");
    expect(j.answeredPrompts).toEqual([]);
    expect(j.stepsTried).toEqual([]);
    expect(j.elapsedMs).toBe(0);
    expect(j.interactions).toBe(0);
    expect(j.costUsd).toBe(0);
    expect(j.truncations).toBe(0);
    // A sane default from the SHIPPED classifier union (I8) — "working" (a fresh drive
    // is presumed working, not awaiting/exited/stuck).
    expect(j.lastClassification).toBe("working");
    expect(j.lastScreenDigest).toBe("");
  });

  it("is content-free for the objective: a degenerate / empty objective is tolerated", () => {
    const j = emptyJournal("");
    expect(j.objective).toBe("");
    expect(j.truncations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendAnswered / appendStep — immutability + oldest-trim + breadcrumb (I7)
// ---------------------------------------------------------------------------

describe("appendAnswered — append, immutability, oldest-trim breadcrumb (I7)", () => {
  it("appends a prompt tag without mutating the input journal", () => {
    const before = emptyJournal("o");
    const after = appendAnswered(before, "prompt-tag-a");
    // Immutable: the input is untouched (returns a NEW journal).
    expect(before.answeredPrompts).toEqual([]);
    expect(after.answeredPrompts).toEqual(["prompt-tag-a"]);
    expect(after).not.toBe(before);
  });

  it("over the cap: appending CAP_ANSWERED+1 keeps length === CAP_ANSWERED, drops the OLDEST, bumps truncations", () => {
    let j = emptyJournal("o");
    for (let i = 0; i < CAP_ANSWERED + 1; i++) {
      j = appendAnswered(j, `p${i}`);
    }
    // Capped, never an accumulating list.
    expect(j.answeredPrompts.length).toBe(CAP_ANSWERED);
    // The OLDEST ("p0") was dropped; the NEWEST is retained.
    expect(j.answeredPrompts).not.toContain("p0");
    expect(j.answeredPrompts[j.answeredPrompts.length - 1]).toBe(`p${CAP_ANSWERED}`);
    // I7 breadcrumb: exactly ONE drop recorded — never a silent drop.
    expect(j.truncations).toBe(1);
  });
});

describe("appendStep — append, immutability, oldest-trim breadcrumb (I7)", () => {
  it("appends a step tag without mutating the input journal", () => {
    const before = emptyJournal("o");
    const after = appendStep(before, "step-tag-a");
    expect(before.stepsTried).toEqual([]);
    expect(after.stepsTried).toEqual(["step-tag-a"]);
    expect(after).not.toBe(before);
  });

  it("over the cap: appending CAP_STEPS+1 keeps length === CAP_STEPS, drops the OLDEST, bumps truncations", () => {
    let j = emptyJournal("o");
    for (let i = 0; i < CAP_STEPS + 1; i++) {
      j = appendStep(j, `s${i}`);
    }
    expect(j.stepsTried.length).toBe(CAP_STEPS);
    expect(j.stepsTried).not.toContain("s0");
    expect(j.stepsTried[j.stepsTried.length - 1]).toBe(`s${CAP_STEPS}`);
    expect(j.truncations).toBe(1);
  });

  it("accumulates the truncations breadcrumb across BOTH arrays (a single run-total)", () => {
    let j = emptyJournal("o");
    // Overflow answered by 1 and steps by 1 → two total drops on one run-total counter.
    for (let i = 0; i < CAP_ANSWERED + 1; i++) j = appendAnswered(j, `p${i}`);
    for (let i = 0; i < CAP_STEPS + 1; i++) j = appendStep(j, `s${i}`);
    expect(j.truncations).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The unbounded-growth pin (Pitfall 3 — N=10_000 appends).
// A handful of appends does NOT catch unbounded growth; this is the load-bearing
// DRIVE-01 property (a 40h drive's thousands of wakes stay within the cap).
// ---------------------------------------------------------------------------

describe("bounded after N=10_000 appends — the unbounded-growth pin (Pitfall 3)", () => {
  it("answeredPrompts stays within CAP_ANSWERED and truncations === appends − cap", () => {
    const N = 10_000;
    let j = emptyJournal("a 40h drive");
    for (let i = 0; i < N; i++) {
      j = appendAnswered(j, `prompt-${i}`);
    }
    expect(j.answeredPrompts.length).toBe(CAP_ANSWERED);
    expect(j.answeredPrompts.length).toBeLessThanOrEqual(CAP_ANSWERED);
    // Every drop is accounted for — never a silent unbounded append.
    expect(j.truncations).toBe(N - CAP_ANSWERED);
  });

  it("stepsTried stays within CAP_STEPS and truncations === appends − cap after N=10_000", () => {
    const N = 10_000;
    let j = emptyJournal("a 40h drive");
    for (let i = 0; i < N; i++) {
      j = appendStep(j, `step-${i}`);
    }
    expect(j.stepsTried.length).toBe(CAP_STEPS);
    expect(j.stepsTried.length).toBeLessThanOrEqual(CAP_STEPS);
    expect(j.truncations).toBe(N - CAP_STEPS);
  });

  it("the serialized journal stays bounded after N=10_000 mixed appends (no blow-up)", () => {
    const N = 10_000;
    let j = emptyJournal("a 40h drive");
    for (let i = 0; i < N; i++) {
      j = appendAnswered(j, `prompt-${i}`);
      j = appendStep(j, `step-${i}`);
    }
    // Both arrays at their cap; the serialized size is a function of the caps, not N.
    expect(j.answeredPrompts.length).toBe(CAP_ANSWERED);
    expect(j.stepsTried.length).toBe(CAP_STEPS);
    const bytes = Buffer.byteLength(serializeJournal(j), "utf8");
    // A loose, N-independent ceiling: capped arrays of short tags can never approach
    // the megabytes an unbounded 10k-entry journal would reach. (CAP_*≈64, tags short.)
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

// ---------------------------------------------------------------------------
// updateJournal — content-free field updates only
// ---------------------------------------------------------------------------

describe("updateJournal — content-free scalar field updates only", () => {
  it("patches lastClassification / lastScreenDigest / counts without mutating the input", () => {
    const before = emptyJournal("o");
    const after = updateJournal(before, {
      lastClassification: "awaiting-input",
      lastScreenDigest: "24r 80c, 3 changed, cursor@(0,23)",
      elapsedMs: 5_000,
      interactions: 2,
      costUsd: 0.01,
    });
    expect(before.lastClassification).toBe("working");
    expect(before.elapsedMs).toBe(0);
    expect(after.lastClassification).toBe("awaiting-input");
    expect(after.lastScreenDigest).toBe("24r 80c, 3 changed, cursor@(0,23)");
    expect(after.elapsedMs).toBe(5_000);
    expect(after.interactions).toBe(2);
    expect(after.costUsd).toBe(0.01);
    // The arrays + the breadcrumb are carried through untouched (a partial patch).
    expect(after.answeredPrompts).toEqual([]);
    expect(after.truncations).toBe(0);
  });

  it("an empty patch is a no-op clone (never throws, never drops fields)", () => {
    const before = appendAnswered(emptyJournal("o"), "p0");
    const after = updateJournal(before, {});
    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// serialize / deserialize — round-trip + the DUR-02 defensive recovery contract
// ---------------------------------------------------------------------------

describe("serializeJournal / deserializeJournal — round-trip", () => {
  it("round-trips an arbitrary populated journal to a deep-equal value", () => {
    let j = emptyJournal("drive: long claude run");
    j = updateJournal(j, {
      lastClassification: "stuck",
      lastScreenDigest: "24r 80c, 0 changed, cursor@(12,5)",
      elapsedMs: 123_456,
      interactions: 7,
      costUsd: 1.25,
    });
    j = appendAnswered(j, "prompt-hash-aaa");
    j = appendAnswered(j, "prompt-hash-bbb");
    j = appendStep(j, "ran:build");
    const round = deserializeJournal(serializeJournal(j));
    expect(round).toEqual(j);
  });
});

describe("deserializeJournal — the DUR-02 defensive recovery contract (NEVER throws)", () => {
  it("an empty object yields a SAFE default journal", () => {
    const j = deserializeJournal("{}");
    expect(j.objective).toBe("");
    expect(j.answeredPrompts).toEqual([]);
    expect(j.stepsTried).toEqual([]);
    expect(j.lastClassification).toBe("working");
    expect(j.truncations).toBe(0);
  });

  it("null / a non-object / invalid JSON yields a SAFE default journal, never throws", () => {
    for (const raw of ["null", "5", '"a string"', "[1,2,3]", "not json at all", ""]) {
      const j = deserializeJournal(raw);
      expect(j.answeredPrompts).toEqual([]);
      expect(j.stepsTried).toEqual([]);
      expect(j.lastClassification).toBe("working");
    }
  });

  it("a malformed answeredPrompts (a number, not an array) does NOT become garbage — it defaults to []", () => {
    // The mapWaitReply discipline: never coerce a malformed array to garbage.
    const j = deserializeJournal(JSON.stringify({ objective: "o", answeredPrompts: 5 }));
    expect(j.objective).toBe("o");
    expect(j.answeredPrompts).toEqual([]);
  });

  it("a non-array stepsTried + a non-number elapsedMs default to the safe values", () => {
    const j = deserializeJournal(
      JSON.stringify({ stepsTried: { not: "an array" }, elapsedMs: "lots", interactions: null }),
    );
    expect(j.stepsTried).toEqual([]);
    expect(j.elapsedMs).toBe(0);
    expect(j.interactions).toBe(0);
  });

  it("an unrecognized lastClassification defaults to the safe 'working' state (I8 — never an invented state)", () => {
    const j = deserializeJournal(JSON.stringify({ lastClassification: "not-a-real-state" }));
    expect(j.lastClassification).toBe("working");
  });

  it("array entries that are not strings are dropped (never coerced to '[object Object]')", () => {
    const j = deserializeJournal(
      JSON.stringify({ answeredPrompts: ["ok", 5, null, { a: 1 }, "ok2"], stepsTried: ["s", 7] }),
    );
    expect(j.answeredPrompts).toEqual(["ok", "ok2"]);
    expect(j.stepsTried).toEqual(["s"]);
  });

  it("accepts a raw object (not only a JSON string) — DUR-02 may hand a parsed value", () => {
    const j = deserializeJournal({ objective: "from-object", interactions: 3 } as unknown);
    expect(j.objective).toBe("from-object");
    expect(j.interactions).toBe(3);
  });

  it("a deserialized over-cap array is itself trimmed to the cap (a corrupted-large file can't blow the cap)", () => {
    const huge = Array.from({ length: CAP_ANSWERED + 50 }, (_, i) => `p${i}`);
    const j = deserializeJournal(JSON.stringify({ answeredPrompts: huge }));
    expect(j.answeredPrompts.length).toBe(CAP_ANSWERED);
  });
});

// ---------------------------------------------------------------------------
// Content-free (I3) — a secret-shaped tag is stored verbatim-as-a-tag, never
// re-expanded; the journal never holds raw TUI bytes beyond the caller's one-liner.
// ---------------------------------------------------------------------------

describe("content-free (I3) — the journal carries no raw secrets it was not handed", () => {
  it("stores the prompt/step TAG the caller supplies and nothing more (no re-expansion)", () => {
    // The CALLER is responsible for normalizing/redacting before handing a tag in
    // (the woken-turn driver runs scrubSecretsFromText — plan 06). The journal's
    // contract: it stores EXACTLY the tag given, never deriving/re-expanding extra raw
    // text from it. So a tag is a single short string in the array — never an object,
    // never the raw screen.
    let j = emptyJournal("o");
    j = appendAnswered(j, "answered:overwrite-confirm");
    j = appendStep(j, "ran:rm-rf");
    expect(j.answeredPrompts).toEqual(["answered:overwrite-confirm"]);
    expect(j.stepsTried).toEqual(["ran:rm-rf"]);
    // No field anywhere holds a structure that could smuggle raw bytes.
    expect(Object.keys(j).sort()).toEqual(
      [
        "answeredPrompts",
        "costUsd",
        "elapsedMs",
        "interactions",
        "lastClassification",
        "lastScreenDigest",
        "objective",
        "stepsTried",
        "truncations",
      ].sort(),
    );
  });

  it("a journal built from a secret-shaped tag stores that tag opaquely (it does not parse it back into a secret)", () => {
    // If a caller (incorrectly) handed a raw secret, the journal still treats it as an
    // opaque single string — it never STRUCTURES it into a credential field. The
    // serialized form contains exactly the one string in the array, nothing extracted.
    const secretShaped = "answered-prompt-hash"; // a normalized hash, the CORRECT input
    let j = appendAnswered(emptyJournal("o"), secretShaped);
    const raw = serializeJournal(j);
    // The serialized journal is plain JSON of the documented shape — no extra keys, no
    // nested credential object derived from the tag.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(emptyJournal("o")).sort());
    expect(parsed.answeredPrompts).toEqual([secretShaped]);
    j = deserializeJournal(raw);
    expect(j.answeredPrompts).toEqual([secretShaped]);
  });
});
