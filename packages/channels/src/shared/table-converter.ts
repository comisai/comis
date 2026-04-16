/**
 * Table Converter — Transforms IR table blocks to code blocks or bullet lists.
 *
 * Chat platforms generally lack native table rendering. This module provides
 * three conversion modes:
 * - `code`: Renders table as a monospace code block with aligned columns
 * - `bullets`: Renders each row as a bullet list with header-prefixed values
 * - `off`: Passthrough — returns the block unchanged
 *
 * @module
 */

import type { MarkdownBlock, MarkdownSpan } from "./markdown-ir.js";

/** Table conversion mode. */
export type TableMode = "code" | "bullets" | "off";

/**
 * Convert a table block to the specified display format.
 *
 * Non-table blocks are returned unchanged regardless of mode.
 *
 * @param block - The MarkdownBlock to convert (only `table` type is transformed)
 * @param mode - Conversion strategy: 'code', 'bullets', or 'off'
 * @returns A new MarkdownBlock (code_block or list) or the original block
 */
export function convertTable(block: MarkdownBlock, mode: TableMode): MarkdownBlock {
  // Non-table blocks pass through unchanged
  if (block.type !== "table") return block;

  // 'off' mode: passthrough
  if (mode === "off") return block;

  const headers = block.headers ?? [];
  const rows = block.rows ?? [];

  if (mode === "code") {
    return tableToCodeBlock(headers, rows);
  }

  // mode === "bullets"
  return tableToBulletList(headers, rows);
}

/**
 * Convert a table to a code block with aligned columns.
 *
 * Calculates max width per column, pads cells with spaces, and
 * adds a dash separator between header and body rows.
 */
function tableToCodeBlock(headers: string[], rows: string[][]): MarkdownBlock {
  // Handle empty table (no headers, no rows)
  if (headers.length === 0 && rows.length === 0) {
    return {
      type: "code_block",
      spans: [],
      raw: "",
    };
  }

  const colCount = headers.length;

  // Calculate column widths from headers + all rows
  const widths: number[] = headers.map((h) => h.length);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      widths[c] = Math.max(widths[c] ?? 0, cell.length);
    }
  }

  // Pad a cell to column width
  const pad = (text: string, colIdx: number): string => {
    const w = widths[colIdx] ?? 0;
    return text.padEnd(w);
  };

  // Build lines
  const lines: string[] = [];

  // Header row
  const headerLine = headers.map((h, i) => pad(h, i)).join("  ");
  lines.push(headerLine);

  // Separator row (dashes matching column widths)
  const sepLine = widths.map((w) => "-".repeat(w)).join("  ");
  lines.push(sepLine);

  // Body rows
  for (const row of rows) {
    const rowLine = headers.map((_, i) => pad(row[i] ?? "", i)).join("  ");
    lines.push(rowLine);
  }

  return {
    type: "code_block",
    spans: [],
    raw: lines.join("\n"),
  };
}

/**
 * Convert a table to a bullet list.
 *
 * Each body row becomes a list item. Within each item, columns are
 * formatted as `**HeaderName:** cellValue` and separated by `, `.
 */
function tableToBulletList(headers: string[], rows: string[][]): MarkdownBlock {
  // Handle empty table
  if (headers.length === 0 && rows.length === 0) {
    return {
      type: "list",
      spans: [],
      items: [],
      ordered: false,
    };
  }

  const items: MarkdownBlock[] = rows.map((row) => {
    // Parse as a paragraph sub-block with inline spans
    // The bold markers will be parsed by consumers; we store raw text as spans
    const spans: MarkdownSpan[] = [];
    let offset = 0;

    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      const cell = row[i] ?? "";

      // Bold span for header name + colon
      spans.push({
        type: "bold",
        text: `${header}:`,
        offset,
        length: header.length + 1,
      });
      offset += header.length + 1;

      // Text span for cell value
      const cellText = ` ${cell}`;
      const suffix = i < headers.length - 1 ? ", " : "";
      spans.push({
        type: "text",
        text: cellText + suffix,
        offset,
        length: cellText.length + suffix.length,
      });
      offset += cellText.length + suffix.length;
    }

    return {
      type: "paragraph" as const,
      spans,
    };
  });

  return {
    type: "list",
    spans: [],
    items,
    ordered: false,
  };
}
