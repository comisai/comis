// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { convertIrToSignalTextStyles, type SignalTextStyle } from "./signal-format.js";
import { parseMarkdownToIR } from "../shared/markdown-ir.js";
import type { MarkdownIR } from "../shared/markdown-ir.js";

describe("convertIrToSignalTextStyles", () => {
  it("converts plain text without styles", () => {
    const ir = parseMarkdownToIR("Hello world");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("Hello world");
    expect(result.textStyles).toEqual([]);
  });

  it("converts bold text to BOLD style", () => {
    const ir = parseMarkdownToIR("Hello **bold** world");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("Hello bold world");
    const boldStyle = result.textStyles.find((s) => s.style === "BOLD");
    expect(boldStyle).toBeDefined();
    expect(boldStyle!.start).toBe(6);
    expect(boldStyle!.length).toBe(4);
  });

  it("converts italic text to ITALIC style", () => {
    const ir = parseMarkdownToIR("Hello *italic* world");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("Hello italic world");
    const italicStyle = result.textStyles.find((s) => s.style === "ITALIC");
    expect(italicStyle).toBeDefined();
    expect(italicStyle!.start).toBe(6);
    expect(italicStyle!.length).toBe(6);
  });

  it("converts inline code to MONOSPACE style", () => {
    const ir = parseMarkdownToIR("Use `npm install` to install");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("Use npm install to install");
    const monoStyle = result.textStyles.find((s) => s.style === "MONOSPACE");
    expect(monoStyle).toBeDefined();
    expect(monoStyle!.start).toBe(4);
    expect(monoStyle!.length).toBe(11);
  });

  it("converts strikethrough to STRIKETHROUGH style", () => {
    const ir = parseMarkdownToIR("This is ~~deleted~~ text");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("This is deleted text");
    const strikeStyle = result.textStyles.find(
      (s) => s.style === "STRIKETHROUGH",
    );
    expect(strikeStyle).toBeDefined();
    expect(strikeStyle!.start).toBe(8);
    expect(strikeStyle!.length).toBe(7);
  });

  it("handles multiple styles in one paragraph", () => {
    const ir = parseMarkdownToIR("**bold** and *italic*");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("bold and italic");
    expect(result.textStyles).toHaveLength(2);
    expect(result.textStyles[0]).toEqual({
      start: 0,
      length: 4,
      style: "BOLD",
    });
    expect(result.textStyles[1]).toEqual({
      start: 9,
      length: 6,
      style: "ITALIC",
    });
  });

  it("handles code blocks as MONOSPACE", () => {
    const ir = parseMarkdownToIR("```\nconst x = 1;\n```");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("const x = 1;");
    expect(result.textStyles).toEqual([
      { start: 0, length: 12, style: "MONOSPACE" },
    ]);
  });

  it("renders headings as BOLD", () => {
    const ir = parseMarkdownToIR("# My Heading\n\nSome text");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toContain("My Heading");
    const boldStyle = result.textStyles.find((s) => s.style === "BOLD");
    expect(boldStyle).toBeDefined();
    expect(boldStyle!.length).toBe("My Heading".length);
  });

  it("renders blockquotes with > prefix", () => {
    const ir = parseMarkdownToIR("> quoted text");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("> quoted text");
  });

  it("renders lists correctly", () => {
    const ir = parseMarkdownToIR("- item one\n- item two");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toContain("- item one");
    expect(result.text).toContain("- item two");
  });

  it("renders ordered lists correctly", () => {
    const ir = parseMarkdownToIR("1. first\n2. second");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toContain("1. first");
    expect(result.text).toContain("2. second");
  });

  it("handles links by appending URL", () => {
    const ir = parseMarkdownToIR("Visit [Google](https://google.com)");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toContain("Google");
    expect(result.text).toContain("https://google.com");
  });

  it("uses UTF-16 code units for offsets (emoji/surrogate pairs)", () => {
    // Emoji before styled text to verify offset correctness
    const ir = parseMarkdownToIR("Hi there **bold**");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("Hi there bold");
    const boldStyle = result.textStyles.find((s) => s.style === "BOLD");
    expect(boldStyle).toBeDefined();
    // "Hi there " = 9 chars, offset should be 9
    expect(boldStyle!.start).toBe(9);
    expect(boldStyle!.length).toBe(4);
  });

  it("handles empty IR", () => {
    const ir: MarkdownIR = { blocks: [], sourceLength: 0 };
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("");
    expect(result.textStyles).toEqual([]);
  });

  it("separates blocks with double newline", () => {
    const ir = parseMarkdownToIR("Paragraph one\n\nParagraph two");
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toBe("Paragraph one\n\nParagraph two");
  });

  it("renders tables as plain text", () => {
    const ir = parseMarkdownToIR(
      "| Col1 | Col2 |\n| --- | --- |\n| a | b |",
    );
    const result = convertIrToSignalTextStyles(ir);
    expect(result.text).toContain("Col1");
    expect(result.text).toContain("Col2");
    expect(result.text).toContain("a");
    expect(result.text).toContain("b");
  });
});
