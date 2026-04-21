// SPDX-License-Identifier: Apache-2.0
/**
 * Shared chunking helper for outbound delivery.
 *
 * Extracts the chunking logic from execution-pipeline.ts into a reusable
 * pure function. Used by both `deliverToChannel()` (simple path) and
 * the execution pipeline (advanced path with coalescing).
 *
 * Two paths:
 * - **IR path** (`useMarkdownIR: true`, default): Parse to MarkdownIR,
 *   chunk at block boundaries preserving formatting integrity.
 * - **Raw path** (`useMarkdownIR: false`): Apply table conversion for
 *   platforms that don't support GFM, then chunk at text boundaries.
 *
 * @module
 */

import { parseMarkdownToIR } from "./markdown-ir.js";
import { chunkIR } from "./ir-chunker.js";
import { chunkBlocks } from "./block-chunker.js";
import { convertMarkdownTables } from "./markdown-tables.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the chunking step. */
export interface ChunkForDeliveryOptions {
  /** Maximum characters per chunk. */
  maxChars: number;
  /** Table conversion mode. Default: "code". */
  tableMode?: "code" | "bullets" | "off";
  /** Use Markdown IR pipeline. Default: true. */
  useMarkdownIR?: boolean;
  /** Chunk mode for raw text path. Default: "paragraph". */
  chunkMode?: "paragraph" | "newline" | "sentence" | "length";
  /** Minimum chars before a chunk is emitted (raw path). */
  chunkMinChars?: number;
}

// ---------------------------------------------------------------------------
// Platforms that need table conversion in the raw (non-IR) path
// ---------------------------------------------------------------------------

const PLATFORMS_NEEDING_TABLE_CONVERSION = new Set(["telegram", "signal", "whatsapp"]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk text for delivery to a specific platform.
 *
 * Pure function -- no side effects, no adapter calls. Matches the chunking
 * logic previously inline in execution-pipeline.ts lines 661-686.
 *
 * @param text - The text to chunk (markdown or pre-formatted)
 * @param channelType - Target platform identifier
 * @param options - Chunking configuration
 * @returns Array of text chunks. Never empty -- returns `[""]` for empty input.
 */
export function chunkForDelivery(
  text: string,
  channelType: string,
  options: ChunkForDeliveryOptions,
): string[] {
  const { maxChars, useMarkdownIR = true } = options;

  // Trivial case: text fits in a single chunk AND no IR rendering needed
  if (text.length <= maxChars && !useMarkdownIR) {
    return [text];
  }

  let blocks: string[];

  if (useMarkdownIR) {
    // IR pipeline: parse to IR, render to platform format, chunk at block boundaries.
    // Always runs when useMarkdownIR is true — even for single-chunk text — because
    // the IR renderer converts markdown to platform-specific format (e.g. HTML for
    // Telegram). Skipping this for short text would deliver raw markdown to platforms
    // that don't support it.
    const ir = parseMarkdownToIR(text);
    blocks = chunkIR(ir, {
      maxChars,
      platform: channelType,
      tableMode: options.tableMode ?? "code",
    });
  } else {
    // Raw path: apply table conversion for platforms that don't support GFM tables
    let textForChunking = text;
    if (PLATFORMS_NEEDING_TABLE_CONVERSION.has(channelType) && options.tableMode !== "off") {
      textForChunking = convertMarkdownTables(text, options.tableMode ?? "code");
    }
    // Chunk raw text at paragraph/newline boundaries
    blocks = chunkBlocks(textForChunking, {
      mode: options.chunkMode ?? "paragraph",
      maxChars,
      minChars: options.chunkMinChars,
    });
  }

  // Safety: never return empty array (design section 11.2)
  if (blocks.length === 0) {
    return [text];
  }

  return blocks;
}
