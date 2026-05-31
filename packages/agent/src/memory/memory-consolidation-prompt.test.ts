// SPDX-License-Identifier: Apache-2.0
//
// Prompt-parser suite for consolidation (Phase 84). `parseConsolidationResult`
// is the LENIENT, total, never-throws parser for the MERGE-only LLM contract:
// it accepts `{content, confidence?, sourceIds?}`, STRIPS any extra key, and —
// critically — IGNORES any LLM-supplied `trustLevel`/`supersededIds` (trust is
// computed in CODE, not accepted from the model). Mirrors `parseExtractionResult`.
import { describe, it, expect } from "vitest";
import { CONSOLIDATION_PROMPT, parseConsolidationResult } from "./memory-consolidation-prompt.js";

describe("parseConsolidationResult — lenient MERGE-only parser (CONS contract)", () => {
  it("accepts a well-formed merge object with content + confidence", () => {
    const parsed = parseConsolidationResult('{"content":"merged fact","confidence":0.8}');
    expect(parsed).toEqual({ content: "merged fact", confidence: 0.8 });
  });

  it("accepts an optional sourceIds array", () => {
    const parsed = parseConsolidationResult('{"content":"f","confidence":0.5,"sourceIds":["s1","s2"]}');
    expect(parsed?.sourceIds).toEqual(["s1", "s2"]);
  });

  it("strips a benign extra key without rejecting the object", () => {
    const parsed = parseConsolidationResult('{"content":"f","note":"ignore me"}');
    expect(parsed?.content).toBe("f");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("note");
  });

  it("IGNORES an LLM-supplied trustLevel (trust is code-computed, MERGE-only)", () => {
    const parsed = parseConsolidationResult('{"content":"f","trustLevel":"system"}');
    expect(parsed?.content).toBe("f");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("trustLevel");
  });

  it("IGNORES an LLM-supplied supersededIds (no supersede in the contract)", () => {
    const parsed = parseConsolidationResult('{"content":"f","supersededIds":["x"]}');
    expect(parsed?.content).toBe("f");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("supersededIds");
  });

  it("strips markdown code fences before parsing", () => {
    const parsed = parseConsolidationResult('```json\n{"content":"fenced fact"}\n```');
    expect(parsed?.content).toBe("fenced fact");
  });

  it("returns undefined on malformed JSON (total, never throws)", () => {
    expect(parseConsolidationResult("not json at all {{{")).toBeUndefined();
  });

  it("returns undefined when content is missing", () => {
    expect(parseConsolidationResult('{"confidence":0.9}')).toBeUndefined();
  });

  it("returns undefined when content is empty", () => {
    expect(parseConsolidationResult('{"content":""}')).toBeUndefined();
  });

  it("returns undefined on the wrong top-level shape (array)", () => {
    expect(parseConsolidationResult('[{"content":"f"}]')).toBeUndefined();
  });

  it("returns undefined when confidence is out of the 0..1 range", () => {
    expect(parseConsolidationResult('{"content":"f","confidence":1.5}')).toBeUndefined();
  });
});

describe("CONSOLIDATION_PROMPT — MERGE-only instruction", () => {
  it("instructs the model to emit content + confidence and forbids trust/supersede", () => {
    expect(CONSOLIDATION_PROMPT).toMatch(/content/i);
    expect(CONSOLIDATION_PROMPT).toMatch(/trust/i);
    expect(CONSOLIDATION_PROMPT).toMatch(/supersed/i);
  });
});
