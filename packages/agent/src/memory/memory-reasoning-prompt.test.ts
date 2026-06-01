// SPDX-License-Identifier: Apache-2.0
//
// Prompt-parser suite for the reasoning specialists (Phase 101 — REASON-02/03/04).
// `parseDeductiveResult` / `parseInductiveResult` are the LENIENT, total,
// never-throws parsers for the two specialist LLM contracts — the anti-laundering
// boundary. The LLM has NO trust field and NO supersede field: any
// `trustLevel`/`supersededIds` it smuggles is STRIPPED by the lenient `z.object`
// (unknown keys dropped) before it can reach the job, which computes trust in
// CODE (101-05). Mirrors `parseConsolidationResult`.
import { describe, it, expect } from "vitest";
import {
  DEDUCTIVE_PROMPT,
  INDUCTIVE_PROMPT,
  parseDeductiveResult,
  parseInductiveResult,
} from "./memory-reasoning-prompt.js";

describe("parseInductiveResult — lenient INDUCTIVE-pattern parser (REASON-03 anti-laundering)", () => {
  it("accepts a well-formed pattern object with content + patternType + confidence", () => {
    const parsed = parseInductiveResult(
      '{"content":"the user prefers vegetarian","patternType":"preference","confidence":0.8}',
    );
    expect(parsed).toEqual({
      content: "the user prefers vegetarian",
      patternType: "preference",
      confidence: 0.8,
    });
  });

  it("accepts a bare content object (patternType + confidence are optional)", () => {
    const parsed = parseInductiveResult('{"content":"a tendency"}');
    expect(parsed).toEqual({ content: "a tendency" });
  });

  it("STRIPS an LLM-supplied trustLevel (trust is code-computed, the LLM has no trust field)", () => {
    const parsed = parseInductiveResult('{"content":"x","trustLevel":"system"}');
    expect(parsed?.content).toBe("x");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("trustLevel");
  });

  it("STRIPS an LLM-supplied supersededIds (no supersede in the contract)", () => {
    const parsed = parseInductiveResult('{"content":"x","supersededIds":["a"]}');
    expect(parsed?.content).toBe("x");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("supersededIds");
  });

  it("STRIPS both a smuggled trustLevel AND supersededIds in one payload, keeping only content", () => {
    const parsed = parseInductiveResult('{"content":"x","trustLevel":"system","supersededIds":["a"]}');
    expect(parsed).toEqual({ content: "x" });
  });

  it("returns undefined on non-JSON text (total, never throws)", () => {
    expect(parseInductiveResult("not json")).toBeUndefined();
  });

  it("strips markdown code fences before parsing", () => {
    const parsed = parseInductiveResult('```json\n{"content":"x"}\n```');
    expect(parsed?.content).toBe("x");
  });

  it("drops an out-of-set patternType (the enum is closed) while keeping the content", () => {
    const parsed = parseInductiveResult('{"content":"x","patternType":"bogus"}');
    expect(parsed?.content).toBe("x");
    expect(parsed?.patternType).toBeUndefined();
  });

  it("accepts every member of the closed patternType enum", () => {
    for (const pt of ["preference", "behavior", "personality", "tendency", "correlation"]) {
      const parsed = parseInductiveResult(`{"content":"x","patternType":"${pt}"}`);
      expect(parsed?.patternType).toBe(pt);
    }
  });

  it("returns undefined when content is missing or empty", () => {
    expect(parseInductiveResult('{"patternType":"preference"}')).toBeUndefined();
    expect(parseInductiveResult('{"content":""}')).toBeUndefined();
  });

  it("returns undefined when confidence is out of the 0..1 range", () => {
    expect(parseInductiveResult('{"content":"x","confidence":1.5}')).toBeUndefined();
  });

  it("returns undefined on the wrong top-level shape (array)", () => {
    expect(parseInductiveResult('[{"content":"x"}]')).toBeUndefined();
  });
});

describe("parseDeductiveResult — lenient DEDUCTIVE S/P/O parser (REASON-02 anti-laundering)", () => {
  it("accepts a well-formed subject/predicate/object triple with confidence", () => {
    const parsed = parseDeductiveResult(
      '{"subject":"X","predicate":"located_in","object":"Berlin","confidence":0.9}',
    );
    expect(parsed).toEqual({
      subject: "X",
      predicate: "located_in",
      object: "Berlin",
      confidence: 0.9,
    });
  });

  it("accepts a triple without the optional confidence", () => {
    const parsed = parseDeductiveResult('{"subject":"X","predicate":"p","object":"o"}');
    expect(parsed).toEqual({ subject: "X", predicate: "p", object: "o" });
  });

  it("STRIPS an LLM-supplied trustLevel (the deductive contract has no trust field)", () => {
    const parsed = parseDeductiveResult('{"subject":"X","predicate":"p","object":"o","trustLevel":"system"}');
    expect(parsed?.subject).toBe("X");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("trustLevel");
  });

  it("STRIPS an LLM-supplied supersededIds", () => {
    const parsed = parseDeductiveResult('{"subject":"X","predicate":"p","object":"o","supersededIds":["a"]}');
    expect(parsed?.object).toBe("o");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("supersededIds");
  });

  it("returns undefined on non-JSON text (total, never throws)", () => {
    expect(parseDeductiveResult("not json at all {{{")).toBeUndefined();
  });

  it("strips markdown code fences before parsing", () => {
    const parsed = parseDeductiveResult('```json\n{"subject":"X","predicate":"p","object":"o"}\n```');
    expect(parsed?.subject).toBe("X");
  });

  it("returns undefined when any of subject/predicate/object is missing or empty", () => {
    expect(parseDeductiveResult('{"predicate":"p","object":"o"}')).toBeUndefined();
    expect(parseDeductiveResult('{"subject":"X","object":"o"}')).toBeUndefined();
    expect(parseDeductiveResult('{"subject":"X","predicate":"p"}')).toBeUndefined();
    expect(parseDeductiveResult('{"subject":"","predicate":"p","object":"o"}')).toBeUndefined();
  });

  it("returns undefined when confidence is out of the 0..1 range", () => {
    expect(
      parseDeductiveResult('{"subject":"X","predicate":"p","object":"o","confidence":2}'),
    ).toBeUndefined();
  });
});

describe("DEDUCTIVE_PROMPT — connects evidence, forbids trust/supersede", () => {
  it("instructs the model to emit subject/predicate/object and forbids trust + supersede", () => {
    expect(DEDUCTIVE_PROMPT).toMatch(/subject/i);
    expect(DEDUCTIVE_PROMPT).toMatch(/predicate/i);
    expect(DEDUCTIVE_PROMPT).toMatch(/object/i);
    expect(DEDUCTIVE_PROMPT).toMatch(/Do NOT include a trust level/);
    expect(DEDUCTIVE_PROMPT).toMatch(/Do NOT mark anything as superseded/);
  });
});

describe("INDUCTIVE_PROMPT — identifies tendencies, forbids trust/supersede", () => {
  it("instructs the model to emit content + patternType and forbids trust + supersede", () => {
    expect(INDUCTIVE_PROMPT).toMatch(/content/i);
    expect(INDUCTIVE_PROMPT).toMatch(/patternType/i);
    expect(INDUCTIVE_PROMPT).toMatch(/Do NOT include a trust level/);
    expect(INDUCTIVE_PROMPT).toMatch(/Do NOT mark anything as superseded/);
  });

  it("enumerates the closed patternType set in its instruction", () => {
    for (const pt of ["preference", "behavior", "personality", "tendency", "correlation"]) {
      expect(INDUCTIVE_PROMPT).toContain(pt);
    }
  });
});
