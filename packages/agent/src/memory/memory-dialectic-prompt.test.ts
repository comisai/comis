// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the agent-internal dialectic prompt + its lenient/total parser
 * (grounded/abstain/cite/trust-first).
 *
 * `buildDialecticPrompt` is a pure builder (no IO) that returns the synthesis system
 * prompt — agent-internal, so the prompt STRING never crosses the package boundary
 * (mirrors how the seam family keeps its prompts private). `parseDialecticOutput` is a
 * LENIENT + TOTAL parser: a malformed payload degrades to abstain (never throws — the
 * Pitfall-5 default) and any model-asserted `trust`/`trustLevel` is STRIPPED (the
 * anti-laundering boundary — trust is read from `entry.trustLevel` in CODE, never the LLM).
 */
import { describe, it, expect } from "vitest";
import { buildDialecticPrompt, parseDialecticOutput } from "./memory-dialectic-prompt.js";

describe("buildDialecticPrompt", () => {
  it("returns a system-prompt string instructing answer-strictly-from-grounding, cite ids, abstain, prefer higher-trust", () => {
    const prompt = buildDialecticPrompt();
    expect(typeof prompt).toBe("string");
    const lower = prompt.toLowerCase();
    // Grounded: answer ONLY/STRICTLY from the provided memories.
    expect(lower).toMatch(/only|strictly/);
    // Cite the ids it used.
    expect(lower).toContain("cite");
    // Abstain when the memories do not contain the answer.
    expect(lower).toContain("abstain");
    // Trust-first on conflict.
    expect(lower).toContain("trust");
  });
});

describe("parseDialecticOutput", () => {
  it("parses a well-formed grounded JSON into { abstain:false, answer, citedIds }", () => {
    expect(parseDialecticOutput('{"answer":"UTC","citedIds":["id-a"]}')).toEqual({
      abstain: false,
      answer: "UTC",
      citedIds: ["id-a"],
    });
  });

  it("parses an explicit abstain marker into { abstain:true }", () => {
    expect(parseDialecticOutput('{"abstain":true}')).toEqual({ abstain: true });
  });

  it("is TOTAL — non-JSON garbage degrades to { abstain:true } (never throws)", () => {
    expect(parseDialecticOutput("not json {{{")).toEqual({ abstain: true });
  });

  it("is TOTAL — a JSON object missing both answer and abstain degrades to { abstain:true }", () => {
    expect(parseDialecticOutput('{"citedIds":["id-a"]}')).toEqual({ abstain: true });
  });

  it("STRIPS a model-asserted trust field — the parsed grounded result carries no trust", () => {
    const parsed = parseDialecticOutput('{"answer":"x","citedIds":["id-a"],"trust":"system"}');
    expect(parsed).toEqual({ abstain: false, answer: "x", citedIds: ["id-a"] });
    expect(parsed).not.toHaveProperty("trust");
  });

  it("STRIPS a model-asserted trustLevel field too (the same anti-laundering boundary)", () => {
    const parsed = parseDialecticOutput('{"answer":"x","citedIds":["id-a"],"trustLevel":"system"}');
    expect(parsed).toEqual({ abstain: false, answer: "x", citedIds: ["id-a"] });
    expect(parsed).not.toHaveProperty("trustLevel");
  });

  it("drops non-string entries from citedIds (only string ids survive)", () => {
    const parsed = parseDialecticOutput('{"answer":"x","citedIds":["id-a",123,null,"id-b"]}');
    expect(parsed).toEqual({ abstain: false, answer: "x", citedIds: ["id-a", "id-b"] });
  });

  it("tolerates markdown code fences around the JSON payload (lenient)", () => {
    expect(parseDialecticOutput('```json\n{"answer":"UTC","citedIds":["id-a"]}\n```')).toEqual({
      abstain: false,
      answer: "UTC",
      citedIds: ["id-a"],
    });
  });

  it("defaults citedIds to [] when the grounded payload omits them", () => {
    expect(parseDialecticOutput('{"answer":"UTC"}')).toEqual({
      abstain: false,
      answer: "UTC",
      citedIds: [],
    });
  });
});
