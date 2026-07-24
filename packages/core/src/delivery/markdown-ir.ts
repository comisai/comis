// SPDX-License-Identifier: Apache-2.0
/**
 * Markdown IR (Intermediate Representation) — Types and Parser.
 *
 * Parses standard Markdown into a flat block+span structure that can be
 * rendered to any chat platform format. Each block (paragraph, code_block,
 * heading, blockquote, table, list) contains typed spans (text, bold, italic,
 * code, strikethrough, link) with UTF-16 offsets.
 *
 * Code blocks are preserved as raw content — no inline parsing is applied.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownSpan {
  type: "text" | "bold" | "italic" | "code" | "strikethrough" | "link";
  text: string;
  offset: number; // UTF-16 offset in block's plain text
  length: number; // UTF-16 length
  url?: string; // For link spans
}

export interface MarkdownBlock {
  type: "paragraph" | "code_block" | "blockquote" | "table" | "list" | "heading";
  spans: MarkdownSpan[]; // Inline content (paragraph, heading, blockquote)
  language?: string; // For code_block
  raw?: string; // Raw content for code_block (preserves original)
  rows?: string[][]; // For table blocks (raw cell text, each row is array)
  headers?: string[]; // For table blocks (header row)
  depth?: number; // For heading (1-6)
  items?: MarkdownBlock[]; // For list (each item is a paragraph sub-block)
  ordered?: boolean; // For list
}

export interface MarkdownIR {
  blocks: MarkdownBlock[];
  sourceLength: number; // Original Markdown string length (UTF-16)
}

// ---------------------------------------------------------------------------
// Inline span parser
// ---------------------------------------------------------------------------

interface InlineToken {
  type: Exclude<MarkdownSpan["type"], "text">;
  text: string;
  end: number;
  url?: string;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

function findDelimitedToken(
  text: string,
  start: number,
  delimiter: string,
  type: InlineToken["type"],
): InlineToken | undefined {
  const contentStart = start + delimiter.length;
  const close = text.indexOf(delimiter, contentStart);
  if (close <= contentStart) return undefined;
  return { type, text: text.slice(contentStart, close), end: close + delimiter.length };
}

function findInlineToken(text: string, start: number): InlineToken | undefined {
  if (text[start] === "`") {
    return findDelimitedToken(text, start, "`", "code");
  }

  const isHttpUrl = text.startsWith("http://", start) || text.startsWith("https://", start);
  if (isHttpUrl) {
    let end = start;
    while (end < text.length && !/\s|[<>"'`)]/.test(text[end]!)) end++;
    const url = text.slice(start, end);
    return { type: "link", text: url, url, end };
  }

  if (text[start] === "[") {
    const textEnd = text.indexOf("](", start + 1);
    if (textEnd > start + 1) {
      const urlEnd = text.indexOf(")", textEnd + 2);
      if (urlEnd > textEnd + 2) {
        return {
          type: "link",
          text: text.slice(start + 1, textEnd),
          url: text.slice(textEnd + 2, urlEnd),
          end: urlEnd + 1,
        };
      }
    }
  }

  if (text.startsWith("**", start)) {
    return findDelimitedToken(text, start, "**", "bold");
  }
  if (
    text.startsWith("__", start) &&
    !isWordCharacter(text[start - 1])
  ) {
    const token = findDelimitedToken(text, start, "__", "bold");
    if (token && !isWordCharacter(text[token.end])) return token;
  }
  if (text.startsWith("~~", start)) {
    return findDelimitedToken(text, start, "~~", "strikethrough");
  }
  if (text[start] === "*") {
    return findDelimitedToken(text, start, "*", "italic");
  }
  if (
    text[start] === "_" &&
    text[start - 1] !== "_" &&
    !isWordCharacter(text[start - 1])
  ) {
    const token = findDelimitedToken(text, start, "_", "italic");
    if (
      token &&
      text[token.end] !== "_" &&
      !isWordCharacter(text[token.end])
    ) {
      return token;
    }
  }
  return undefined;
}

/**
 * Parse inline Markdown formatting into typed spans with UTF-16 offsets.
 *
 * Each span's offset and length refer to position in the block's extracted
 * plain text (Markdown syntax markers stripped).
 */
