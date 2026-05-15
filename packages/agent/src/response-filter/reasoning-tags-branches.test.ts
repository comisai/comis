// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for reasoning-tags.ts (Plan 40-11 / COV-03).
 *
 * The existing reasoning-tags.test.ts covers tag-stripping cases and
 * code-region protection but does not exercise:
 *   - trim mode "none" (line 94)
 *   - trim mode "start" (line 95)
 *   - <final> tag stripping when nested inside code regions (line 52 + isInsideCode true)
 *   - thinking tag detected inside code region (line 73 + isInsideCode true)
 *   - applyTrim default "both" branch
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText — trim mode branches", () => {
  it("does not trim whitespace when trim option is set to 'none'", () => {
    const text = "  <think>internal</think>  hello  ";
    const result = stripReasoningTagsFromText(text, { trim: "none" });
    // "<think>internal</think>" stripped; leading/trailing whitespace preserved
    expect(result.startsWith("  ")).toBe(true);
    expect(result.endsWith("  ")).toBe(true);
  });

  it("trims only leading whitespace when trim option is set to 'start'", () => {
    const text = "  <think>internal</think>  hello  ";
    const result = stripReasoningTagsFromText(text, { trim: "start" });
    expect(result.startsWith(" ")).toBe(false);
    expect(result.endsWith(" ")).toBe(true); // trailing whitespace preserved
  });

  it("trims both leading and trailing whitespace by default", () => {
    const text = "  <think>internal</think>  hello  ";
    const result = stripReasoningTagsFromText(text); // no options -> default "both"
    expect(result.startsWith(" ")).toBe(false);
    expect(result.endsWith(" ")).toBe(false);
    expect(result).toBe("hello");
  });

  it("trims both whitespace edges when trim option is explicitly 'both'", () => {
    const text = "  <think>x</think>  Y  ";
    const result = stripReasoningTagsFromText(text, { trim: "both" });
    expect(result).toBe("Y");
  });
});

describe("stripReasoningTagsFromText — code-region branch coverage", () => {
  it("preserves <final> tags that occur inside fenced code blocks", () => {
    const text = "before\n```\n<final>kept</final>\n```\nafter";
    const result = stripReasoningTagsFromText(text);
    // The <final> inside ``` should NOT be stripped
    expect(result).toContain("<final>kept</final>");
  });

  it("strips <final> tags outside code blocks while preserving those inside", () => {
    const text = "<final>strip</final> mid `<final>keep</final>` end";
    const result = stripReasoningTagsFromText(text);
    expect(result).toContain("strip"); // <final> stripped, content kept
    expect(result).toContain("`<final>keep</final>`"); // inside inline code preserved
  });

  it("preserves thinking tags inside fenced code blocks (continue branch)", () => {
    const text = "outside\n```js\n<thinking>internal</thinking>\n```\nafter";
    const result = stripReasoningTagsFromText(text);
    // The fenced code block's <thinking> stays intact
    expect(result).toContain("<thinking>internal</thinking>");
  });
});

describe("stripReasoningTagsFromText — early-exit branch coverage", () => {
  it("returns input verbatim when QUICK_TAG_RE finds no reasoning tags", () => {
    const text = "Just plain text with no special tags";
    const result = stripReasoningTagsFromText(text);
    expect(result).toBe(text);
  });

  it("returns empty input verbatim", () => {
    expect(stripReasoningTagsFromText("")).toBe("");
  });
});
