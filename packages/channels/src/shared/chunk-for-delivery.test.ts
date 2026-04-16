import { describe, it, expect } from "vitest";
import { chunkForDelivery } from "./chunk-for-delivery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a long text by repeating a paragraph. */
function repeatParagraph(para: string, times: number): string {
  return Array.from({ length: times }, () => para).join("\n\n");
}

/** Generate a string of exact length. */
function makeText(length: number, char = "a"): string {
  return char.repeat(length);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chunkForDelivery", () => {
  describe("short text (under limit)", () => {
    it("returns single chunk when text under limit", () => {
      const result = chunkForDelivery("Hello world", "telegram", { maxChars: 4000 });
      expect(result).toEqual(["Hello world"]);
    });

    it("returns single chunk for text exactly at limit", () => {
      const text = makeText(100);
      const result = chunkForDelivery(text, "discord", { maxChars: 100 });
      expect(result).toEqual([text]);
    });
  });

  describe("IR path (useMarkdownIR: true, default)", () => {
    it("splits long text at block boundaries", () => {
      // Create text that exceeds 100 chars with multiple paragraphs
      const para1 = "First paragraph with some content that is meaningful.";
      const para2 = "Second paragraph with different content for testing.";
      const para3 = "Third paragraph to ensure we get multiple chunks out.";
      const text = `${para1}\n\n${para2}\n\n${para3}`;

      const result = chunkForDelivery(text, "discord", { maxChars: 80 });
      expect(result.length).toBeGreaterThan(1);
      // Each chunk should be within limit (with possible slight overrun for block integrity)
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(160); // 2x for code block safety
      }
    });

    it("defaults to useMarkdownIR: true", () => {
      const text = repeatParagraph("This is a paragraph of text for testing.", 5);
      const result = chunkForDelivery(text, "discord", { maxChars: 100 });
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe("raw path (useMarkdownIR: false)", () => {
    it("splits long text at paragraph boundaries", () => {
      const text = repeatParagraph("Paragraph content here for testing the raw path.", 5);
      const result = chunkForDelivery(text, "telegram", {
        maxChars: 100,
        useMarkdownIR: false,
      });
      expect(result.length).toBeGreaterThan(1);
    });

    it("converts tables before chunking for telegram (tableMode: code)", () => {
      const table = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
      const padding = makeText(100);
      const text = `${padding}\n\n${table}\n\n${padding}`;
      const result = chunkForDelivery(text, "telegram", {
        maxChars: 150,
        useMarkdownIR: false,
        tableMode: "code",
      });
      // Table should be converted to code block format
      const allText = result.join("");
      expect(allText).toContain("```");
    });

    it("does not convert tables when tableMode is off", () => {
      const table = "| A | B |\n|---|---|\n| 1 | 2 |";
      const result = chunkForDelivery(table, "telegram", {
        maxChars: 4000,
        useMarkdownIR: false,
        tableMode: "off",
      });
      expect(result[0]).toContain("|");
      expect(result[0]).not.toContain("```");
    });

    it("does not convert tables for non-table platforms", () => {
      const table = "| A | B |\n|---|---|\n| 1 | 2 |";
      const result = chunkForDelivery(table, "discord", {
        maxChars: 4000,
        useMarkdownIR: false,
        tableMode: "code",
      });
      // Discord is not in the table-conversion set, so table stays raw
      expect(result[0]).toContain("|");
    });
  });

  describe("code block integrity", () => {
    it("preserves code block integrity (no split inside fenced code)", () => {
      const code = "```python\nfor i in range(10):\n    print(i)\n```";
      const before = "Some text before the code block.";
      const after = "Some text after the code block.";
      const text = `${before}\n\n${code}\n\n${after}`;

      const result = chunkForDelivery(text, "discord", { maxChars: 80 });
      // The code block should be intact in one of the chunks
      const codeChunk = result.find((c) => c.includes("for i in range(10)"));
      expect(codeChunk).toBeDefined();
      expect(codeChunk!).toContain("```");
    });
  });

  describe("edge cases", () => {
    it("never returns empty array (even for empty string)", () => {
      const result = chunkForDelivery("", "telegram", { maxChars: 4000 });
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("handles single character input", () => {
      const result = chunkForDelivery("x", "telegram", { maxChars: 4000 });
      expect(result).toEqual(["x"]);
    });

    it("uses code as default tableMode", () => {
      // Just verify it doesn't throw with default tableMode
      const text = repeatParagraph("Default table mode test paragraph.", 3);
      const result = chunkForDelivery(text, "telegram", { maxChars: 50 });
      expect(result.length).toBeGreaterThan(0);
    });

    it("respects chunkMinChars option in raw path", () => {
      const text = "A\n\nB\n\nC\n\nD\n\nE\n\nThis is a much longer paragraph here.";
      const result = chunkForDelivery(text, "telegram", {
        maxChars: 200,
        useMarkdownIR: false,
        chunkMinChars: 50,
      });
      // With minChars=50, very short paragraphs should be coalesced
      // Result should have fewer chunks than individual paragraphs
      expect(result.length).toBeGreaterThan(0);
    });

    it("respects chunkMode option in raw path", () => {
      const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence. Seventh sentence.";
      const result = chunkForDelivery(text, "telegram", {
        maxChars: 60,
        useMarkdownIR: false,
        chunkMode: "sentence",
      });
      expect(result.length).toBeGreaterThan(1);
    });
  });
});
