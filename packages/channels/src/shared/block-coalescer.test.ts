// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { inferBlockType, coalesceBlocks } from "./block-coalescer.js";
import type { CoalescerConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// inferBlockType tests
// ---------------------------------------------------------------------------

describe("inferBlockType", () => {
  it("detects code blocks starting with triple backticks", () => {
    expect(inferBlockType("```ts\nconst x = 1;\n```")).toBe("code");
  });

  it("detects code blocks starting with <pre>", () => {
    expect(inferBlockType("<pre>const x = 1;</pre>")).toBe("code");
  });

  it("detects headings starting with #", () => {
    expect(inferBlockType("## Section Title")).toBe("heading");
  });

  it("detects Telegram bold headings (single-line <b>)", () => {
    expect(inferBlockType("<b>Section</b>")).toBe("heading");
  });

  it("does not detect multi-line bold as heading", () => {
    expect(inferBlockType("<b>First line\nSecond line</b>")).toBe("prose");
  });

  it("detects tables with pipe syntax", () => {
    expect(inferBlockType("| Col1 | Col2 |\n|---|---|\n| a | b |")).toBe("table");
  });

  it("defaults to prose for regular text", () => {
    expect(inferBlockType("Hello world")).toBe("prose");
  });

  it("uses explicit blockType hint when provided", () => {
    expect(inferBlockType("anything", "code")).toBe("code");
    expect(inferBlockType("anything", "heading")).toBe("heading");
    expect(inferBlockType("anything", "table")).toBe("table");
    expect(inferBlockType("anything", "prose")).toBe("prose");
  });

  it("defaults to prose for unknown blockType hint", () => {
    expect(inferBlockType("anything", "unknown")).toBe("prose");
  });
});

// ---------------------------------------------------------------------------
// coalesceBlocks tests
// ---------------------------------------------------------------------------

describe("coalesceBlocks", () => {
  const defaultConfig: CoalescerConfig = {
    minChars: 0,
    maxChars: 500,
    idleMs: 1500,
    codeBlockPolicy: "standalone",
    adaptiveIdle: false,
  };

  it("returns empty for empty input", () => {
    const result = coalesceBlocks([], defaultConfig);
    expect(result).toEqual({ groups: [], flushEvents: [] });
  });

  it("returns single block unchanged", () => {
    const result = coalesceBlocks(["Hello world"], defaultConfig);
    expect(result.groups).toEqual(["Hello world"]);
    expect(result.flushEvents).toHaveLength(1);
    expect(result.flushEvents[0].trigger).toBe("end_of_response");
  });

  it("coalesces small prose blocks into one group", () => {
    const result = coalesceBlocks(
      ["First paragraph.", "Second paragraph.", "Third paragraph."],
      defaultConfig,
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toBe("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
    expect(result.flushEvents[0].trigger).toBe("end_of_response");
    expect(result.flushEvents[0].blockCount).toBe(3);
  });

  it("flushes on maxChars exceeded", () => {
    const config: CoalescerConfig = { ...defaultConfig, maxChars: 30 };
    const result = coalesceBlocks(
      [
        "This is block one here.", // 23 chars
        "This is block two here.", // 23 chars, total with joiner > 30
        "This is block three.",    // 20 chars
      ],
      config,
    );
    // First block alone (23 chars), second block alone would trigger size flush
    // then remaining accumulated with end_of_response
    expect(result.groups.length).toBeGreaterThanOrEqual(2);
    const sizeTriggers = result.flushEvents.filter(e => e.trigger === "size");
    expect(sizeTriggers.length).toBeGreaterThanOrEqual(1);
  });

  it("code blocks are standalone when policy is standalone", () => {
    const result = coalesceBlocks(
      ["Some prose text.", "```js\nconst x = 1;\n```", "More prose text."],
      defaultConfig,
    );
    expect(result.groups).toHaveLength(3);
    expect(result.groups[0]).toBe("Some prose text.");
    expect(result.groups[1]).toBe("```js\nconst x = 1;\n```");
    expect(result.groups[2]).toBe("More prose text.");
  });

  it("code blocks coalesce when policy is coalesce", () => {
    const config: CoalescerConfig = { ...defaultConfig, codeBlockPolicy: "coalesce" };
    const result = coalesceBlocks(
      ["Some prose text.", "```js\nconst x = 1;\n```", "More prose text."],
      config,
    );
    // All three should be coalesced into one group since code is treated as prose
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toContain("Some prose text.");
    expect(result.groups[0]).toContain("```js\nconst x = 1;\n```");
    expect(result.groups[0]).toContain("More prose text.");
  });

  it("headings start new coalesce windows", () => {
    const result = coalesceBlocks(
      ["Some prose text.", "## Heading", "More prose text."],
      defaultConfig,
    );
    // prose flushed before heading, heading standalone, remaining prose
    expect(result.groups).toHaveLength(3);
    expect(result.groups[0]).toBe("Some prose text.");
    expect(result.groups[1]).toBe("## Heading");
    expect(result.groups[2]).toBe("More prose text.");
  });

  it("tables are standalone", () => {
    const table = "| Col1 | Col2 |\n|---|---|\n| a | b |";
    const result = coalesceBlocks(
      ["Before table.", table, "After table."],
      defaultConfig,
    );
    expect(result.groups).toHaveLength(3);
    expect(result.groups[0]).toBe("Before table.");
    expect(result.groups[1]).toBe(table);
    expect(result.groups[2]).toBe("After table.");
  });

  it("end of response flushes remaining buffer", () => {
    const result = coalesceBlocks(
      ["First.", "Second.", "Third."],
      defaultConfig,
    );
    const lastEvent = result.flushEvents[result.flushEvents.length - 1];
    expect(lastEvent.trigger).toBe("end_of_response");
  });

  it("flush events contain correct blockCount and charCount", () => {
    const result = coalesceBlocks(
      ["Hello", "World"],
      defaultConfig,
    );
    expect(result.flushEvents).toHaveLength(1);
    expect(result.flushEvents[0].blockCount).toBe(2);
    // "Hello\n\nWorld" = 5 + 2 + 5 = 12
    expect(result.flushEvents[0].charCount).toBe(12);
  });

  it("mixed content produces correct group sequence", () => {
    const result = coalesceBlocks(
      [
        "Some prose.",                      // prose
        "```js\ncode();\n```",              // code (standalone)
        "More prose.",                      // prose
        "## Section",                       // heading
        "Final prose.",                     // prose
      ],
      defaultConfig,
    );
    expect(result.groups).toHaveLength(5);
    expect(result.groups[0]).toBe("Some prose.");
    expect(result.groups[1]).toBe("```js\ncode();\n```");
    expect(result.groups[2]).toBe("More prose.");
    expect(result.groups[3]).toBe("## Section");
    expect(result.groups[4]).toBe("Final prose.");

    // Verify triggers: boundary for prose-before-code, boundary for code, boundary for prose-before-heading,
    // boundary for heading, end_of_response for final prose
    expect(result.flushEvents[0].trigger).toBe("boundary"); // prose flushed before code
    expect(result.flushEvents[1].trigger).toBe("boundary"); // code standalone
    expect(result.flushEvents[2].trigger).toBe("boundary"); // prose flushed before heading
    expect(result.flushEvents[3].trigger).toBe("boundary"); // heading standalone
    expect(result.flushEvents[4].trigger).toBe("end_of_response"); // final prose
  });
});
