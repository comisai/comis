// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for raw markdown table-to-bullets/code converter.
 */
import { describe, it, expect } from "vitest";
import { convertMarkdownTables } from "./markdown-tables.js";

// ---------------------------------------------------------------------------
// Basic conversions
// ---------------------------------------------------------------------------

describe("convertMarkdownTables", () => {
  const basicTable = [
    "| Name | Age | City |",
    "| --- | --- | --- |",
    "| Alice | 30 | NYC |",
    "| Bob | 25 | LA |",
  ].join("\n");

  it("converts a 3-column table to bullets", () => {
    const result = convertMarkdownTables(basicTable, "bullets");
    expect(result).toBe(
      [
        "- **Name:** Alice, **Age:** 30, **City:** NYC",
        "- **Name:** Bob, **Age:** 25, **City:** LA",
      ].join("\n"),
    );
  });

  it("converts a table to code block", () => {
    const result = convertMarkdownTables(basicTable, "code");
    expect(result).toContain("```");
    expect(result).toContain("Name");
    expect(result).toContain("Alice");
    // Should have aligned columns
    expect(result).toContain("---");
  });

  it("off mode passes through unchanged", () => {
    const result = convertMarkdownTables(basicTable, "off");
    expect(result).toBe(basicTable);
  });

  // ---------------------------------------------------------------------------
  // Multiple tables
  // ---------------------------------------------------------------------------

  it("converts multiple tables in one response", () => {
    const text = [
      "First table:",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Second table:",
      "",
      "| X | Y |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");

    const result = convertMarkdownTables(text, "bullets");
    expect(result).toContain("- **A:** 1, **B:** 2");
    expect(result).toContain("- **X:** 3, **Y:** 4");
    expect(result).toContain("First table:");
    expect(result).toContain("Second table:");
  });

  // ---------------------------------------------------------------------------
  // Surrounding text preserved
  // ---------------------------------------------------------------------------

  it("preserves surrounding paragraphs", () => {
    const text = [
      "Here is some data:",
      "",
      "| Name | Score |",
      "| --- | --- |",
      "| Alice | 95 |",
      "",
      "That was the data.",
    ].join("\n");

    const result = convertMarkdownTables(text, "bullets");
    expect(result).toContain("Here is some data:");
    expect(result).toContain("That was the data.");
    expect(result).toContain("- **Name:** Alice, **Score:** 95");
    // Pipe syntax should be gone
    expect(result).not.toContain("| Name");
  });

  // ---------------------------------------------------------------------------
  // Code block protection
  // ---------------------------------------------------------------------------

  it("does NOT convert tables inside code blocks", () => {
    const text = [
      "Example:",
      "```",
      "| Name | Age |",
      "| --- | --- |",
      "| Alice | 30 |",
      "```",
    ].join("\n");

    const result = convertMarkdownTables(text, "bullets");
    // Table inside code block should remain unchanged
    expect(result).toContain("| Name | Age |");
    expect(result).toContain("| Alice | 30 |");
    expect(result).not.toContain("**Name:**");
  });

  // ---------------------------------------------------------------------------
  // Single-column table
  // ---------------------------------------------------------------------------

  it("converts single-column table", () => {
    const text = [
      "| Items |",
      "| --- |",
      "| Apple |",
      "| Banana |",
    ].join("\n");

    const result = convertMarkdownTables(text, "bullets");
    expect(result).toBe("- Apple\n- Banana");
  });

  // ---------------------------------------------------------------------------
  // Empty cells
  // ---------------------------------------------------------------------------

  it("handles empty cells", () => {
    const text = [
      "| Name | Note |",
      "| --- | --- |",
      "| Alice |  |",
      "| Bob | Good |",
    ].join("\n");

    const result = convertMarkdownTables(text, "bullets");
    expect(result).toContain("- **Name:** Alice, **Note:** ");
    expect(result).toContain("- **Name:** Bob, **Note:** Good");
  });

  // ---------------------------------------------------------------------------
  // Table with no body rows (headers only)
  // ---------------------------------------------------------------------------

  it("renders headers-only table as bold list", () => {
    const text = [
      "| Name | Age |",
      "| --- | --- |",
    ].join("\n");

    const result = convertMarkdownTables(text, "bullets");
    expect(result).toBe("- **Name**, **Age**");
  });

  // ---------------------------------------------------------------------------
  // No tables in text
  // ---------------------------------------------------------------------------

  it("returns text unchanged when no tables present", () => {
    const text = "Just some regular text.\n\nNo tables here.";
    const result = convertMarkdownTables(text, "bullets");
    expect(result).toBe(text);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("handles empty string", () => {
    expect(convertMarkdownTables("", "bullets")).toBe("");
  });

  it("handles table at start of text", () => {
    const text = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    const result = convertMarkdownTables(text, "bullets");
    expect(result).toBe("- **A:** 1, **B:** 2");
  });

  it("handles table at end of text with trailing content", () => {
    const text = [
      "Some text",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    const result = convertMarkdownTables(text, "bullets");
    expect(result).toContain("Some text");
    expect(result).toContain("- **A:** 1, **B:** 2");
  });

  it("handles table without leading/trailing pipes", () => {
    const text = [
      "A | B",
      "--- | ---",
      "1 | 2",
    ].join("\n");
    const result = convertMarkdownTables(text, "bullets");
    expect(result).toBe("- **A:** 1, **B:** 2");
  });

  it("code block conversion produces aligned columns", () => {
    const text = [
      "| Name | Score |",
      "| --- | --- |",
      "| Alice | 95 |",
      "| Bob | 100 |",
    ].join("\n");
    const result = convertMarkdownTables(text, "code");
    // Should be wrapped in backticks
    expect(result).toMatch(/^```\n/);
    expect(result).toMatch(/\n```$/);
    // Headers should be aligned
    const inner = result.replace(/^```\n/, "").replace(/\n```$/, "");
    const codeLines = inner.split("\n");
    expect(codeLines.length).toBe(4); // header + sep + 2 rows
    // All lines should have same structure
    expect(codeLines[0]).toContain("Name");
    expect(codeLines[0]).toContain("Score");
  });
});
