// SPDX-License-Identifier: Apache-2.0
/**
 * Tool result size guard: proportionally truncates oversized tool result
 * content blocks before they are persisted to the session transcript.
 *
 * Prevents disk bloat and context overflow by enforcing a per-tool-result
 * character budget. Each text block is proportionally truncated based on
 * its share of the total text, preserving head and tail for readability.
 *
 * Important-tail detection allocates 30% tail when error/JSON/summary
 * content is found in the last 500 chars of the text.
 * Truncation cuts snap to the nearest newline boundary within an
 * 80-120% tolerance range of the target position.
 *
 * Complementary to the session pruner (which operates on the full message
 * array before LLM calls) and the tool sanitizer (which handles injection
 * patterns). This guard runs after sanitization, before persistence.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata about what was truncated. */
export interface TruncationMetadata {
  /** Total text characters before truncation. */
  originalChars: number;
  /** Total text characters after truncation. */
  truncatedChars: number;
  /** Number of text blocks that were actually truncated. */
  blocksAffected: number;
}

/** A content block in a tool result. */
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Result of the truncation check. */
export interface TruncationResult {
  content: ContentBlock[];
  truncated: boolean;
  metadata?: TruncationMetadata;
}

/** Tool result size guard interface returned by the factory. */
export interface ToolResultSizeGuard {
  /**
   * Truncate content blocks if total text chars exceed maxChars.
   *
   * @param content - Array of content blocks (text, image, etc.)
   * @param maxChars - Maximum allowed total text characters
   * @param toolHint - Optional tool-specific hint appended to the truncation marker
   * @returns Content with oversized text blocks proportionally truncated
   */
  truncateIfNeeded(content: ContentBlock[], maxChars: number, toolHint?: string): TruncationResult;
}

/** Options for creating a tool result size guard. */
export interface ToolResultSizeGuardOptions {
  /** Characters to keep at the start of truncated text. Default: 2000. */
  preserveHeadChars?: number;
  /** Characters to keep at the end of truncated text. Default: 1000. */
  preserveTailChars?: number;
  /** Marker template inserted between head and tail. Use ${removed} for count. Default: "\n[... ${removed} chars truncated ...]\n" */
  truncationMarker?: string;
  /** Enable important-tail detection for proportional allocation. Default: true. */
  enableImportantTailDetection?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the tail of a text contains important content that should
 * receive a larger allocation during truncation.
 *
 * Inspects the last 500 characters for:
 * - Error indicators (error, exception, traceback, stack trace, failed, fatal)
 * - JSON closing (ends with } or ] after trimming whitespace)
 * - Summary markers (summary, conclusion, result, total, output:)
 * - Exit/return codes (exit code, return code, status code)
 */
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-500);

  // Error indicators
  if (/error|exception|traceback|stack trace|failed|fatal/i.test(tail)) {
    return true;
  }

  // JSON closing: text ends with } or ] after trimming whitespace
  const trimmedEnd = text.trimEnd();
  if (trimmedEnd.endsWith("}") || trimmedEnd.endsWith("]")) {
    return true;
  }

  // Summary markers
  if (/summary|conclusion|result|total|output:/i.test(tail)) {
    return true;
  }

  // Exit/return codes
  if (/exit code|return code|status code/i.test(tail)) {
    return true;
  }

  return false;
}

/**
 * Snap a target character index to the nearest newline boundary within
 * a tolerance range.
 *
 * Given a target character index and a tolerance (20% of target), searches
 * for the nearest newline (`\n`) within [targetIndex * 0.8, targetIndex * 1.2].
 * If a newline is found, returns the index just after the newline. If no
 * newline exists within the tolerance range, returns the original targetIndex.
 *
 * Searches outward from targetIndex in both directions to find the closest
 * newline first.
 *
 * @param text - The full text being truncated
 * @param targetIndex - The ideal cut position
 * @param tolerance - The search radius (20% of target)
 * @returns The snapped index (after the newline) or the original targetIndex
 */
function snapToNewline(text: string, targetIndex: number, tolerance: number): number {
  // Clamp the search range to valid text boundaries
  const lower = Math.max(0, Math.floor(targetIndex - tolerance));
  const upper = Math.min(text.length - 1, Math.ceil(targetIndex + tolerance));

  // Search outward from targetIndex in both directions
  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let i = lower; i <= upper; i++) {
    if (text[i] === "\n") {
      const distance = Math.abs(i - targetIndex);
      if (distance < bestDistance) {
        bestDistance = distance;
        // Return the index just after the newline (start of next line)
        bestIndex = i + 1;
      }
    }
  }

  if (bestIndex >= 0) {
    return bestIndex;
  }

  // No newline found within tolerance -- return original target
  return targetIndex;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a tool result size guard with configurable truncation options.
 *
 * Usage:
 * ```typescript
 * const guard = createToolResultSizeGuard();
 * const result = guard.truncateIfNeeded(toolResult.content, 50_000);
 * if (result.truncated) {
 *   console.log(`Truncated: ${result.metadata?.blocksAffected} blocks`);
 * }
 * ```
 */
