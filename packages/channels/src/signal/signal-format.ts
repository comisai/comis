/**
 * Signal Text Style Formatter: Converts MarkdownIR to plain text + byte-offset styles.
 *
 * Signal uses a plain text body with separate byte-offset annotations for styling
 * This module walks the IR blocks, producing plain text output
 * and tracking SignalTextStyle entries with UTF-16 code unit offsets.
 *
 * JavaScript strings are UTF-16 internally (String.length counts code units),
 * matching Signal's offset scheme. Surrogate pairs (emoji, non-BMP chars) naturally
 * count as 2 units in both JS and Signal.
 *
 * Adapted from Comis's signal/format.ts for Comis's MarkdownIR structure.
 *
 * @module
 */

import type { MarkdownIR, MarkdownBlock, MarkdownSpan } from "../shared/markdown-ir.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignalTextStyle {
  /** UTF-16 code unit offset from start of text */
  start: number;
  /** UTF-16 code unit length of styled range */
  length: number;
  /** Signal text style type */
  style: "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";
}

export interface SignalFormattedMessage {
  /** Plain text content with formatting markers stripped */
  text: string;
  /** Byte-offset text style annotations */
  textStyles: SignalTextStyle[];
}

// ---------------------------------------------------------------------------
// Span type to Signal style mapping
// ---------------------------------------------------------------------------

function mapSpanStyle(
  spanType: MarkdownSpan["type"],
): SignalTextStyle["style"] | null {
  switch (spanType) {
    case "bold":
      return "BOLD";
    case "italic":
      return "ITALIC";
    case "code":
      return "MONOSPACE";
    case "strikethrough":
      return "STRIKETHROUGH";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Block rendering with offset tracking
// ---------------------------------------------------------------------------

interface RenderState {
  text: string;
  styles: SignalTextStyle[];
}

function appendText(state: RenderState, text: string): void {
  state.text += text;
}

function renderSpansWithStyles(
  spans: MarkdownSpan[],
  state: RenderState,
): void {
  for (const span of spans) {
    const start = state.text.length;
    const signalStyle = mapSpanStyle(span.type);

    if (span.type === "link") {
      // Render link text, then append URL if different
      appendText(state, span.text);
      if (span.url && span.text !== span.url) {
        appendText(state, ` (${span.url})`);
      }
    } else {
      appendText(state, span.text);
    }

    if (signalStyle) {
      const length = span.text.length;
      if (length > 0) {
        state.styles.push({ start, length, style: signalStyle });
      }
    }
  }
}

function renderBlockWithStyles(
  block: MarkdownBlock,
  state: RenderState,
): void {
  switch (block.type) {
    case "paragraph":
      renderSpansWithStyles(block.spans, state);
      break;

    case "code_block": {
      const raw = block.raw ?? "";
      if (raw) {
        const start = state.text.length;
        appendText(state, raw);
        state.styles.push({
          start,
          length: raw.length,
          style: "MONOSPACE",
        });
      }
      break;
    }

    case "heading": {
      // Render heading content as bold
      const start = state.text.length;
      const headingSpans = block.spans.map((s) => s.text).join("");
      appendText(state, headingSpans);
      if (headingSpans.length > 0) {
        state.styles.push({
          start,
          length: headingSpans.length,
          style: "BOLD",
        });
      }
      break;
    }

    case "blockquote": {
      appendText(state, "> ");
      renderSpansWithStyles(block.spans, state);
      break;
    }

    case "table": {
      const headers = block.headers ?? [];
      const rows = block.rows ?? [];
      const headerLine = `| ${headers.join(" | ")} |`;
      const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
      const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
      appendText(state, [headerLine, sepLine, ...bodyLines].join("\n"));
      break;
    }

    case "list": {
      const items = block.items ?? [];
      items.forEach((item, idx) => {
        if (idx > 0) appendText(state, "\n");
        const prefix = block.ordered ? `${idx + 1}. ` : "- ";
        appendText(state, prefix);
        renderSpansWithStyles(item.spans, state);
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a MarkdownIR to plain text with Signal byte-offset text styles.
 *
 * Walks all IR blocks, producing plain text output and recording
 * SignalTextStyle entries with UTF-16 code unit offsets.
 *
 * @param ir - The parsed Markdown IR
 * @returns Plain text and text style annotations
 */
export function convertIrToSignalTextStyles(ir: MarkdownIR): SignalFormattedMessage {
  const state: RenderState = { text: "", styles: [] };

  for (let i = 0; i < ir.blocks.length; i++) {
    if (i > 0) appendText(state, "\n\n");
    renderBlockWithStyles(ir.blocks[i], state);
  }

  // Merge adjacent styles of the same type
  const merged = mergeStyles(state.styles);

  return {
    text: state.text,
    textStyles: merged,
  };
}

/**
 * Merge adjacent or overlapping styles of the same type.
 */
function mergeStyles(styles: SignalTextStyle[]): SignalTextStyle[] {
  if (styles.length <= 1) return styles;

  const sorted = [...styles].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.length !== b.length) return a.length - b.length;
    return a.style.localeCompare(b.style);
  });

  const merged: SignalTextStyle[] = [];
  for (const style of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === style.style && style.start <= prev.start + prev.length) {
      const prevEnd = prev.start + prev.length;
      const nextEnd = Math.max(prevEnd, style.start + style.length);
      prev.length = nextEnd - prev.start;
      continue;
    }
    merged.push({ ...style });
  }

  return merged;
}