export function parseInlineSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let lastIndex = 0;
  let plainOffset = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const token = findInlineToken(text, cursor);
    if (!token) {
      cursor++;
      continue;
    }
    const matchStart = cursor;

    // Plain text before this match
    if (matchStart > lastIndex) {
      const plain = text.slice(lastIndex, matchStart);
      spans.push({
        type: "text",
        text: plain,
        offset: plainOffset,
        length: plain.length,
      });
      plainOffset += plain.length;
    }

    spans.push({
      type: token.type,
      text: token.text,
      ...(token.url === undefined ? {} : { url: token.url }),
      offset: plainOffset,
      length: token.text.length,
    });
    plainOffset += token.text.length;
    lastIndex = token.end;
    cursor = token.end;
  }

  // Trailing plain text
  if (lastIndex < text.length) {
    const plain = text.slice(lastIndex);
    spans.push({
      type: "text",
      text: plain,
      offset: plainOffset,
      length: plain.length,
    });
  }

  return spans;
}

// ---------------------------------------------------------------------------
// Block-level parser
// ---------------------------------------------------------------------------

/** Regex to detect a GFM table separator row (e.g., |---|---|). */
function matchHeading(line: string): { depth: number; content: string } | undefined {
  let depth = 0;
  while (depth < 6 && line[depth] === "#") depth++;
  if (depth === 0 || !/\s/.test(line[depth] ?? "")) return undefined;
  const content = line.slice(depth).trimStart();
  return content.length === 0 ? undefined : { depth, content };
}

function matchUnorderedListItem(line: string): string | undefined {
  if ((line[0] !== "-" && line[0] !== "*") || !/\s/.test(line[1] ?? "")) return undefined;
  const content = line.slice(2).trimStart();
  return content.length === 0 ? undefined : content;
}

function matchOrderedListItem(line: string): string | undefined {
  let cursor = 0;
  while (cursor < line.length && line[cursor]! >= "0" && line[cursor]! <= "9") cursor++;
  if (cursor === 0 || line[cursor] !== "." || !/\s/.test(line[cursor + 1] ?? "")) return undefined;
  const content = line.slice(cursor + 2).trimStart();
  return content.length === 0 ? undefined : content;
}

function matchBlockquote(line: string): string | undefined {
  if (line[0] !== ">") return undefined;
  return line[1] === " " ? line.slice(2) : line.slice(1);
}

/**
 * Check if a line is a list continuation line — indented text that continues
 * the previous list item. Returns true if the line starts with 2+ spaces and
 * doesn't match any block-level start pattern.
 */
function isListContinuationLine(line: string): boolean {
  // Must be indented by at least 2 spaces (or a tab)
  if (!/^(?: {2}|\t)/.test(line)) return false;
  const trimmed = line.trimStart();
  // Empty indented line is not a continuation
  if (trimmed.length === 0) return false;
  // Block-level patterns terminate continuation
  if (detectFenceOpen(line) || detectFenceOpen(trimmed)) return false;
  if (matchHeading(trimmed)) return false;
  if (matchBlockquote(trimmed) !== undefined) return false;
  // Nested list item markers are NOT continuations — they'd start new items
  if (matchUnorderedListItem(trimmed)) return false;
  if (matchOrderedListItem(trimmed)) return false;
  return true;
}

/**
 * Collect continuation lines for a list item starting at index `startIdx`.
 * Returns the combined item text and the new line index after all continuations.
 */
function collectListItemContinuation(lines: string[], startIdx: number, firstLineContent: string): { text: string; nextIdx: number } {
  const parts = [firstLineContent];
  let j = startIdx;
  while (j < lines.length && isListContinuationLine(lines[j])) {
    parts.push(lines[j].trimStart());
    j++;
  }
  return { text: parts.join("\n"), nextIdx: j };
}

