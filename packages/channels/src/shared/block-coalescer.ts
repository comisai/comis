/**
 * Block coalescer -- content-aware grouping of text blocks for delivery.
 *
 * Groups consecutive prose blocks into larger chunks (up to maxChars), while
 * isolating code blocks (per policy), tables, and headings as standalone
 * delivery groups. Produces flush events for observability.
 *
 * Note: inferBlockType() does NOT need a "media" type because MEDIA:
 * directives are stripped by the outbound-media-handler pipeline step BEFORE
 * text reaches the chunker/coalescer. See execution-pipeline.ts where
 * deliverOutboundMedia() runs and finalDeliveryText = parsed.text removes
 * MEDIA: lines. This is a pipeline ordering guarantee.
 *
 * @module
 */

import type { CoalescerConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Flush event metadata emitted for each coalesce flush. */
export interface CoalesceFlushEvent {
  blockCount: number;
  charCount: number;
  trigger: "size" | "boundary" | "end_of_response";
  // NOTE: "idle" trigger is deferred but exists in the event schema
  // (events-channel.ts) for future use with async idle-timeout flushing.
}

/** Result of the synchronous coalescing pass. */
export interface CoalesceResult {
  groups: string[];
  flushEvents: CoalesceFlushEvent[];
}

/** Inferred semantic block type. */
export type BlockType = "code" | "heading" | "table" | "prose";

// ---------------------------------------------------------------------------
// Block type detection
// ---------------------------------------------------------------------------

/**
 * Infer the semantic block type from rendered text.
 *
 * If an explicit `blockType` hint is provided (future metadata from chunkIR),
 * it is used directly via a mapping. Otherwise, heuristic detection runs on
 * the trimmed rendered string.
 *
 * @param rendered - The rendered text block
 * @param blockType - Optional explicit block type hint
 * @returns Inferred block type
 */
export function inferBlockType(rendered: string, blockType?: string): BlockType {
  // Fast path: explicit hint from IR metadata (future)
  if (blockType !== undefined) {
    const mapping: Record<string, BlockType> = {
      code: "code",
      heading: "heading",
      table: "table",
      prose: "prose",
    };
    return mapping[blockType] ?? "prose";
  }

  const trimmed = rendered.trimStart();

  // Code: starts with ``` (Markdown) or <pre> (Telegram HTML rendering)
  if (trimmed.startsWith("```") || trimmed.startsWith("<pre>")) {
    return "code";
  }

  // Heading: Markdown # syntax
  if (/^#{1,6}\s/.test(trimmed)) {
    return "heading";
  }

  // Heading: Telegram single-line bold heuristic.
  // <b>Title</b> on a single line is treated as a heading.
  // Multi-line bold (contains \n) is NOT a heading.
  if (trimmed.startsWith("<b>") && !trimmed.includes("\n")) {
    return "heading";
  }

  // Table: pipe syntax with separator row
  if (trimmed.startsWith("|") && trimmed.includes("|---")) {
    return "table";
  }

  return "prose";
}

// ---------------------------------------------------------------------------
// Coalescer
// ---------------------------------------------------------------------------

/** Join separator between coalesced prose blocks. */
const JOINER = "\n\n";

/**
 * Coalesce blocks into delivery groups using content-aware rules.
 *
 * - Code blocks (when codeBlockPolicy is "standalone"), tables, and headings
 *   are always delivered as standalone groups.
 * - Prose blocks are accumulated until maxChars is exceeded.
 * - End of response always triggers a final flush.
 *
 * Note: The minChars threshold is only relevant for idle-timeout flush
 * (deferred). In the synchronous coalescer, prose is flushed by
 * size/boundary/end_of_response only -- there is no "premature flush" scenario
 * since we process all blocks at once.
 *
 * @param blocks - Ordered text blocks from chunker
 * @param config - Coalescer configuration
 * @returns Coalesced groups and flush events
 */
export function coalesceBlocks(blocks: string[], config: CoalescerConfig): CoalesceResult {
  const groups: string[] = [];
  const flushEvents: CoalesceFlushEvent[] = [];

  if (blocks.length === 0) {
    return { groups, flushEvents };
  }

  if (blocks.length === 1) {
    groups.push(blocks[0]);
    flushEvents.push({
      blockCount: 1,
      charCount: blocks[0].length,
      trigger: "end_of_response",
    });
    return { groups, flushEvents };
  }

  // Buffer for accumulating prose blocks
  let buffer: string[] = [];
  let bufferChars = 0;

  function flush(trigger: CoalesceFlushEvent["trigger"]): void {
    if (buffer.length === 0) return;
    const joined = buffer.join(JOINER);
    groups.push(joined);
    flushEvents.push({
      blockCount: buffer.length,
      charCount: joined.length,
      trigger,
    });
    buffer = [];
    bufferChars = 0;
  }

  for (const block of blocks) {
    const type = inferBlockType(block);

    // Boundary blocks: code (when standalone policy), table, heading
    const isBoundary =
      (type === "code" && config.codeBlockPolicy === "standalone") ||
      type === "table" ||
      type === "heading";

    if (isBoundary) {
      // Flush accumulated prose before the boundary
      flush("boundary");

      // Add the boundary block as its own group
      groups.push(block);
      flushEvents.push({
        blockCount: 1,
        charCount: block.length,
        trigger: "boundary",
      });
      continue;
    }

    // Prose (or code when policy is "coalesce") -- accumulate
    const addedChars = buffer.length === 0
      ? block.length
      : JOINER.length + block.length;

    // Size-based flush when adding would exceed maxChars
    if (bufferChars + addedChars > config.maxChars && buffer.length > 0) {
      flush("size");
    }

    // After potential flush, recalculate: if buffer is empty, this is first block
    if (buffer.length === 0) {
      bufferChars = block.length;
    } else {
      bufferChars += JOINER.length + block.length;
    }
    buffer.push(block);
  }

  // End-of-response flush
  flush("end_of_response");

  return { groups, flushEvents };
}
