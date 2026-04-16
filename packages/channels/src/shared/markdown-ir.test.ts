/**
 * Tests for Markdown IR parser.
 *
 * Verifies block-level parsing (paragraph, code_block, heading, blockquote,
 * table, list) and inline span parsing (text, bold, italic, code,
 * strikethrough, link) with UTF-16 offsets.
 */
import { describe, it, expect } from "vitest";
import { parseMarkdownToIR } from "./markdown-ir.js";
import type { MarkdownBlock, MarkdownSpan, MarkdownIR } from "./markdown-ir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to get spans from first block. */
function firstBlockSpans(md: string): MarkdownSpan[] {
  const ir = parseMarkdownToIR(md);
  return ir.blocks[0]?.spans ?? [];
}

/** Shorthand to get first block. */
function firstBlock(md: string): MarkdownBlock {
  const ir = parseMarkdownToIR(md);
  return ir.blocks[0]!;
}

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

describe("parseMarkdownToIR", () => {
  describe("paragraphs", () => {
    it("parses plain text as a single paragraph", () => {
      const ir = parseMarkdownToIR("Hello world");
      expect(ir.blocks).toHaveLength(1);
      expect(ir.blocks[0].type).toBe("paragraph");
      expect(ir.blocks[0].spans).toHaveLength(1);
      expect(ir.blocks[0].spans[0].type).toBe("text");
      expect(ir.blocks[0].spans[0].text).toBe("Hello world");
    });

    it("separates paragraphs by double newlines", () => {
      const ir = parseMarkdownToIR("First paragraph\n\nSecond paragraph");
      expect(ir.blocks).toHaveLength(2);
      expect(ir.blocks[0].type).toBe("paragraph");
      expect(ir.blocks[1].type).toBe("paragraph");
      expect(ir.blocks[0].spans[0].text).toBe("First paragraph");
      expect(ir.blocks[1].spans[0].text).toBe("Second paragraph");
    });

    it("treats single newlines within a paragraph as continuation", () => {
      const ir = parseMarkdownToIR("Line one\nLine two");
      expect(ir.blocks).toHaveLength(1);
      expect(ir.blocks[0].type).toBe("paragraph");
    });
  });

  describe("code blocks", () => {
    it("parses fenced code block with language", () => {
      const md = "```js\nconsole.log(1)\n```";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      const block = ir.blocks[0];
      expect(block.type).toBe("code_block");
      expect(block.language).toBe("js");
      expect(block.raw).toBe("console.log(1)");
    });

    it("parses fenced code block without language", () => {
      const md = "```\nplain code\n```";
      const ir = parseMarkdownToIR(md);
      const block = ir.blocks[0];
      expect(block.type).toBe("code_block");
      expect(block.language).toBeUndefined();
      expect(block.raw).toBe("plain code");
    });

    it("parses tilde code fences", () => {
      const md = "~~~python\nprint('hi')\n~~~";
      const ir = parseMarkdownToIR(md);
      const block = ir.blocks[0];
      expect(block.type).toBe("code_block");
      expect(block.language).toBe("python");
      expect(block.raw).toBe("print('hi')");
    });

    it("does not parse inline formatting inside code blocks", () => {
      const md = "```\n**bold** and *italic*\n```";
      const ir = parseMarkdownToIR(md);
      const block = ir.blocks[0];
      expect(block.type).toBe("code_block");
      expect(block.raw).toBe("**bold** and *italic*");
      expect(block.spans).toHaveLength(0);
    });

    it("handles unclosed code fences by extending to end", () => {
      const md = "```js\nsome code\nmore code";
      const ir = parseMarkdownToIR(md);
      const block = ir.blocks[0];
      expect(block.type).toBe("code_block");
      expect(block.raw).toBe("some code\nmore code");
    });

    it("matches fence characters (backtick vs tilde)", () => {
      // Tilde opening should not close with backtick
      const md = "~~~\ncode\n```\nmore\n~~~";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      expect(ir.blocks[0].type).toBe("code_block");
      expect(ir.blocks[0].raw).toBe("code\n```\nmore");
    });

    it("handles code block between paragraphs", () => {
      const md = "Before\n\n```js\ncode\n```\n\nAfter";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(3);
      expect(ir.blocks[0].type).toBe("paragraph");
      expect(ir.blocks[1].type).toBe("code_block");
      expect(ir.blocks[2].type).toBe("paragraph");
    });
  });

  describe("headings", () => {
    it("parses h1 heading", () => {
      const block = firstBlock("# Title");
      expect(block.type).toBe("heading");
      expect(block.depth).toBe(1);
      expect(block.spans[0].text).toBe("Title");
    });

    it("parses h2 through h6 headings", () => {
      for (let d = 2; d <= 6; d++) {
        const prefix = "#".repeat(d);
        const block = firstBlock(`${prefix} Heading ${d}`);
        expect(block.type).toBe("heading");
        expect(block.depth).toBe(d);
        expect(block.spans[0].text).toBe(`Heading ${d}`);
      }
    });

    it("parses inline formatting within headings", () => {
      const block = firstBlock("# Hello **world**");
      expect(block.type).toBe("heading");
      expect(block.spans).toHaveLength(2);
      expect(block.spans[0].type).toBe("text");
      expect(block.spans[0].text).toBe("Hello ");
      expect(block.spans[1].type).toBe("bold");
      expect(block.spans[1].text).toBe("world");
    });
  });

  describe("blockquotes", () => {
    it("parses single-line blockquote", () => {
      const block = firstBlock("> quote");
      expect(block.type).toBe("blockquote");
      expect(block.spans[0].text).toBe("quote");
    });

    it("merges consecutive blockquote lines", () => {
      const ir = parseMarkdownToIR("> line1\n> line2");
      expect(ir.blocks).toHaveLength(1);
      expect(ir.blocks[0].type).toBe("blockquote");
    });

    it("parses inline formatting within blockquotes", () => {
      const block = firstBlock("> **bold** text");
      expect(block.type).toBe("blockquote");
      expect(block.spans).toHaveLength(2);
      expect(block.spans[0].type).toBe("bold");
      expect(block.spans[0].text).toBe("bold");
      expect(block.spans[1].type).toBe("text");
      expect(block.spans[1].text).toBe(" text");
    });
  });

  describe("tables", () => {
    it("parses a GFM table with headers and rows", () => {
      const md = "| A | B |\n|---|---|\n| 1 | 2 |";
      const block = firstBlock(md);
      expect(block.type).toBe("table");
      expect(block.headers).toEqual(["A", "B"]);
      expect(block.rows).toEqual([["1", "2"]]);
    });

    it("parses table with multiple rows", () => {
      const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
      const block = firstBlock(md);
      expect(block.type).toBe("table");
      expect(block.headers).toEqual(["Name", "Age"]);
      expect(block.rows).toHaveLength(2);
      expect(block.rows![0]).toEqual(["Alice", "30"]);
      expect(block.rows![1]).toEqual(["Bob", "25"]);
    });

    it("handles table with leading/trailing pipes", () => {
      const md = "| H1 | H2 |\n| --- | --- |\n| v1 | v2 |";
      const block = firstBlock(md);
      expect(block.type).toBe("table");
      expect(block.headers).toEqual(["H1", "H2"]);
    });
  });

  describe("lists", () => {
    it("parses unordered list with dashes", () => {
      const md = "- item1\n- item2";
      const block = firstBlock(md);
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(false);
      expect(block.items).toHaveLength(2);
      expect(block.items![0].spans[0].text).toBe("item1");
      expect(block.items![1].spans[0].text).toBe("item2");
    });

    it("parses unordered list with asterisks", () => {
      const md = "* item1\n* item2";
      const block = firstBlock(md);
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(false);
    });

    it("parses ordered list", () => {
      const md = "1. first\n2. second";
      const block = firstBlock(md);
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(true);
      expect(block.items).toHaveLength(2);
      expect(block.items![0].spans[0].text).toBe("first");
      expect(block.items![1].spans[0].text).toBe("second");
    });

    it("parses inline formatting in list items", () => {
      const md = "- **bold** item\n- *italic* item";
      const block = firstBlock(md);
      expect(block.type).toBe("list");
      expect(block.items![0].spans[0].type).toBe("bold");
      expect(block.items![0].spans[0].text).toBe("bold");
    });

    it("parses ordered list with indented continuation lines as single block", () => {
      const md = "1. First item\n   continuation text\n2. Second item\n   more text";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      const block = ir.blocks[0];
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(true);
      expect(block.items).toHaveLength(2);
      // Verify continuation text is included
      const item1Text = block.items![0].spans.map((s) => s.text).join("");
      expect(item1Text).toContain("continuation text");
      const item2Text = block.items![1].spans.map((s) => s.text).join("");
      expect(item2Text).toContain("more text");
    });

    it("parses ordered list items separated by blank lines (loose list)", () => {
      const md = "1. First\n\n2. Second\n\n3. Third";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      const block = ir.blocks[0];
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(true);
      expect(block.items).toHaveLength(3);
      expect(block.items![0].spans[0].text).toBe("First");
      expect(block.items![1].spans[0].text).toBe("Second");
      expect(block.items![2].spans[0].text).toBe("Third");
    });

    it("parses unordered list with indented continuation lines as single block", () => {
      const md = "- First item\n  continuation\n- Second item\n  more text";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      const block = ir.blocks[0];
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(false);
      expect(block.items).toHaveLength(2);
      const item1Text = block.items![0].spans.map((s) => s.text).join("");
      expect(item1Text).toContain("continuation");
    });

    it("parses unordered list items separated by blank lines (loose list)", () => {
      const md = "- Alpha\n\n- Beta\n\n- Gamma";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      const block = ir.blocks[0];
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(false);
      expect(block.items).toHaveLength(3);
    });

    it("parses real-world numbered items with bold headers + continuation + blank separators", () => {
      const md = [
        "1. **What kind of creature am I?**",
        "   Examples: AI assistant, machine ghost",
        "",
        "2. **What's my vibe?**",
        "   Examples: curious, playful",
        "",
        "3. **What do I sound like?**",
        "   Examples: poetic, casual",
      ].join("\n");
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks).toHaveLength(1);
      const block = ir.blocks[0];
      expect(block.type).toBe("list");
      expect(block.ordered).toBe(true);
      expect(block.items).toHaveLength(3);
      // Verify bold formatting is preserved in items
      expect(block.items![0].spans[0].type).toBe("bold");
      expect(block.items![0].spans[0].text).toBe("What kind of creature am I?");
    });

    it("terminates list when non-list paragraph appears between items", () => {
      const md = "1. First\n2. Second\n3. Third\n\nAnd one important bit:\n\n4. Fourth";
      const ir = parseMarkdownToIR(md);
      // Items 1-3 should be in one list, paragraph breaks it, item 4 in new list
      expect(ir.blocks.length).toBeGreaterThanOrEqual(3);
      const firstList = ir.blocks[0];
      expect(firstList.type).toBe("list");
      expect(firstList.ordered).toBe(true);
      expect(firstList.items).toHaveLength(3);
      // The paragraph
      const para = ir.blocks.find((b) => b.type === "paragraph");
      expect(para).toBeDefined();
      expect(para!.spans[0].text).toContain("And one important bit:");
      // Second list
      const secondList = ir.blocks.find((b, idx) => b.type === "list" && idx > 0);
      expect(secondList).toBeDefined();
      expect(secondList!.items).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Inline span parsing
  // ---------------------------------------------------------------------------

  describe("inline spans", () => {
    it("parses bold with double asterisks", () => {
      const spans = firstBlockSpans("Hello **world**");
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({ type: "text", text: "Hello " });
      expect(spans[1]).toMatchObject({ type: "bold", text: "world" });
    });

    it("parses bold with double underscores", () => {
      const spans = firstBlockSpans("Hello __world__");
      expect(spans).toHaveLength(2);
      expect(spans[1]).toMatchObject({ type: "bold", text: "world" });
    });

    it("parses italic with single asterisk", () => {
      const spans = firstBlockSpans("Hello *world*");
      expect(spans).toHaveLength(2);
      expect(spans[1]).toMatchObject({ type: "italic", text: "world" });
    });

    it("parses italic with single underscore", () => {
      const spans = firstBlockSpans("Hello _world_");
      expect(spans).toHaveLength(2);
      expect(spans[1]).toMatchObject({ type: "italic", text: "world" });
    });

    it("parses inline code", () => {
      const spans = firstBlockSpans("Use `console.log`");
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({ type: "text", text: "Use " });
      expect(spans[1]).toMatchObject({ type: "code", text: "console.log" });
    });

    it("parses strikethrough", () => {
      const spans = firstBlockSpans("~~deleted~~ text");
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({ type: "strikethrough", text: "deleted" });
      expect(spans[1]).toMatchObject({ type: "text", text: " text" });
    });

    it("parses links", () => {
      const spans = firstBlockSpans("[click](https://example.com)");
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        type: "link",
        text: "click",
        url: "https://example.com",
      });
    });

    it("parses mixed inline formatting", () => {
      const spans = firstBlockSpans("Hello *world* and **bold**");
      expect(spans).toHaveLength(4);
      expect(spans[0]).toMatchObject({ type: "text", text: "Hello " });
      expect(spans[1]).toMatchObject({ type: "italic", text: "world" });
      expect(spans[2]).toMatchObject({ type: "text", text: " and " });
      expect(spans[3]).toMatchObject({ type: "bold", text: "bold" });
    });
  });

  // ---------------------------------------------------------------------------
  // UTF-16 offsets
  // ---------------------------------------------------------------------------

  describe("UTF-16 offsets", () => {
    it("computes correct offsets for plain text", () => {
      const spans = firstBlockSpans("Hello **world**");
      expect(spans[0]).toMatchObject({ offset: 0, length: 6 }); // "Hello "
      expect(spans[1]).toMatchObject({ offset: 6, length: 5 }); // "world"
    });

    it("handles emoji surrogate pairs", () => {
      // \u{1F600} is a surrogate pair (2 UTF-16 code units)
      const spans = firstBlockSpans("\u{1F600} **bold**");
      // Plain text: "\u{1F600} bold"
      expect(spans[0]).toMatchObject({ type: "text", text: "\u{1F600} " });
      expect(spans[0].length).toBe(3); // 2 (surrogate pair) + 1 (space)
      expect(spans[1]).toMatchObject({ type: "bold", text: "bold", offset: 3 });
    });

    it("computes sourceLength from original Markdown", () => {
      const md = "Hello **world**";
      const ir = parseMarkdownToIR(md);
      expect(ir.sourceLength).toBe(md.length);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty string", () => {
      const ir = parseMarkdownToIR("");
      expect(ir.blocks).toHaveLength(0);
      expect(ir.sourceLength).toBe(0);
    });

    it("handles multiple blank lines", () => {
      const ir = parseMarkdownToIR("\n\n\n");
      expect(ir.blocks).toHaveLength(0);
    });

    it("preserves multiline code block content", () => {
      const md = "```\nline1\nline2\nline3\n```";
      const block = firstBlock(md);
      expect(block.raw).toBe("line1\nline2\nline3");
    });

    it("handles code block immediately after paragraph", () => {
      const md = "Text\n```\ncode\n```";
      const ir = parseMarkdownToIR(md);
      expect(ir.blocks.length).toBeGreaterThanOrEqual(2);
      const codeBlock = ir.blocks.find((b) => b.type === "code_block");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.raw).toBe("code");
    });
  });
});