export function createToolResultSizeGuard(
  opts?: ToolResultSizeGuardOptions,
): ToolResultSizeGuard {
  const preserveHeadChars = opts?.preserveHeadChars ?? 2000;
  const preserveTailChars = opts?.preserveTailChars ?? 1000;
  const truncationMarker = opts?.truncationMarker ?? "\n[... ${removed} chars truncated. To avoid truncation, reduce output size (use --max-lines, head/tail, grep, or limit scope).${hint}]\n";
  const enableImportantTailDetection = opts?.enableImportantTailDetection ?? true;

  /** Minimum text length for important-tail proportional allocation to activate. */
  const IMPORTANT_TAIL_MIN_CHARS = 5000;

  /** Maximum characters allowed for tool hint text. */
  const MAX_HINT_CHARS = 100;

  function formatMarker(removedChars: number, toolHint?: string): string {
    const hintSuffix = toolHint
      ? ` Hint: ${toolHint.length > MAX_HINT_CHARS ? toolHint.slice(0, MAX_HINT_CHARS - 3) + "..." : toolHint}`
      : "";
    return truncationMarker
      .replace("${removed}", String(removedChars))
      .replace("${hint}", hintSuffix);
  }

  function truncateText(text: string, budget: number, toolHint?: string): string {
    if (text.length <= budget) return text;

    // Determine effective head and tail sizes.
    // When the text is shorter than head+tail defaults, scale proportionally.
    let headSize = preserveHeadChars;
    let tailSize = preserveTailChars;
    const totalPreserve = headSize + tailSize;

    // Important-tail-aware allocation for large texts
    if (
      enableImportantTailDetection &&
      text.length >= IMPORTANT_TAIL_MIN_CHARS &&
      hasImportantTail(text)
    ) {
      // Important tail detected: allocate 50% head, 30% tail, ~20% marker
      headSize = Math.floor(budget * 0.5);
      tailSize = Math.floor(budget * 0.3);
    } else if (text.length <= totalPreserve) {
      // Text is shorter than head+tail combined -- scale proportionally
      const ratio = headSize / totalPreserve;
      headSize = Math.floor(text.length * ratio * 0.5);
      tailSize = Math.floor(text.length * (1 - ratio) * 0.5);
    }
    // else: use default preserveHeadChars / preserveTailChars

    // Snap cuts to newline boundaries within 80-120% tolerance
    const headTolerance = headSize * 0.2;
    const snappedHeadSize = snapToNewline(text, headSize, headTolerance);

    // For tail: target is measured from the end
    const tailStart = text.length - tailSize;
    const tailTolerance = tailSize * 0.2;
    const snappedTailStart = snapToNewline(text, tailStart, tailTolerance);

    // Ensure head does not overlap with tail
    const effectiveHeadSize = Math.min(snappedHeadSize, snappedTailStart);
    const effectiveTailStart = Math.max(snappedTailStart, effectiveHeadSize);

    const head = text.slice(0, effectiveHeadSize);
    const tail = text.slice(effectiveTailStart);
    const removedChars = text.length - effectiveHeadSize - (text.length - effectiveTailStart);
    const marker = formatMarker(removedChars, toolHint);

    return head + marker + tail;
  }

  return {
    truncateIfNeeded(content: ContentBlock[], maxChars: number, toolHint?: string): TruncationResult {
      if (content.length === 0) {
        return { content, truncated: false };
      }

      // Calculate total text chars across text blocks only
      const totalTextChars = content.reduce((sum, block) => {
        if (block.type === "text" && block.text) {
          return sum + block.text.length;
        }
        return sum;
      }, 0);

      // No truncation needed
      if (totalTextChars <= maxChars) {
        return { content, truncated: false };
      }

      // Proportional truncation
      let blocksAffected = 0;
      const truncatedContent = content.map((block) => {
        // Non-text blocks pass through
        if (block.type !== "text" || !block.text) {
          return block;
        }

        // Calculate this block's proportional budget
        const budget = Math.floor((block.text.length / totalTextChars) * maxChars);

        if (block.text.length <= budget) {
          // Block fits within its budget
          return block;
        }

        // Truncate the block
        blocksAffected++;
        return {
          ...block,
          text: truncateText(block.text, budget, toolHint),
        };
      });

      // Calculate final text chars
      const truncatedChars = truncatedContent.reduce((sum, block) => {
        if (block.type === "text" && block.text) {
          return sum + block.text.length;
        }
        return sum;
      }, 0);

      return {
        content: truncatedContent,
        truncated: true,
        metadata: {
          originalChars: totalTextChars,
          truncatedChars,
          blocksAffected,
        },
      };
    },
  };
}
