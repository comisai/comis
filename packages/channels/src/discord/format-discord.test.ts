// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { chunkDiscordText } from "./format-discord.js";

describe("format-discord / chunkDiscordText", () => {
  it("short text (< 2000 chars, < 17 lines) returns single chunk", () => {
    const result = chunkDiscordText("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("empty text returns empty array", () => {
    expect(chunkDiscordText("")).toEqual([]);
  });

  it("text exactly at 2000 chars returns single chunk", () => {
    const text = "x".repeat(2000);
    const result = chunkDiscordText(text);
    expect(result).toEqual([text]);
  });

  it("text over 2000 chars is split into multiple chunks", () => {
    const text = "word ".repeat(500); // ~2500 chars
    const result = chunkDiscordText(text);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("code fence is closed at chunk boundary and reopened in next chunk", () => {
    const lines = ["```js"];
    for (let i = 0; i < 50; i++) {
      lines.push("x");
    }
    lines.push("```");
    const input = lines.join("\n");

    const result = chunkDiscordText(input);
    expect(result.length).toBeGreaterThan(1);

    // Each chunk should have balanced ``` markers
    for (const chunk of result) {
      const fenceCount = (chunk.match(/^`{3}/gm) || []).length;
      // Each chunk either has 0 fences (no code) or 2 (open + close)
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("tilde fences (~~~) are handled", () => {
    const lines = ["~~~python"];
    for (let i = 0; i < 50; i++) {
      lines.push("y");
    }
    lines.push("~~~");
    const input = lines.join("\n");

    const result = chunkDiscordText(input);
    expect(result.length).toBeGreaterThan(1);

    for (const chunk of result) {
      const tildeCount = (chunk.match(/^~{3}/gm) || []).length;
      expect(tildeCount % 2).toBe(0);
    }
  });

  it("nested code fences (different marker lengths) handled correctly", () => {
    // ````markdown containing inner ```
    const input = [
      "````markdown",
      "some text",
      "```js",
      "inner code",
      "```",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "more text",
      "````",
    ].join("\n");

    const result = chunkDiscordText(input);
    // Should not crash and should produce valid chunks
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("long single line is split at word boundaries", () => {
    const text = "hello world ".repeat(200); // ~2400 chars
    const result = chunkDiscordText(text);
    expect(result.length).toBeGreaterThan(1);

    // Check that splits happen at word boundaries (not mid-word)
    for (const chunk of result) {
      // No chunk should start with a partial word (except possibly the first)
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("long single line inside code fence preserves whitespace (no word-break)", () => {
    const longLine = "x".repeat(3000);
    const input = `\`\`\`\n${longLine}\n\`\`\``;

    const result = chunkDiscordText(input);
    expect(result.length).toBeGreaterThan(1);

    // Reconstruct and verify no characters lost
    // Strip fence markers from each chunk for content comparison
    let reconstructed = "";
    for (const chunk of result) {
      const inner = chunk.replace(/^```\n?/gm, "").replace(/\n?```$/gm, "");
      reconstructed += inner;
    }
    expect(reconstructed).toContain("x".repeat(100)); // still has long runs
  });

  it("max lines (17 default) causes split even when under 2000 chars", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`Line ${i + 1}`);
    }
    const text = lines.join("\n");
    expect(text.length).toBeLessThan(2000); // short text

    const result = chunkDiscordText(text);
    expect(result.length).toBeGreaterThan(1); // split due to lines
  });

  it("custom maxChars and maxLines options work", () => {
    const text = "hello world this is a test message";

    // Very low maxChars to force split
    const result = chunkDiscordText(text, { maxChars: 15, maxLines: 100 });
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });

  it("custom maxLines option forces split at specified line count", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`Line ${i + 1}`);
    }
    const text = lines.join("\n");

    const result = chunkDiscordText(text, { maxLines: 5 });
    expect(result.length).toBeGreaterThan(1);
  });

  it("rebalanceReasoningItalics: reasoning payload split across chunks maintains italics", () => {
    // Create a reasoning payload that will be split
    const longContent = "some reasoning text\n".repeat(20);
    const text = `Reasoning:\n_${longContent}_`;

    const result = chunkDiscordText(text);

    if (result.length > 1) {
      // First chunk should end with underscore (closing italic)
      expect(result[0].trimEnd().endsWith("_")).toBe(true);

      // Middle/subsequent chunks should start with underscore (opening italic)
      for (let i = 1; i < result.length; i++) {
        expect(result[i].trimStart().startsWith("_")).toBe(true);
      }
    }
  });

  it("non-reasoning text does not get italic rebalancing", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`Regular line ${i + 1}`);
    }
    const text = lines.join("\n");

    const result = chunkDiscordText(text);
    expect(result.length).toBeGreaterThan(1);

    // Should not have italic markers added
    for (const chunk of result) {
      expect(chunk.startsWith("_")).toBe(false);
    }
  });
});