/**
 * After consuming one list item (plus its continuations), look ahead past blank
 * lines to see if the list continues with another item of the same type.
 * Returns the index of the next item line, or -1 if the list should end.
 */
function peekPastBlanksForListItem(
  lines: string[],
  startIdx: number,
  matchItem: (line: string) => string | undefined,
): number {
  let j = startIdx;
  let blankCount = 0;
  while (j < lines.length && lines[j].trim().length === 0) {
    blankCount++;
    j++;
  }
  // Only skip blanks if there was at least one blank and the next line is a list item
  if (blankCount > 0 && j < lines.length && matchItem(lines[j]) !== undefined) {
    return j;
  }
  return -1;
}

/** Parse a table row's cells by splitting on pipe. */
function parseTableRow(line: string): string[] {
  // Remove leading/trailing pipes and trim cells
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

/** Check if a line is a table separator row. */
function isTableSeparator(line: string): boolean {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells = trimmed.split("|");
  return cells.length > 0 && cells.every((cell) => {
    let value = cell.trim();
    if (value.startsWith(":")) value = value.slice(1);
    if (value.endsWith(":")) value = value.slice(0, -1);
    return value.length >= 3 && [...value].every((character) => character === "-");
  });
}

/**
 * Detect code fence opening. Tracks the fence character and count
 * Closing fence must use the same character.
 */
interface FenceState {
  char: string; // '`' or '~'
  count: number; // 3 or more
}

function detectFenceOpen(line: string): { fence: FenceState; language?: string } | null {
  const trimmed = line.trimStart();
  const char = trimmed[0];
  if (char === "`" || char === "~") {
    let count = 0;
    while (trimmed[count] === char) count++;
    if (count < 3) return null;
    const lang = trimmed.slice(count).trim();
    return {
      fence: { char, count },
      language: lang || undefined,
    };
  }
  return null;
}

function isFenceClose(line: string, openFence: FenceState): boolean {
  const trimmed = line.trimStart();
  let count = 0;
  while (trimmed[count] === openFence.char) count++;
  return count >= openFence.count && trimmed.slice(count).trim() === "";
}

/**
 * Parse a Markdown string into a MarkdownIR structure.
 *
 * Block-level parsing scans lines top-to-bottom. Code fences are detected
 * first (they take priority). Then headings, blockquotes, tables, lists,
 * and finally paragraphs.
 */
export function parseMarkdownToIR(markdown: string): MarkdownIR {
  if (!markdown || markdown.trim().length === 0) {
    return { blocks: [], sourceLength: markdown.length };
  }

  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Code fences ---
    const fenceOpen = detectFenceOpen(line);
    if (fenceOpen) {
      const rawLines: string[] = [];
      i++; // skip opening fence line
      while (i < lines.length) {
        if (isFenceClose(lines[i], fenceOpen.fence)) {
          i++; // skip closing fence line
          break;
        }
        rawLines.push(lines[i]);
        i++;
      }

      // If not closed, rawLines extends to end of input (CommonMark treats an
      // unclosed fence as running to the end of the document)
      blocks.push({
        type: "code_block",
        spans: [],
        language: fenceOpen.language,
        raw: rawLines.join("\n"),
      });
      continue;
    }

    // --- Heading ---
    const headingMatch = matchHeading(line);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        spans: parseInlineSpans(headingMatch.content),
        depth: headingMatch.depth,
      });
      i++;
      continue;
    }

    // --- Table ---
    // A table requires: header row, separator row, then body rows
    if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line);
      i += 2; // skip header and separator

      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|")) {
        // Don't consume lines that look like new tables or non-table content
        if (lines[i].trim().length === 0) break;
        rows.push(parseTableRow(lines[i]));
        i++;
      }

      blocks.push({
        type: "table",
        spans: [],
        headers,
        rows,
      });
      continue;
    }

    // --- Blockquote ---
    const bqMatch = matchBlockquote(line);
    if (bqMatch !== undefined) {
      const bqLines: string[] = [bqMatch];
      i++;
      while (i < lines.length) {
        const nextBq = matchBlockquote(lines[i]);
        if (nextBq !== undefined) {
          bqLines.push(nextBq);
          i++;
        } else {
          break;
        }
      }

      const combined = bqLines.join("\n");
      blocks.push({
        type: "blockquote",
        spans: parseInlineSpans(combined),
      });
      continue;
    }

    // --- Unordered list ---
    const ulMatch = matchUnorderedListItem(line);
    if (ulMatch !== undefined) {
      const items: MarkdownBlock[] = [];
      // Collect first item + its continuation lines
      const first = collectListItemContinuation(lines, i + 1, ulMatch);
      items.push({
        type: "paragraph",
        spans: parseInlineSpans(first.text),
      });
      i = first.nextIdx;

       
      while (true) {
        // Try to match consecutive list items
        while (i < lines.length) {
          const nextUl = matchUnorderedListItem(lines[i]);
          if (nextUl !== undefined) {
            const cont = collectListItemContinuation(lines, i + 1, nextUl);
            items.push({
              type: "paragraph",
              spans: parseInlineSpans(cont.text),
            });
            i = cont.nextIdx;
          } else {
            break;
          }
        }
        // Look ahead past blank lines for more list items (loose list)
        const nextItemIdx = peekPastBlanksForListItem(lines, i, matchUnorderedListItem);
        if (nextItemIdx >= 0) {
          i = nextItemIdx;
          continue;
        }
        break;
      }

      blocks.push({
        type: "list",
        spans: [],
        items,
        ordered: false,
      });
      continue;
    }

    // --- Ordered list ---
    const olMatch = matchOrderedListItem(line);
    if (olMatch !== undefined) {
      const items: MarkdownBlock[] = [];
      // Collect first item + its continuation lines
      const first = collectListItemContinuation(lines, i + 1, olMatch);
      items.push({
        type: "paragraph",
        spans: parseInlineSpans(first.text),
      });
      i = first.nextIdx;

       
      while (true) {
        // Try to match consecutive list items
        while (i < lines.length) {
          const nextOl = matchOrderedListItem(lines[i]);
          if (nextOl !== undefined) {
            const cont = collectListItemContinuation(lines, i + 1, nextOl);
            items.push({
              type: "paragraph",
              spans: parseInlineSpans(cont.text),
            });
            i = cont.nextIdx;
          } else {
            break;
          }
        }
        // Look ahead past blank lines for more list items (loose list)
        const nextItemIdx = peekPastBlanksForListItem(lines, i, matchOrderedListItem);
        if (nextItemIdx >= 0) {
          i = nextItemIdx;
          continue;
        }
        break;
      }

      blocks.push({
        type: "list",
        spans: [],
        items,
        ordered: true,
      });
      continue;
    }

    // --- Blank lines (paragraph separator) ---
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // --- Paragraph (default) ---
    // Collect consecutive non-empty, non-special lines
    const paraLines: string[] = [line];
    i++;

    while (i < lines.length) {
      const nextLine = lines[i];

      // Stop at blank line
      if (nextLine.trim().length === 0) break;

      // Stop at special block starts
      if (detectFenceOpen(nextLine)) break;
      if (matchHeading(nextLine)) break;
      if (matchBlockquote(nextLine) !== undefined) break;
      if (matchUnorderedListItem(nextLine) !== undefined) break;
      if (matchOrderedListItem(nextLine) !== undefined) break;
      // Stop if this + next form a table
      if (i + 1 < lines.length && nextLine.includes("|") && isTableSeparator(lines[i + 1])) break;

      paraLines.push(nextLine);
      i++;
    }

    const paraText = paraLines.join("\n");
    blocks.push({
      type: "paragraph",
      spans: parseInlineSpans(paraText),
    });
  }

  return {
    blocks,
    sourceLength: markdown.length,
  };
}
