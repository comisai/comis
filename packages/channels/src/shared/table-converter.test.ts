import { describe, it, expect } from "vitest";
import { convertTable } from "./table-converter.js";
import type { MarkdownBlock } from "./markdown-ir.js";

// ---------------------------------------------------------------------------
// Helper: create a table block
// ---------------------------------------------------------------------------

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

describe("convertTable", () => {
  // -------------------------------------------------------------------------
  // 'code' mode
  // -------------------------------------------------------------------------

  describe("code mode", () => {
    it("produces aligned code block with header separator", () => {
      const table = makeTable(
        ["Name", "Age", "City"],
        [
          ["Alice", "30", "Portland"],
          ["Bob", "25", "Seattle"],
        ],
      );

      const result = convertTable(table, "code");

      expect(result.type).toBe("code_block");
      const lines = (result.raw ?? "").split("\n");
      // Header line
      expect(lines[0]).toContain("Name");
      expect(lines[0]).toContain("Age");
      expect(lines[0]).toContain("City");
      // Separator line (dashes)
      expect(lines[1]).toMatch(/^-+\s+-+\s+-+$/);
      // Body rows
      expect(lines[2]).toContain("Alice");
      expect(lines[2]).toContain("30");
      expect(lines[2]).toContain("Portland");
      expect(lines[3]).toContain("Bob");
      expect(lines[3]).toContain("25");
      expect(lines[3]).toContain("Seattle");
    });

    it("aligns columns to widest content", () => {
      const table = makeTable(
        ["X", "LongHeader"],
        [["ShortValue", "Y"]],
      );

      const result = convertTable(table, "code");
      const lines = (result.raw ?? "").split("\n");

      // Header "X" should be padded to match "ShortValue" width (10 chars)
      // Header line: "X          LongHeader" (X padded to 10)
      expect(lines[0]).toMatch(/^X\s+LongHeader/);
      // Body line: "ShortValue  Y" (ShortValue is already 10 chars)
      expect(lines[2]).toMatch(/^ShortValue\s+Y/);
      // Column 1 occupies same width in both lines (X padded to 10 = ShortValue length)
      const col1Header = lines[0].slice(0, 10);
      expect(col1Header.trim()).toBe("X");
      expect(col1Header.length).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // 'bullets' mode
  // -------------------------------------------------------------------------

  describe("bullets mode", () => {
    it("produces header-prefixed bullet list", () => {
      const table = makeTable(
        ["Name", "Age"],
        [
          ["Alice", "30"],
          ["Bob", "25"],
        ],
      );

      const result = convertTable(table, "bullets");

      expect(result.type).toBe("list");
      expect(result.ordered).toBe(false);
      expect(result.items).toHaveLength(2);

      // First item spans should contain bold header and text cell
      const firstItem = result.items![0];
      const boldSpans = firstItem.spans.filter((s) => s.type === "bold");
      expect(boldSpans.length).toBeGreaterThanOrEqual(2);
      expect(boldSpans[0].text).toBe("Name:");
      expect(boldSpans[1].text).toBe("Age:");

      // Text spans contain cell values
      const textSpans = firstItem.spans.filter((s) => s.type === "text");
      expect(textSpans.some((s) => s.text.includes("Alice"))).toBe(true);
      expect(textSpans.some((s) => s.text.includes("30"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 'off' mode
  // -------------------------------------------------------------------------

  describe("off mode", () => {
    it("returns block unchanged", () => {
      const table = makeTable(["A", "B"], [["1", "2"]]);
      const result = convertTable(table, "off");
      expect(result).toBe(table); // Same reference
    });
  });

  // -------------------------------------------------------------------------
  // Non-table blocks
  // -------------------------------------------------------------------------

  describe("non-table blocks", () => {
    it("returns non-table block unchanged regardless of mode", () => {
      const paragraph: MarkdownBlock = {
        type: "paragraph",
        spans: [{ type: "text", text: "Hello", offset: 0, length: 5 }],
      };

      expect(convertTable(paragraph, "code")).toBe(paragraph);
      expect(convertTable(paragraph, "bullets")).toBe(paragraph);
      expect(convertTable(paragraph, "off")).toBe(paragraph);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty table (0 rows, 0 headers)", () => {
      const table = makeTable([], []);

      const codeResult = convertTable(table, "code");
      expect(codeResult.type).toBe("code_block");
      expect(codeResult.raw).toBe("");

      const bulletResult = convertTable(table, "bullets");
      expect(bulletResult.type).toBe("list");
      expect(bulletResult.items).toHaveLength(0);
    });

    it("handles missing cells (pads with empty string)", () => {
      const table = makeTable(
        ["A", "B", "C"],
        [["1"]], // Row has fewer cells than headers
      );

      const result = convertTable(table, "code");
      const lines = (result.raw ?? "").split("\n");
      // Body row should have 3 columns even though row only has 1 value
      expect(lines[2]).toBeDefined();
      // The missing cells should be empty (padded)
      expect(lines.length).toBe(3); // header + separator + 1 body row
    });

    it("handles single-column table", () => {
      const table = makeTable(["ID"], [["1"], ["2"], ["3"]]);

      const codeResult = convertTable(table, "code");
      expect(codeResult.type).toBe("code_block");
      const lines = (codeResult.raw ?? "").split("\n");
      expect(lines.length).toBe(5); // header + sep + 3 body rows

      const bulletResult = convertTable(table, "bullets");
      expect(bulletResult.items).toHaveLength(3);
    });

    it("handles headers with no body rows", () => {
      const table = makeTable(["A", "B"], []);

      const codeResult = convertTable(table, "code");
      const lines = (codeResult.raw ?? "").split("\n");
      expect(lines.length).toBe(2); // header + separator only

      const bulletResult = convertTable(table, "bullets");
      expect(bulletResult.items).toHaveLength(0);
    });
  });
});
