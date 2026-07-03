// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link parseJudgeVerdict} -- the TOTAL
 * judge-output parser.
 *
 * UNGATED, default-CI: this is pure, deterministic string->value parsing (no
 * LLM, no I/O), so it runs in the fast `pnpm test` tier and imports
 * `qa-judge-parse.ts` so that file is never a 0%-coverage entry under the
 * agent `all:true` floor (a never-imported src file fails the full
 * coverage run).
 *
 * The judge is a lightly-trusted, possibly-injected free-text boundary
 * (DoS/Tampering): the parser MUST be TOTAL -- never throw, and
 * return `undefined` (the INVALID signal) on unparseable text rather than a
 * wrong verdict. Every branch (valid JSON true/false, fenced JSON, regex
 * `yes`/`no`, garbage->undefined) gets a case to hold the agent 79% branch
 * floor.
 *
 * ARCHITECTURE: imports only the in-package pure module -- no @comis/memory.
 */

import { describe, it, expect } from "vitest";
import { parseJudgeVerdict, stripCodeFences } from "./qa-judge-parse.js";

describe("parseJudgeVerdict -- TOTAL judge-output parser", () => {
  it("Test 1: valid JSON {correct:true, reasoning} maps to { correct: true, reasoning }", () => {
    const v = parseJudgeVerdict('{"correct": true, "reasoning": "ok"}');
    expect(v).toEqual({ correct: true, reasoning: "ok" });
  });

  it("Test 2: valid JSON {correct:false} (no reasoning) defaults reasoning to ''", () => {
    const v = parseJudgeVerdict('{"correct": false}');
    expect(v).toEqual({ correct: false, reasoning: "" });
  });

  it("Test 3: fenced JSON in a json code block parses to { correct: true }", () => {
    const fenced = ["```json", '{"correct":true,"reasoning":"fenced"}', "```"].join("\n");
    const v = parseJudgeVerdict(fenced);
    expect(v).toEqual({ correct: true, reasoning: "fenced" });
  });

  it("Test 3b: an uppercase ```JSON fence parses to the structured verdict", () => {
    const fenced = ["```JSON", '{"correct":true,"reasoning":"upper-fence"}', "```"].join("\n");
    const v = parseJudgeVerdict(fenced);
    expect(v).toEqual({ correct: true, reasoning: "upper-fence" });
  });

  it("Test 3c: a non-JSON language tag (```python) fence parses to the structured verdict", () => {
    const fenced = ["```python", '{"correct":false,"reasoning":"py-fence"}', "```"].join("\n");
    const v = parseJudgeVerdict(fenced);
    expect(v).toEqual({ correct: false, reasoning: "py-fence" });
  });

  it("Test 3d: stripCodeFences removes an opening fence with ANY language tag, case-insensitively -- so the verdict reaches the PRIMARY whole-string JSON path, not the regex fallback", () => {
    // A lowercase-only /```json?\n?/ strip would leave the language word of
    // ```JSON / ```python / ```JavaScript as a textual prefix, so the verdict would be
    // recovered only by the firstJsonObject fallback. The strip must remove any
    // [a-zA-Z]* tag so the cleaned text begins with the JSON object.
    expect(stripCodeFences('```json\n{"correct":true}\n```')).toBe('{"correct":true}');
    expect(stripCodeFences('```JSON\n{"correct":true}\n```')).toBe('{"correct":true}');
    expect(stripCodeFences('```python\n{"correct":true}\n```')).toBe('{"correct":true}');
    expect(stripCodeFences('```JavaScript\n{"correct":true}\n```')).toBe('{"correct":true}');
    // A bare fence with no tag (and no newline) still strips.
    expect(stripCodeFences('```{"correct":true}```')).toBe('{"correct":true}');
    // No fence at all -> unchanged (after trim).
    expect(stripCodeFences('{"correct":true}')).toBe('{"correct":true}');
  });

  it("Test 3e: the broadened strip is ReDoS-free on a long tag run -- it terminates, never throws, and stays linear", () => {
    // A pathological opening-fence-like prefix must not cause super-linear backtracking.
    // We assert TERMINATION + correctness on a large input (the suite's no-timing style):
    // a `[a-zA-Z]*` tag is a non-nested quantifier, so the match is a single linear pass.
    const hostile = "```" + "a".repeat(200_000) + '\n{"correct":true}';
    let out: string | undefined;
    expect(() => {
      out = stripCodeFences(hostile);
    }).not.toThrow();
    expect(out).toBe('{"correct":true}');
    // And the full parser stays TOTAL on the same hostile fenced input.
    expect(() => parseJudgeVerdict(hostile)).not.toThrow();
    expect(parseJudgeVerdict(hostile)).toEqual({ correct: true, reasoning: "" });
  });

  it("Test 4: commentary-wrapped `correct: yes` (no valid JSON) falls back to regex, correct:true", () => {
    const v = parseJudgeVerdict("My judgement: correct: yes, the answer matches the gold.");
    expect(v?.correct).toBe(true);
    expect(typeof v?.reasoning).toBe("string");
  });

  it("Test 5: `correct=no` falls back to regex, correct:false", () => {
    const v = parseJudgeVerdict("Verdict correct=no, the response omits the date.");
    expect(v?.correct).toBe(false);
  });

  it("Test 6: pure garbage maps to undefined (the INVALID signal, NOT a throw, NOT a wrong verdict)", () => {
    expect(parseJudgeVerdict("lorem ipsum dolor sit amet, no verdict at all")).toBeUndefined();
  });

  it("Test 6b: empty string maps to undefined", () => {
    expect(parseJudgeVerdict("")).toBeUndefined();
  });

  it("is TOTAL -- never throws on adversarial / unterminated-JSON / control-char input", () => {
    const adversarial = [
      '{"correct": true', // unterminated JSON
      "}{][", // structural garbage
      "correct", // bare token, no value
      " ", // whitespace only
      ["```json", "```"].join("\n"), // empty fence
    ];
    for (const text of adversarial) {
      expect(() => parseJudgeVerdict(text)).not.toThrow();
    }
    // non-boolean `correct` with no yes/no/true/false token is unparseable, so invalid
    expect(parseJudgeVerdict('{"correct": "maybe"}')).toBeUndefined();
  });

  it("does NOT let adversarial dataset prose force correct=true (only the verdict token is read)", () => {
    // Free prose that merely mentions "correct answer" must NOT parse as a true verdict.
    const v = parseJudgeVerdict("The gold contains the correct answer about Paris; the model said London.");
    // "correct answer" has no `correct:`/`correct=` separator, so no verdict token, so invalid.
    expect(v).toBeUndefined();
  });

  it("balanced-object extraction is string/escape-aware (a brace inside a quoted reasoning is not a close)", () => {
    // The reasoning string contains an escaped quote AND a literal close-brace --
    // the brace-depth scan must ignore both (inside-string) and close on the real one.
    const reasoning = 'says "done}" already';
    const input = JSON.stringify({ correct: true, reasoning }) + "\ntrailing note";
    const v = parseJudgeVerdict(input);
    expect(v?.correct).toBe(true);
    expect(v?.reasoning).toBe(reasoning);
  });

  it("JSON correct:true wins even with trailing prose (the leading JSON object is authoritative)", () => {
    const input = JSON.stringify({ correct: true, reasoning: "matches" }) + "\nNote: looks wrong to me though.";
    const v = parseJudgeVerdict(input);
    expect(v?.correct).toBe(true);
  });
});
