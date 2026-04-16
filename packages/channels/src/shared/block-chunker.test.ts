import { describe, expect, it } from "vitest";
import { chunkBlocks } from "./block-chunker.js";
import type { ChunkOptions } from "./block-chunker.js";

describe("chunkBlocks", () => {
  it("returns single block for short text", () => {
    const result = chunkBlocks("Hello world", {
      mode: "paragraph",
      maxChars: 2000,
    });
    expect(result).toEqual(["Hello world"]);
  });

  it("splits at paragraph boundaries", () => {
    const text = "Para 1\n\nPara 2\n\nPara 3";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 10,
      minChars: 1,
    });
    expect(result).toEqual(["Para 1", "Para 2", "Para 3"]);
  });

  it("splits at newline boundaries", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const result = chunkBlocks(text, {
      mode: "newline",
      maxChars: 10,
      minChars: 1,
    });
    expect(result).toEqual(["Line 1", "Line 2", "Line 3"]);
  });

  it("splits at sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third.";
    const result = chunkBlocks(text, {
      mode: "sentence",
      maxChars: 20,
      minChars: 1,
    });
    // Each sentence should be its own block
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toContain("First sentence.");
  });

  it("preserves code fences — never splits inside a fenced code block", () => {
    const text =
      "Before\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 200,
      minChars: 1,
    });

    // Verify the code fence is kept intact in one block
    const fenceBlock = result.find((b) => b.includes("```js"));
    expect(fenceBlock).toBeDefined();
    expect(fenceBlock).toContain("const a = 1;");
    expect(fenceBlock).toContain("const b = 2;");
    expect(fenceBlock).toContain("```");
  });

  it("handles unclosed code fences — extends to end of text", () => {
    const text = "Before\n\n```js\nconst a = 1;\n\nconst b = 2;";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 200,
      minChars: 1,
    });

    // The unclosed fence should not be split
    const fenceBlock = result.find((b) => b.includes("```js"));
    expect(fenceBlock).toBeDefined();
    expect(fenceBlock).toContain("const a = 1;");
    expect(fenceBlock).toContain("const b = 2;");
  });

  it("handles tilde code fences the same as backtick fences", () => {
    const text = "Before\n\n~~~py\nprint('hello')\n\nprint('world')\n~~~\n\nAfter";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 200,
      minChars: 1,
    });

    const fenceBlock = result.find((b) => b.includes("~~~py"));
    expect(fenceBlock).toBeDefined();
    expect(fenceBlock).toContain("print('hello')");
    expect(fenceBlock).toContain("print('world')");
  });

  it("enforces maxChars by sub-splitting oversized blocks at word boundaries", () => {
    // Create a single paragraph that is 5000+ chars
    const longWord = "word ";
    const longText = longWord.repeat(1000); // 5000 chars
    const result = chunkBlocks(longText, {
      mode: "paragraph",
      maxChars: 2000,
    });

    expect(result.length).toBeGreaterThan(1);
    for (const block of result) {
      expect(block.length).toBeLessThanOrEqual(2000);
    }
  });

  it("respects minChars — short blocks below threshold are not split from next", () => {
    // With a high minChars, very short blocks should be merged
    const text = "Hi\n\nThis is a much longer paragraph that should be its own block.";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 200,
      minChars: 200,
    });

    // "Hi" alone is < 200 chars, so it should be merged with the next paragraph
    // or the whole text returned as one block
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("length mode splits purely on character count at word boundaries", () => {
    // Build text > 100 chars
    const text = "word ".repeat(30); // 150 chars
    const result = chunkBlocks(text, {
      mode: "length",
      maxChars: 100,
    });

    expect(result.length).toBeGreaterThan(1);
    for (const block of result) {
      expect(block.length).toBeLessThanOrEqual(100);
    }
  });

  it("returns original text if no splits found", () => {
    const text = "NoBoundariesHereAtAll";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 5000,
    });
    expect(result).toEqual([text]);
  });

  it("filters empty blocks from excessive newlines", () => {
    const text = "Hello\n\n\n\n\n\nWorld";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 10,
      minChars: 1,
    });

    // Should not contain empty or whitespace-only blocks
    for (const block of result) {
      expect(block.trim().length).toBeGreaterThan(0);
    }
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  it("accumulates small paragraphs into fewer blocks up to maxChars", () => {
    // 26 paragraphs of ~230 chars each = ~6000 chars total
    // With maxChars=4096, should produce 2 blocks, not 26
    const paragraphs = Array.from({ length: 26 }, (_, i) =>
      `Paragraph ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(8).trim()}`
    );
    const text = paragraphs.join("\n\n");

    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 4096,
    });

    // Should produce far fewer blocks than 26
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.length).toBeGreaterThanOrEqual(2);

    // Each block must respect maxChars
    for (const block of result) {
      expect(block.length).toBeLessThanOrEqual(4096);
    }

    // Joined with \n\n should reconstruct original text
    expect(result.join("\n\n")).toBe(text);
  });

  it("still splits individual paragraphs that exceed maxChars", () => {
    const shortPara = "Short paragraph.";
    const longPara = "word ".repeat(500).trim(); // ~2499 chars
    const text = `${shortPara}\n\n${longPara}`;

    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 200,
      minChars: 1,
    });

    // The long paragraph should be sub-split into multiple blocks
    expect(result.length).toBeGreaterThan(2);
    for (const block of result) {
      expect(block.length).toBeLessThanOrEqual(200);
    }
  });

  it("produces single block when all paragraphs fit within maxChars", () => {
    const text = "Para 1\n\nPara 2\n\nPara 3";
    const result = chunkBlocks(text, {
      mode: "paragraph",
      maxChars: 5000,
    });

    // Total text is small, should be returned as-is
    expect(result).toEqual([text]);
  });
});
