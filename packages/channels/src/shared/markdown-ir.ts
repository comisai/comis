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

/**
 * Regex for inline formatting tokens.
 *
 * Order matters — more specific patterns first:
 * 1. Inline code (backticks) — protect content from further parsing
 * 2. Links [text](url)
 * 3. Bold **text** or __text__
 * 4. Strikethrough ~~text~~
 * 5. Italic *text* or _text_
 */
const INLINE_RE =
  /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*(.+?)\*|_(.+?)_/g;

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

  INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = INLINE_RE.exec(text)) !== null) {
    const matchStart = match.index;

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

    // Determine which capture group matched
    if (match[1] !== undefined) {
      // Inline code: `text`
      const content = match[1];
      spans.push({
        type: "code",
        text: content,
        offset: plainOffset,
        length: content.length,
      });
      plainOffset += content.length;
    } else if (match[2] !== undefined && match[3] !== undefined) {
      // Link: [text](url)
      const linkText = match[2];
      const linkUrl = match[3];
      spans.push({
        type: "link",
        text: linkText,
        url: linkUrl,
        offset: plainOffset,
        length: linkText.length,
      });
      plainOffset += linkText.length;
    } else if (match[4] !== undefined) {
      // Bold: **text**
      const content = match[4];
      spans.push({
        type: "bold",
        text: content,
        offset: plainOffset,
        length: content.length,
      });
      plainOffset += content.length;
    } else if (match[5] !== undefined) {
      // Bold: __text__
      const content = match[5];
      spans.push({
        type: "bold",
        text: content,
        offset: plainOffset,
        length: content.length,
      });
      plainOffset += content.length;
    } else if (match[6] !== undefined) {
      // Strikethrough: ~~text~~
      const content = match[6];
      spans.push({
        type: "strikethrough",
        text: content,
        offset: plainOffset,
        length: content.length,
      });
      plainOffset += content.length;
    } else if (match[7] !== undefined) {
      // Italic: *text*
      const content = match[7];
      spans.push({
        type: "italic",
        text: content,
        offset: plainOffset,
        length: content.length,
      });
      plainOffset += content.length;
    } else if (match[8] !== undefined) {
      // Italic: _text_
      const content = match[8];
      spans.push({
        type: "italic",
        text: content,
        offset: plainOffset,
        length: content.length,
      });
      plainOffset += content.length;
    }

    lastIndex = matchStart + match[0].length;
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
const TABLE_SEP_RE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Regex to detect a heading line (e.g., # Title). */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** Regex to detect unordered list items. */
const UNORDERED_LIST_RE = /^[-*]\s+(.+)$/;

/** Regex to detect ordered list items. */
const ORDERED_LIST_RE = /^\d+\.\s+(.+)$/;

/** Regex to detect blockquote lines. */
const BLOCKQUOTE_RE = /^>\s?(.*)$/;

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
  if (HEADING_RE.test(trimmed)) return false;
  if (BLOCKQUOTE_RE.test(trimmed)) return false;
  // Nested list item markers are NOT continuations — they'd start new items
  if (UNORDERED_LIST_RE.test(trimmed)) return false;
  if (ORDERED_LIST_RE.test(trimmed)) return false;
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
function peekPastBlanksForListItem(lines: string[], startIdx: number, itemRegex: RegExp): number {
  let j = startIdx;
  let blankCount = 0;
  while (j < lines.length && lines[j].trim().length === 0) {
    blankCount++;
    j++;
  }
  // Only skip blanks if there was at least one blank and the next line is a list item
  if (blankCount > 0 && j < lines.length && itemRegex.test(lines[j])) {
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
  return TABLE_SEP_RE.test(line.trim());
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
  const backtickMatch = trimmed.match(/^(`{3,})(.*)/);
  if (backtickMatch) {
    const lang = backtickMatch[2].trim();
    return {
      fence: { char: "`", count: backtickMatch[1].length },
      language: lang || undefined,
    };
  }
  const tildeMatch = trimmed.match(/^(~{3,})(.*)/);
  if (tildeMatch) {
    const lang = tildeMatch[2].trim();
    return {
      fence: { char: "~", count: tildeMatch[1].length },
      language: lang || undefined,
    };
  }
  return null;
}

function isFenceClose(line: string, openFence: FenceState): boolean {
  const trimmed = line.trimStart();
  // Must use same character and at least same count
  const re = new RegExp(`^\\${openFence.char}{${openFence.count},}\\s*$`);
  return re.test(trimmed);
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

      // If not closed, rawLines extends to end of input (per spec)
      blocks.push({
        type: "code_block",
        spans: [],
        language: fenceOpen.language,
        raw: rawLines.join("\n"),
      });
      continue;
    }

    // --- Heading ---
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const content = headingMatch[2];
      blocks.push({
        type: "heading",
        spans: parseInlineSpans(content),
        depth,
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
    const bqMatch = line.match(BLOCKQUOTE_RE);
    if (bqMatch) {
      const bqLines: string[] = [bqMatch[1]];
      i++;
      while (i < lines.length) {
        const nextBq = lines[i].match(BLOCKQUOTE_RE);
        if (nextBq) {
          bqLines.push(nextBq[1]);
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
    const ulMatch = line.match(UNORDERED_LIST_RE);
    if (ulMatch) {
      const items: MarkdownBlock[] = [];
      // Collect first item + its continuation lines
      const first = collectListItemContinuation(lines, i + 1, ulMatch[1]);
      items.push({
        type: "paragraph",
        spans: parseInlineSpans(first.text),
      });
      i = first.nextIdx;

       
      while (true) {
        // Try to match consecutive list items
        while (i < lines.length) {
          const nextUl = lines[i].match(UNORDERED_LIST_RE);
          if (nextUl) {
            const cont = collectListItemContinuation(lines, i + 1, nextUl[1]);
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
        const nextItemIdx = peekPastBlanksForListItem(lines, i, UNORDERED_LIST_RE);
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
    const olMatch = line.match(ORDERED_LIST_RE);
    if (olMatch) {
      const items: MarkdownBlock[] = [];
      // Collect first item + its continuation lines
      const first = collectListItemContinuation(lines, i + 1, olMatch[1]);
      items.push({
        type: "paragraph",
        spans: parseInlineSpans(first.text),
      });
      i = first.nextIdx;

       
      while (true) {
        // Try to match consecutive list items
        while (i < lines.length) {
          const nextOl = lines[i].match(ORDERED_LIST_RE);
          if (nextOl) {
            const cont = collectListItemContinuation(lines, i + 1, nextOl[1]);
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
        const nextItemIdx = peekPastBlanksForListItem(lines, i, ORDERED_LIST_RE);
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
      if (HEADING_RE.test(nextLine)) break;
      if (nextLine.match(BLOCKQUOTE_RE)) break;
      if (nextLine.match(UNORDERED_LIST_RE)) break;
      if (nextLine.match(ORDERED_LIST_RE)) break;
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
