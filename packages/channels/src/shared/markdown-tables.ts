/**
 * Markdown Table-to-Bullets Converter — Raw text table conversion.
 *
 * Converts GFM-style markdown tables in raw text to bullet lists or code
 * blocks for platforms that don't render table syntax (Telegram, Signal,
 * WhatsApp). Operates on raw markdown strings (not IR blocks) for the
 * non-IR chunking path.
 *
 * @module
 */

/** Regex to detect a GFM table separator row (e.g., |---|---|). */
const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Convert GFM markdown tables in raw text to a more readable format.
 *
 * @param text - Raw markdown text potentially containing tables
 * @param mode - Conversion mode: 'bullets', 'code', or 'off'
 * @returns Text with tables converted according to mode
 */
export function convertMarkdownTables(text: string, mode: "bullets" | "code" | "off"): string {
  if (mode === "off" || !text) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  let inCodeBlock = false;

  while (i < lines.length) {
    const line = lines[i]!;

    // Track code fences — don't convert tables inside code blocks
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      i++;
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      i++;
      continue;
    }

    // Check if this line + next line could start a table
    // A table needs: header row (has |), separator row (matches TABLE_SEP_RE)
    if (
      i + 1 < lines.length &&
      line.includes("|") &&
      TABLE_SEP_RE.test(lines[i + 1]!.trim())
    ) {
      // Found a table: collect header, separator, and body rows
      const headerLine = line;
      const headerCells = parsePipeCells(headerLine);
      // Skip separator (line i+1)
      let j = i + 2;

      // Collect body rows
      const bodyRows: string[][] = [];
      while (j < lines.length && lines[j]!.includes("|")) {
        // Stop if we hit another separator (nested table) or empty line
        const candidate = lines[j]!.trim();
        if (!candidate || TABLE_SEP_RE.test(candidate)) break;
        bodyRows.push(parsePipeCells(lines[j]!));
        j++;
      }

      // Convert the table
      if (mode === "bullets") {
        result.push(tableToBullets(headerCells, bodyRows));
      } else {
        result.push(tableToCodeBlock(headerCells, bodyRows));
      }

      i = j;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

/**
 * Parse pipe-delimited cells from a table row.
 * Handles both `| A | B |` and `A | B` formats.
 */
function parsePipeCells(line: string): string[] {
  let trimmed = line.trim();
  // Strip leading/trailing pipes
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

/**
 * Convert a parsed table to bullet list format.
 * Each body row becomes: `- **Header1:** value1, **Header2:** value2, ...`
 * Single-column tables: `- value`
 * Headers-only tables: `- **Header1**, **Header2**, ...`
 */
function tableToBullets(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    // Headers only — render as a bold list
    if (headers.length === 1) {
      return `- **${headers[0]}**`;
    }
    return `- ${headers.map((h) => `**${h}**`).join(", ")}`;
  }

  const singleCol = headers.length === 1;

  return rows
    .map((row) => {
      if (singleCol) {
        return `- ${row[0] ?? ""}`;
      }
      const parts = headers.map((h, idx) => `**${h}:** ${row[idx] ?? ""}`);
      return `- ${parts.join(", ")}`;
    })
    .join("\n");
}

/**
 * Convert a parsed table to a code block with aligned columns.
 */
function tableToCodeBlock(headers: string[], rows: string[][]): string {
  const colCount = headers.length;

  // Calculate column widths
  const widths: number[] = headers.map((h) => h.length);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      widths[c] = Math.max(widths[c] ?? 0, cell.length);
    }
  }

  const pad = (text: string, colIdx: number): string => {
    const w = widths[colIdx] ?? 0;
    return text.padEnd(w);
  };

  const lines: string[] = [];

  // Header row
  lines.push(headers.map((h, i) => pad(h, i)).join("  "));

  // Separator
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));

  // Body rows
  for (const row of rows) {
    lines.push(headers.map((_, i) => pad(row[i] ?? "", i)).join("  "));
  }

  return "```\n" + lines.join("\n") + "\n```";
}
