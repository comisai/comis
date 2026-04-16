import { describe, it, expect } from "vitest";
import { chunkIR } from "./ir-chunker.js";
import type { MarkdownIR, MarkdownBlock } from "./markdown-ir.js";
import { parseMarkdownToIR } from "./markdown-ir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIR(blocks: MarkdownBlock[]): MarkdownIR {
  return { blocks, sourceLength: 0 };
}

function makeParagraph(text: string): MarkdownBlock {
  return {
    type: "paragraph",
    spans: [{ type: "text", text, offset: 0, length: text.length }],
  };
}

function makeCodeBlock(raw: string, language?: string): MarkdownBlock {
  return {
    type: "code_block",
    spans: [],
    raw,
    language,
  };
}

function makeTable(headers: string[], rows: string[][]): MarkdownBlock {
  return {
    type: "table",
    spans: [],
    headers,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chunkIR", () => {
  const defaultOpts = { maxChars: 500, platform: "discord", tableMode: "off" as const };

  // -------------------------------------------------------------------------
  // Basic chunking
  // -------------------------------------------------------------------------

  it("small text fits in a single chunk", () => {
    const ir = makeIR([makeParagraph("Hello world")]);
    const chunks = chunkIR(ir, defaultOpts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello world");
  });

  it("multiple paragraphs split at block boundaries", () => {
    const para1 = "A".repeat(300);
    const para2 = "B".repeat(300);
    const ir = makeIR([makeParagraph(para1), makeParagraph(para2)]);

    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 400 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain first paragraph
    expect(chunks[0]).toContain("A".repeat(300));
    // Second chunk should contain second paragraph
    expect(chunks[1]).toContain("B".repeat(300));
  });

  // -------------------------------------------------------------------------
  // Code block atomicity
  // -------------------------------------------------------------------------

  it("code block treated as atomic unit when under 2x maxChars", () => {
    const code = "x = 1\ny = 2\nz = 3";
    const ir = makeIR([makeCodeBlock(code, "python")]);

    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 50 });

    // The rendered code block with fences is larger than 50 chars
    // but under 2x50=100, so it should stay as one chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("```python");
    expect(chunks[0]).toContain("x = 1");
    expect(chunks[0]).toContain("```");
  });

  it("large code block sub-split at newline boundaries with fence wrapping", () => {
    // Create a code block that exceeds 2x maxChars
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}: ${"x".repeat(20)}`);
    const raw = lines.join("\n");
    const ir = makeIR([makeCodeBlock(raw, "js")]);

    // maxChars = 200, code block will be >1000 chars (well over 2x200)
    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 200 });

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be wrapped in its own fence
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^```js\n/);
      expect(chunk).toMatch(/\n```$/);
    }
  });

  // -------------------------------------------------------------------------
  // Table conversion
  // -------------------------------------------------------------------------

  it("table converted to code block before chunking", () => {
    const ir = makeIR([
      makeTable(["Name", "Value"], [["foo", "1"], ["bar", "2"]]),
    ]);

    const chunks = chunkIR(ir, { ...defaultOpts, tableMode: "code" });

    expect(chunks).toHaveLength(1);
    // Should be rendered as a code block (from table conversion)
    expect(chunks[0]).toContain("```");
    expect(chunks[0]).toContain("Name");
    expect(chunks[0]).toContain("foo");
  });

  it("table converted to bullets before chunking", () => {
    const ir = makeIR([
      makeTable(["Name", "Value"], [["foo", "1"]]),
    ]);

    const chunks = chunkIR(ir, { ...defaultOpts, tableMode: "bullets" });

    expect(chunks).toHaveLength(1);
    // Should contain bullet-format text with bold headers
    expect(chunks[0]).toContain("Name:");
    expect(chunks[0]).toContain("foo");
  });

  // -------------------------------------------------------------------------
  // Surrogate pair safety
  // -------------------------------------------------------------------------

  it("surrogate pair boundary not split (emoji in test text)", () => {
    // Create text with emoji (surrogate pairs in UTF-16) that exceeds maxChars
    // Each emoji like a flag or complex emoji may use surrogate pairs
    const emojiText = "Hello \uD83D\uDE00 world! "; // "Hello [grin] world! "
    // Repeat to exceed maxChars
    const longText = emojiText.repeat(30);
    const ir = makeIR([makeParagraph(longText)]);

    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 100 });

    // Verify no chunk ends with a broken surrogate (high surrogate without low)
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        // High surrogate must be followed by low surrogate
        if (code >= 0xd800 && code <= 0xdbff) {
          expect(i + 1).toBeLessThan(chunk.length);
          const next = chunk.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // Formatting preservation
  // -------------------------------------------------------------------------

  it("formatting spans never broken across chunks", () => {
    // Create IR with bold formatting in paragraphs
    const ir = parseMarkdownToIR(
      "This is **bold text** here.\n\nAnother paragraph with **more bold** content.\n\nThird paragraph.",
    );

    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 60 });

    // Each chunk should have balanced Markdown formatting
    for (const chunk of chunks) {
      const boldOpens = (chunk.match(/\*\*/g) ?? []).length;
      // Bold markers come in pairs (open+close)
      expect(boldOpens % 2).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Empty IR
  // -------------------------------------------------------------------------

  it("empty IR returns single empty string", () => {
    const ir = makeIR([]);
    const chunks = chunkIR(ir, defaultOpts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("");
  });

  // -------------------------------------------------------------------------
  // Mixed content
  // -------------------------------------------------------------------------

  it("mixed blocks pack greedily until maxChars", () => {
    const ir = makeIR([
      makeParagraph("Short."),
      makeParagraph("Also short."),
      makeParagraph("Still short."),
    ]);

    // All three should fit in one chunk
    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Short.");
    expect(chunks[0]).toContain("Also short.");
    expect(chunks[0]).toContain("Still short.");
  });

  it("blocks joined with double newline separator within each chunk", () => {
    const ir = makeIR([
      makeParagraph("First"),
      makeParagraph("Second"),
    ]);

    const chunks = chunkIR(ir, defaultOpts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("First\n\nSecond");
  });

  // -------------------------------------------------------------------------
  // Never returns empty array
  // -------------------------------------------------------------------------

  it("never returns empty array for non-empty IR", () => {
    const ir = makeIR([makeParagraph("")]);
    const chunks = chunkIR(ir, { ...defaultOpts, maxChars: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
