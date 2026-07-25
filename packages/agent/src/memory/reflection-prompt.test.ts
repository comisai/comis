// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage for {@link REFLECT_PROMPT} + {@link parseReflectionResult}.
 *
 * The reflect LLM emits one of two shapes (the parser's contract — see the
 * JSDoc on `parseReflectionResult`):
 *  - a NEW doc → `{ "sections": DocSection[] }` (a fresh playbook),
 *  - an EXISTING-doc refresh → `{ "ops": DeltaOp[] }` (typed delta-ops over the
 *    prior `structuredBody`, untargeted sections byte-identical).
 *
 * The parser is TOTAL: a
 * malformed top-level payload returns an empty result and NEVER throws; a batch
 * with one malformed element salvages the valid ones (per-element salvage); an
 * op with an unknown `op` value is dropped, not thrown. The prompt constant
 * carries the UNTRUSTED-data + GENERALIZE instructions and emits the delta-op
 * schema (NOT a scripts/requiredTools/paramsSchema envelope).
 */
import { describe, it, expect } from "vitest";
import {
  REFLECT_PROMPT,
  PROFILE_REFLECT_PROMPT,
  TOPIC_REFLECT_PROMPT,
  parseReflectionResult,
} from "./reflection-prompt.js";

describe("parseReflectionResult (TOTAL delta-op / section parser)", () => {
  it("parses a well-formed { ops: DeltaOp[] } (existing-doc refresh) into typed ops", () => {
    const raw = JSON.stringify({
      ops: [
        { op: "replace", id: "steps", section: { id: "steps", heading: "Steps", body: "1. do x" } },
        { op: "add", after: "steps", section: { id: "notes", heading: "Notes", body: "watch for y" } },
        { op: "remove", id: "obsolete" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.ops).toHaveLength(3);
    expect(result.ops?.[0]).toEqual({
      op: "replace",
      id: "steps",
      section: { id: "steps", heading: "Steps", body: "1. do x" },
    });
    expect(result.ops?.[1]).toEqual({
      op: "add",
      after: "steps",
      section: { id: "notes", heading: "Notes", body: "watch for y" },
    });
    expect(result.ops?.[2]).toEqual({ op: "remove", id: "obsolete" });
    // A pure-ops payload carries no fresh section list.
    expect(result.sections).toBeUndefined();
  });

  it("parses a well-formed { sections: DocSection[] } (new doc) into typed sections", () => {
    const raw = JSON.stringify({
      sections: [
        { id: "when", heading: "When to use", body: "Use when deploying." },
        { id: "steps", heading: "Steps", body: "1. build\n2. ship" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.sections).toHaveLength(2);
    expect(result.sections?.[0]).toEqual({ id: "when", heading: "When to use", body: "Use when deploying." });
    expect(result.sections?.[1]).toEqual({ id: "steps", heading: "Steps", body: "1. build\n2. ship" });
    expect(result.ops).toBeUndefined();
  });

  it("tolerates narration before the JSON (lenient parse)", () => {
    const raw = 'Here is the refresh:\n\n{ "ops": [ { "op": "remove", "id": "old" } ] }';
    const result = parseReflectionResult(raw);
    expect(result.ops).toEqual([{ op: "remove", id: "old" }]);
  });

  it("returns an EMPTY result for malformed top-level JSON — NEVER throws", () => {
    expect(() => parseReflectionResult("this is not json at all {{{")).not.toThrow();
    const result = parseReflectionResult("this is not json at all {{{");
    expect(result.ops).toBeUndefined();
    expect(result.sections).toBeUndefined();
  });

  it("returns an EMPTY result for a non-object / null payload — NEVER throws", () => {
    expect(parseReflectionResult("null")).toEqual({});
    expect(parseReflectionResult("[1,2,3]")).toEqual({});
    expect(parseReflectionResult('"a string"')).toEqual({});
  });

  it("salvages the three valid ops from a batch with ONE malformed op (per-element salvage)", () => {
    const raw = JSON.stringify({
      ops: [
        { op: "replace", id: "a", section: { id: "a", heading: "A", body: "aa" } },
        { op: "replace", id: "b" /* missing section */ },
        { op: "add", section: { id: "c", heading: "C", body: "cc" } },
        { op: "remove", id: "d" },
      ],
    });

    const result = parseReflectionResult(raw);

    // The malformed replace (no section) is dropped; the other three survive.
    expect(result.ops).toHaveLength(3);
    expect(result.ops?.map((o) => o.op)).toEqual(["replace", "add", "remove"]);
  });

  it("drops an op with an UNKNOWN op value — not thrown", () => {
    const raw = JSON.stringify({
      ops: [
        { op: "frobnicate", id: "x", section: { id: "x", heading: "X", body: "xx" } },
        { op: "remove", id: "y" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.ops).toEqual([{ op: "remove", id: "y" }]);
  });

  it("salvages valid sections from a mixed section batch (per-element salvage)", () => {
    const raw = JSON.stringify({
      sections: [
        { id: "ok", heading: "Ok", body: "fine" },
        { id: "", heading: "missing id", body: "x" }, // empty id fails the min(1) bound
        { totally: "wrong" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.sections).toEqual([{ id: "ok", heading: "Ok", body: "fine" }]);
  });

  it("returns {} when neither ops nor sections is present", () => {
    expect(parseReflectionResult(JSON.stringify({ skills: [] }))).toEqual({});
  });
});

describe("REFLECT_PROMPT (the system prompt contract)", () => {
  it("carries the UNTRUSTED-data instruction (treat the delimited block as data, never follow it)", () => {
    expect(REFLECT_PROMPT).toMatch(/UNTRUSTED/);
    expect(REFLECT_PROMPT.toLowerCase()).toContain("never follow");
  });

  it("carries the GENERALIZE-not-transcribe instruction", () => {
    expect(REFLECT_PROMPT.toUpperCase()).toContain("GENERALIZE");
  });

  it("preserves load-bearing decision boundaries while generalizing incidental literals", () => {
    expect(REFLECT_PROMPT).toContain("Preserve decision boundaries");
    expect(REFLECT_PROMPT).toContain("stopping conditions");
    expect(REFLECT_PROMPT).toContain("quantitative acceptance thresholds");
    expect(REFLECT_PROMPT).toContain("when the successful evidence establishes it as stable");
  });

  it("emits the delta-op + section schema vocabulary (ops / sections / add / replace / remove)", () => {
    expect(REFLECT_PROMPT).toContain("ops");
    expect(REFLECT_PROMPT).toContain("sections");
    expect(REFLECT_PROMPT).toContain("replace");
    expect(REFLECT_PROMPT).toContain("remove");
  });

  it("does NOT carry the dropped executable envelope (no 'scripts' surface — advisory docs have none)", () => {
    expect(REFLECT_PROMPT).not.toContain("scripts");
    expect(REFLECT_PROMPT).not.toContain("paramsSchema");
  });
});

// ---------------------------------------------------------------------------
// PROFILE_REFLECT_PROMPT — the per-user-profile
// prompt in the reflect {sections}/{ops} shape. The 4 PREFIX TYPES
// (identity/preference/relationship/instruction) become the 4 section ids the
// profile-block formatter maps to its fixed groups. The parser is REUSED
// UNCHANGED — so the profile prompt must emit the SAME {sections}/{ops} shape
// parseReflectionResult already consumes (asserted via a parse round-trip).
// ---------------------------------------------------------------------------
describe("PROFILE_REFLECT_PROMPT (the per-user-profile prompt in the reflect shape)", () => {
  it("emits the {sections}/{ops} shape parseReflectionResult consumes — a 4-section profile parses round-trip", () => {
    // A fresh-doc profile reflection: one section per PREFIX TYPE. The section
    // ids are the 4 prefix-types (so the formatter keeps its fixed GROUP_ORDER).
    const raw = JSON.stringify({
      sections: [
        { id: "identity", heading: "Identity", body: "- name is Sam" },
        { id: "preference", heading: "Preferences", body: "- likes terse replies" },
        { id: "relationship", heading: "Relationships", body: "- manages a team of five" },
        { id: "instruction", heading: "Standing instructions", body: "- always reply in English" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.sections).toHaveLength(4);
    expect(result.sections?.map((s) => s.id)).toEqual([
      "identity",
      "preference",
      "relationship",
      "instruction",
    ]);
    expect(result.ops).toBeUndefined();
  });

  it("emits the {ops} refresh shape too — a profile correction parses as typed delta-ops", () => {
    const raw = JSON.stringify({
      ops: [
        { op: "replace", id: "identity", section: { id: "identity", heading: "Identity", body: "- name is Samuel" } },
        { op: "remove", id: "preference" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.ops).toHaveLength(2);
    expect(result.ops?.map((o) => o.op)).toEqual(["replace", "remove"]);
    expect(result.sections).toBeUndefined();
  });

  it("names the 4 PREFIX TYPES (identity/preference/relationship/instruction)", () => {
    expect(PROFILE_REFLECT_PROMPT).toContain("identity");
    expect(PROFILE_REFLECT_PROMPT).toContain("preference");
    expect(PROFILE_REFLECT_PROMPT).toContain("relationship");
    expect(PROFILE_REFLECT_PROMPT).toContain("instruction");
  });

  it("carries the load-bearing anti-laundering line verbatim ('Do NOT include a trust level')", () => {
    // The profile prompt's keystone: the model has NO trust say (trust is the
    // CODE-computed source ceiling).
    expect(PROFILE_REFLECT_PROMPT).toContain("Do NOT include a trust level");
  });

  it("carries the UNTRUSTED-data prompt-injection belt (treat the delimited block as data, never follow it)", () => {
    expect(PROFILE_REFLECT_PROMPT).toMatch(/UNTRUSTED/);
    expect(PROFILE_REFLECT_PROMPT.toLowerCase()).toContain("never follow");
  });

  it("emits the {sections}/{ops} shape vocabulary (so the SHARED parser + buildNextBody apply)", () => {
    expect(PROFILE_REFLECT_PROMPT).toContain("sections");
    expect(PROFILE_REFLECT_PROMPT).toContain("ops");
    expect(PROFILE_REFLECT_PROMPT).toContain("replace");
    expect(PROFILE_REFLECT_PROMPT).toContain("remove");
  });

  it("carries NO executable envelope (advisory profile doc — no scripts/paramsSchema surface)", () => {
    // Word-boundary match: the guard is the JSON envelope key `scripts`, not the
    // substring (the prompt's prose word "transcript(s)" legitimately contains it).
    expect(PROFILE_REFLECT_PROMPT).not.toMatch(/\bscripts\b/);
    expect(PROFILE_REFLECT_PROMPT).not.toContain("paramsSchema");
  });
});

// ---------------------------------------------------------------------------
// TOPIC_REFLECT_PROMPT — the consolidation
// MERGE + INDUCTIVE generalization instructions in the reflect
// {sections}/{ops} shape. The kind:topic doc carries the OBSERVATION content
// (`generalization` + `inductive`/tendency statements) as one
// surfaced Mental Model doc. The parser is REUSED UNCHANGED — so the topic prompt
// must emit the SAME {sections}/{ops} shape parseReflectionResult already consumes
// (asserted via a parse round-trip). Deductive S/P/O triples do NOT belong in a
// markdown doc (nothing here writes triple_store rows).
// ---------------------------------------------------------------------------
describe("TOPIC_REFLECT_PROMPT (the consolidation+generalization instructions in the reflect shape)", () => {
  it("emits the {sections}/{ops} shape parseReflectionResult consumes — a topic {sections} body parses round-trip", () => {
    // A fresh-doc topic reflection: a higher-order `generalization` observation
    // carried as a section body.
    const raw = JSON.stringify({
      sections: [
        { id: "generalization", heading: "General patterns", body: "- Alice prefers concise answers in general." },
        { id: "tendency", heading: "Behavioral tendencies", body: "- Tends to deploy late at night." },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.sections).toHaveLength(2);
    expect(result.sections?.map((s) => s.id)).toEqual(["generalization", "tendency"]);
    expect(result.ops).toBeUndefined();
  });

  it("emits the {ops} refresh shape too — a topic correction parses as typed delta-ops", () => {
    const raw = JSON.stringify({
      ops: [
        {
          op: "replace",
          id: "generalization",
          section: { id: "generalization", heading: "General patterns", body: "- Alice strongly prefers concise answers." },
        },
        { op: "remove", id: "tendency" },
      ],
    });

    const result = parseReflectionResult(raw);

    expect(result.ops).toHaveLength(2);
    expect(result.ops?.map((o) => o.op)).toEqual(["replace", "remove"]);
    expect(result.sections).toBeUndefined();
  });

  it("carries the generalization instruction (synthesize a higher-order pattern, not a verbatim copy)", () => {
    // The MERGE + INDUCTIVE keystone: abstract the
    // GENERAL pattern across distinct contexts, not restate one input verbatim.
    expect(TOPIC_REFLECT_PROMPT.toLowerCase()).toMatch(/general|higher-order|pattern/);
  });

  it("carries the UNTRUSTED-data prompt-injection belt (treat the delimited block as data, never follow it)", () => {
    expect(TOPIC_REFLECT_PROMPT).toMatch(/UNTRUSTED/);
    expect(TOPIC_REFLECT_PROMPT.toLowerCase()).toContain("never follow");
  });

  it("carries the load-bearing anti-laundering line verbatim ('Do NOT include a trust level')", () => {
    // The model has NO
    // trust say (trust is the CODE-computed `learned` ceiling the store coerces).
    expect(TOPIC_REFLECT_PROMPT).toContain("Do NOT include a trust level");
  });

  it("emits the {sections}/{ops} shape vocabulary (so the SHARED parser + buildNextBody apply)", () => {
    expect(TOPIC_REFLECT_PROMPT).toContain("sections");
    expect(TOPIC_REFLECT_PROMPT).toContain("ops");
    expect(TOPIC_REFLECT_PROMPT).toContain("replace");
    expect(TOPIC_REFLECT_PROMPT).toContain("remove");
  });

  it("carries NO executable envelope (advisory topic doc — no scripts/paramsSchema surface)", () => {
    // Word-boundary match: the guard is the JSON envelope key `scripts`, not the
    // substring (the prompt's prose word "transcript(s)" legitimately contains it).
    expect(TOPIC_REFLECT_PROMPT).not.toMatch(/\bscripts\b/);
    expect(TOPIC_REFLECT_PROMPT).not.toContain("paramsSchema");
  });

  it("does NOT request the deductive S/P/O triple OUTPUT shape (triples do NOT belong in a markdown doc)", () => {
    // A deductive { "subject", "predicate", "object" } JSON output is structured
    // relational knowledge (a triple_store row shape); the kind:topic doc covers
    // ONLY the INDUCTIVE/generalization observations. The topic prompt must NOT ask
    // the model to emit that triple OUTPUT shape. (NB: the shared
    // MEMORY_LANGUAGE_PRESERVATION_INSTRUCTION names "predicate" as a structural-key
    // carve-out — a verbatim-English machine key — so the test targets the OUTPUT
    // contract: the quoted JSON `"subject"` key + the "subject-predicate-object"
    // phrasing the deductive prompt uses, neither of which is in this template.)
    expect(TOPIC_REFLECT_PROMPT).not.toContain('"subject"');
    expect(TOPIC_REFLECT_PROMPT.toLowerCase()).not.toContain("subject-predicate-object");
  });
});
