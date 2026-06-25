// SPDX-License-Identifier: Apache-2.0
/**
 * RED→GREEN coverage for {@link REFLECT_PROMPT} + {@link parseReflectionResult}
 * (v2.31 Reflection engine, Phase 223 Plan 04, REFLECT-04).
 *
 * The reflect LLM emits one of two shapes (the parser's contract — see the
 * JSDoc on `parseReflectionResult`):
 *  - a NEW doc → `{ "sections": DocSection[] }` (a fresh playbook),
 *  - an EXISTING-doc refresh → `{ "ops": DeltaOp[] }` (typed delta-ops over the
 *    prior `structuredBody`, untargeted sections byte-identical).
 *
 * The parser is TOTAL (the synthesis-prompt `parseSynthesisResult` shape): a
 * malformed top-level payload returns an empty result and NEVER throws; a batch
 * with one malformed element salvages the valid ones (per-element salvage); an
 * op with an unknown `op` value is dropped, not thrown. The prompt constant
 * carries the UNTRUSTED-data + GENERALIZE instructions and emits the delta-op
 * schema (NOT the dropped scripts/requiredTools/paramsSchema envelope).
 */
import { describe, it, expect } from "vitest";
import { REFLECT_PROMPT, parseReflectionResult } from "./reflection-prompt.js";

describe("parseReflectionResult (TOTAL delta-op / section parser, REFLECT-04)", () => {
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
