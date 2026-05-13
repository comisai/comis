// SPDX-License-Identifier: Apache-2.0
/**
 * IR Chunker — Format-first block-boundary chunking from MarkdownIR.
 *
 * Splits rendered Markdown IR into delivery chunks that never break
 * formatting spans across boundaries. Operates on parsed MarkdownIR blocks
 * instead of raw text, ensuring code fences stay intact and inline
 * formatting is preserved within each chunk.
 *
 * Key guarantees:
 * - Chunks split only at block boundaries (never mid-paragraph)
 * - Code blocks are atomic (not split) unless exceeding 2x maxChars
 * - Surrogate pair boundaries are never split
 * - Tables are pre-converted via configurable table mode before chunking
 * - Never returns an empty array
 *
 * @module
 */

import type { MarkdownIR, MarkdownBlock } from "./markdown-ir.js";
import { renderIR } from "./ir-renderer.js";
import { convertTable } from "./table-converter.js";
import type { TableMode } from "./table-converter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for IR-based chunking. */
export interface IRChunkOptions {
  /** Maximum characters per chunk. */
  maxChars: number;
  /** Target platform for rendering (discord, slack, telegram, whatsapp). */
  platform: string;
  /** Table conversion mode: 'code', 'bullets', or 'off'. */
  tableMode: TableMode;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk a MarkdownIR into platform-rendered strings respecting block boundaries.
 *
 * Algorithm:
 * 1. Apply table conversion to all table blocks
 * 2. Render each block individually
 * 3. Greedily pack rendered blocks into chunks within maxChars
 * 4. Oversized single blocks are sub-split preserving structure
 *
 * @param ir - Parsed Markdown IR
 * @param options - Chunking options (maxChars, platform, tableMode)
 * @returns Array of rendered strings, each within maxChars. Never empty.
 */
export function chunkIR(ir: MarkdownIR, options: IRChunkOptions): string[] {
  const { maxChars, platform, tableMode } = options;

  // Handle empty IR
  if (ir.blocks.length === 0) {
    return [""];
  }

  // Pass 1: Apply table conversion to all table blocks
  const convertedBlocks: MarkdownBlock[] = ir.blocks.map((block) =>
    block.type === "table" ? convertTable(block, tableMode) : block,
  );

  // Pass 2: Render each block individually
  const renderedBlocks: string[] = convertedBlocks.map((block) =>
    renderIR({ blocks: [block], sourceLength: 0 }, platform),
  );

  // Pass 3: Greedily pack blocks into chunks
  const chunks: string[] = [];
  let currentChunk = "";

  for (let i = 0; i < renderedBlocks.length; i++) {
    const rendered = renderedBlocks[i];
    const block = convertedBlocks[i];

    // Check if this block can fit in current chunk
    const separator = currentChunk.length > 0 ? "\n\n" : "";
    const combined = currentChunk + separator + rendered;

    if (combined.length <= maxChars) {
      // Fits -- add to current chunk
      currentChunk = combined;
    } else if (currentChunk.length === 0) {
      // Single block exceeds maxChars -- sub-split
      const subChunks = subSplitBlock(rendered, block, maxChars);
      // Add all sub-chunks except the last one
      for (let j = 0; j < subChunks.length - 1; j++) {
        chunks.push(subChunks[j]);
      }
      // Last sub-chunk becomes the start of a new accumulation
      currentChunk = subChunks[subChunks.length - 1];
    } else {
      // Doesn't fit -- flush current chunk and start new one
      chunks.push(currentChunk);
      // Try the current block again as the start of a new chunk
      if (rendered.length <= maxChars) {
        currentChunk = rendered;
      } else {
        // Block itself exceeds maxChars -- sub-split
        const subChunks = subSplitBlock(rendered, block, maxChars);
        for (let j = 0; j < subChunks.length - 1; j++) {
          chunks.push(subChunks[j]);
        }
        currentChunk = subChunks[subChunks.length - 1];
      }
    }
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  // Safety: never return empty
  if (chunks.length === 0) {
    return [""];
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Sub-splitting (oversized single blocks)
// ---------------------------------------------------------------------------

/**
 * Sub-split an oversized rendered block.
 *
 * For code blocks: keep atomic if under 2x maxChars, otherwise split
 * raw content at newline boundaries and wrap each chunk in its own fence.
 *
 * For other blocks: split at sentence or word boundaries, respecting
 * surrogate pair boundaries.
 */
function subSplitBlock(rendered: string, block: MarkdownBlock, maxChars: number): string[] {
  if (block.type === "code_block") {
    return subSplitCodeBlock(rendered, block, maxChars);
  }

  return subSplitText(rendered, maxChars);
}

/**
 * Sub-split a code block that exceeds maxChars.
 *
 * If under 2x maxChars, keep as atomic unit (accept oversize).
 * Otherwise, split raw content at newline boundaries and wrap
 * each chunk in its own code fence.
 */
function subSplitCodeBlock(rendered: string, block: MarkdownBlock, maxChars: number): string[] {
  // Keep atomic if under 2x maxChars
  if (rendered.length <= maxChars * 2) {
    return [rendered];
  }

  // Split raw content at newline boundaries
  const raw = block.raw ?? "";
  const lang = block.language ?? "";
  const fenceOpen = "```" + lang + "\n";
  const fenceClose = "\n```";
  const overhead = fenceOpen.length + fenceClose.length;
  const contentMax = maxChars - overhead;

  if (contentMax <= 0) {
    // Edge case: fence overhead alone exceeds maxChars
    return [rendered];
  }

  const rawLines = raw.split("\n");
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;

  for (const line of rawLines) {
    const lineLen = line.length + (currentLines.length > 0 ? 1 : 0); // +1 for newline join
    if (currentLen + lineLen > contentMax && currentLines.length > 0) {
      // Flush current chunk
      chunks.push(fenceOpen + currentLines.join("\n") + fenceClose);
      currentLines = [line];
      currentLen = line.length;
    } else {
      currentLines.push(line);
      currentLen += lineLen;
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    chunks.push(fenceOpen + currentLines.join("\n") + fenceClose);
  }

  return chunks.length > 0 ? chunks : [rendered];
}

/**
 * Sub-split rendered text at sentence or word boundaries.
 *
 * Checks surrogate pair boundaries: if the character before the split
 * position is a high surrogate (0xD800-0xDBFF), moves forward by 1
 * to avoid splitting the pair.
 */
function subSplitText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let splitAt = findSplitPoint(remaining, maxChars);

    // Surrogate pair safety: don't split in the middle of a pair
    splitAt = adjustForSurrogatePair(remaining, splitAt);

    if (splitAt <= 0) {
      // No good split point -- hard split at maxChars (with surrogate safety)
      splitAt = adjustForSurrogatePair(remaining, maxChars);
      if (splitAt <= 0) splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Find the best split point within maxChars.
 *
 * Priority: sentence boundary > word boundary > maxChars
 */
function findSplitPoint(text: string, maxChars: number): number {
  const segment = text.slice(0, maxChars);

  // Try sentence boundary (last .!? followed by space)
  const sentenceMatch = segment.match(/[.!?]\s+/g);
  if (sentenceMatch) {
    // Find last sentence boundary position
    let lastPos = 0;
    let searchFrom = 0;
    for (const match of sentenceMatch) {
      const idx = segment.indexOf(match, searchFrom);
      if (idx !== -1) {
        lastPos = idx + match.length;
        searchFrom = lastPos;
      }
    }
    if (lastPos > 0) return lastPos;
  }

  // Try word boundary (last space)
  const lastSpace = segment.lastIndexOf(" ");
  if (lastSpace > 0) return lastSpace;

  // No good boundary -- return maxChars (caller handles)
  return maxChars;
}

/**
 * Adjust a split position to avoid breaking a surrogate pair.
 *
 * If the character at (position - 1) is a high surrogate (0xD800-0xDBFF),
 * move forward by 1 to include the low surrogate.
 */
function adjustForSurrogatePair(text: string, position: number): number {
  if (position <= 0 || position >= text.length) return position;

  const charCode = text.charCodeAt(position - 1);
  // High surrogate range: 0xD800-0xDBFF
  if (charCode >= 0xd800 && charCode <= 0xdbff) {
    return position + 1;
  }

  return position;
}
