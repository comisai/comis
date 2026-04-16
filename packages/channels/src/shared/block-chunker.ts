/**
 * Block chunker — splits complete response text into delivery blocks.
 *
 * Pure function with no side effects. Preserves code fences (never splits
 * within a fenced code block). Supports paragraph, newline, sentence, and
 * length-based splitting strategies.
 */

/** Strategy for splitting response text into blocks. */
export type ChunkMode = "paragraph" | "newline" | "sentence" | "length";

/** Options controlling how text is chunked into blocks. */
export interface ChunkOptions {
  /** Splitting strategy */
  mode: ChunkMode;
  /** Maximum characters per block (hard limit) */
  maxChars: number;
  /** Minimum characters before allowing a split (default: 100) */
  minChars?: number;
}

/** A code fence region (inclusive start/end character positions). */
interface FenceRegion {
  start: number;
  end: number;
}

/**
 * Find all code fence regions in the text.
 *
 * Tracks opening and closing ``` or ~~~ markers. An unclosed fence
 * extends to the end of the text.
 */
function findCodeFences(text: string): FenceRegion[] {
  const regions: FenceRegion[] = [];
  // Match code fence markers at line start (optional whitespace + 3+ backticks or tildes)
  const fencePattern = /^[ \t]*(```|~~~)/gm;
  let openStart: number | null = null;

  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    if (openStart === null) {
      // Opening fence
      openStart = match.index;
    } else {
      // Closing fence — region ends at end of this line
      const lineEnd = text.indexOf("\n", match.index);
      regions.push({
        start: openStart,
        end: lineEnd === -1 ? text.length - 1 : lineEnd,
      });
      openStart = null;
    }
  }

  // Unclosed fence extends to end of text
  if (openStart !== null) {
    regions.push({ start: openStart, end: text.length - 1 });
  }

  return regions;
}

/** Check if a character position falls inside any code fence region. */
function isInsideCodeFence(position: number, fences: FenceRegion[]): boolean {
  for (const fence of fences) {
    if (position >= fence.start && position <= fence.end) {
      return true;
    }
  }
  return false;
}

/**
 * Split text at the last word boundary before maxChars, or hard-split
 * if no space is found.
 */
function chunkByLength(text: string, maxChars: number): string[] {
  const blocks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    // Find last space within maxChars
    let splitAt = remaining.lastIndexOf(" ", maxChars);
    if (splitAt <= 0) {
      // No space found — hard split
      splitAt = maxChars;
    }
    blocks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    blocks.push(remaining);
  }

  return blocks;
}

/**
 * Get the split regex for the given chunk mode.
 * Returns null for 'length' mode (uses pure length-based splitting).
 */
function getSplitPattern(mode: ChunkMode): RegExp | null {
  switch (mode) {
    case "paragraph":
      return /\n\n+/g;
    case "newline":
      return /\n/g;
    case "sentence":
      return /(?<=[.!?])\s+/g;
    case "length":
      return null;
  }
}

/**
 * Split a complete response string into delivery blocks.
 *
 * - Segments are accumulated into blocks up to maxChars before flushing
 * - Code fences are never split across blocks
 * - Blocks exceeding maxChars are sub-split at word boundaries
 *
 * @param text - The complete response text to split
 * @param options - Chunking configuration
 * @returns Ordered array of text blocks (never empty)
 */
export function chunkBlocks(text: string, options: ChunkOptions): string[] {
  const { mode, maxChars } = options;

  // Trivial case: text fits in a single block
  if (text.length <= maxChars) {
    return [text];
  }

  // Length mode: pure character-based splitting
  if (mode === "length") {
    return chunkByLength(text, maxChars);
  }

  const fences = findCodeFences(text);
  const pattern = getSplitPattern(mode);

  if (!pattern) {
    return chunkByLength(text, maxChars);
  }

  // Find all valid split positions
  const splitPositions: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const splitPos = match.index;

    // Skip splits inside code fences
    if (isInsideCodeFence(splitPos, fences)) {
      continue;
    }

    splitPositions.push(splitPos);
  }

  // No valid split positions found — fall back to length-based
  if (splitPositions.length === 0) {
    return chunkByLength(text, maxChars);
  }

  // Extract segments between split positions and their delimiters
  const segments: string[] = [];
  const delimiters: string[] = [];
  let segStart = 0;

  for (const splitPos of splitPositions) {
    // Re-match to get the full delimiter length at this position
    pattern.lastIndex = splitPos;
    const delimMatch = pattern.exec(text);
    if (!delimMatch || delimMatch.index !== splitPos) {
      continue;
    }

    const segment = text.slice(segStart, splitPos);
    if (segment.length > 0) {
      segments.push(segment);
      delimiters.push(delimMatch[0]);
    }
    segStart = splitPos + delimMatch[0].length;
  }

  // Add remaining text as final segment (no trailing delimiter)
  const tail = text.slice(segStart);
  if (tail.length > 0) {
    segments.push(tail);
    delimiters.push(""); // no delimiter after last segment
  }

  // Accumulate segments into blocks up to maxChars
  const blocks: string[] = [];
  let buffer = "";
  let bufferDelim = ""; // delimiter to prepend before next segment

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (buffer.length === 0) {
      // Start a new buffer
      buffer = seg;
      bufferDelim = delimiters[i];
      continue;
    }

    // Check if appending this segment would exceed maxChars
    const candidate = buffer + bufferDelim + seg;
    if (candidate.length <= maxChars) {
      // Accumulate into current buffer
      buffer = candidate;
      bufferDelim = delimiters[i];
    } else {
      // Flush current buffer and start new one
      blocks.push(buffer);
      buffer = seg;
      bufferDelim = delimiters[i];
    }
  }

  // Flush remaining buffer
  if (buffer.length > 0) {
    blocks.push(buffer);
  }

  // Filter empty blocks
  const filtered = blocks.filter((b) => b.trim().length > 0);

  // Sub-split any blocks that exceed maxChars
  const result: string[] = [];
  for (const block of filtered) {
    if (block.length > maxChars) {
      result.push(...chunkByLength(block, maxChars));
    } else {
      result.push(block);
    }
  }

  // Safety: never return empty
  if (result.length === 0) {
    return [text];
  }

  return result;
}
