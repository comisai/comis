// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  it("returns empty string unchanged", () => {
    expect(stripReasoningTagsFromText("")).toBe("");
  });

  it("returns text without reasoning tags unchanged (no-op)", () => {
    const text = "Hello, how are you?";
    expect(stripReasoningTagsFromText(text)).toBe(text);
  });

  it("strips <think> block and preserves content after", () => {
    expect(
      stripReasoningTagsFromText("<think>reasoning here</think>actual content"),
    ).toBe("actual content");
  });

  it("strips <thinking> block and preserves content after", () => {
    expect(
      stripReasoningTagsFromText("<thinking>deep thought</thinking>response"),
    ).toBe("response");
  });

  it("strips <thought> block and preserves content after", () => {
    expect(
      stripReasoningTagsFromText("<thought>hmm</thought>answer"),
    ).toBe("answer");
  });

  it("strips <antThinking> block and preserves content after", () => {
    expect(
      stripReasoningTagsFromText("<antThinking>analysis</antThinking>reply"),
    ).toBe("reply");
  });

  it("strips multiple reasoning blocks in same text", () => {
    const input =
      "<think>first thought</think>Hello <thinking>second thought</thinking>World";
    expect(stripReasoningTagsFromText(input)).toBe("Hello World");
  });

  it("handles unclosed <think> tag (preserve mode keeps trailing content)", () => {
    const result = stripReasoningTagsFromText(
      "<think>reasoning but no close tag",
      { mode: "preserve" },
    );
    // In preserve mode, content after the unclosed opening tag is preserved
    expect(result).toBe("reasoning but no close tag");
  });

  it("handles unclosed <think> tag (strict mode drops content)", () => {
    const result = stripReasoningTagsFromText(
      "Before <think>reasoning without close",
      { mode: "strict" },
    );
    expect(result).toBe("Before");
  });

  it("preserves inline backtick code containing <think>", () => {
    const input = "Use the `<think>` tag for reasoning. Some text.";
    const result = stripReasoningTagsFromText(input);
    expect(result).toContain("`<think>`");
  });

  it("preserves fenced code block containing <thinking>", () => {
    const input = "Before\n```\n<thinking>code example</thinking>\n```\nAfter";
    const result = stripReasoningTagsFromText(input);
    expect(result).toContain("<thinking>code example</thinking>");
  });

  it("strips outside tags while preserving tags inside code", () => {
    const input =
      "<think>reasoning</think>Explanation: use `<think>` tag\n```\n<thinking>in code</thinking>\n```\nDone";
    const result = stripReasoningTagsFromText(input);
    // Outside <think> block stripped
    expect(result).not.toMatch(/^<think>/);
    // Inline code preserved
    expect(result).toContain("`<think>`");
    // Fenced code preserved
    expect(result).toContain("<thinking>in code</thinking>");
    expect(result).toContain("Done");
  });

  it("strips <final> tags but preserves their content (unwrap)", () => {
    const input = "<final>important answer</final>";
    const result = stripReasoningTagsFromText(input);
    expect(result).toBe("important answer");
  });

  it("handles case-insensitive tag matching", () => {
    expect(
      stripReasoningTagsFromText("<THINK>upper case</THINK>result"),
    ).toBe("result");
  });
});
