// SPDX-License-Identifier: Apache-2.0
/**
 * Tool result size bouncer stream wrapper.
 *
 * Truncates oversized tool results before passing context to the LLM.
 * Prevents oversized tool results from entering the context window, which
 * causes compaction spirals and wasted tokens.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Message } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./types.js";
import { createToolResultSizeGuard, type ContentBlock } from "../../safety/tool-result-size-guard.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Truncation summary accumulated across all LLM calls in one execution. */
export interface TruncationSummary {
  /** Number of unique tools that had results truncated. */
  truncatedTools: number;
  /** Total characters removed by truncation. */
  totalTruncatedChars: number;
}

/** Return type for createToolResultSizeBouncer: wrapper + summary getter. */
export interface ToolResultSizeBouncerResult {
  /** The StreamFnWrapper to push into the wrappers array. */
  wrapper: StreamFnWrapper;
  /** Retrieve the accumulated truncation summary for the execution bookend. */
  getTruncationSummary: () => TruncationSummary;
}

/**
 * Create a wrapper that truncates oversized toolResult messages before
 * passing context to the LLM.
 *
 * Prevents oversized tool results from entering the context window, which
 * causes compaction spirals and wasted tokens. Uses the existing
 * createToolResultSizeGuard for proportional truncation.
 *
 * Accepts a truncationHints map for tool-specific recovery guidance.
 * Deduplicates WARN logs per (toolName, toolCallId) within one execution.
 * Accumulates truncation summary (truncatedTools + totalTruncatedChars).
 *
 * @param maxChars - Maximum allowed text characters per tool result
 * @param logger - Logger for WARN output when truncation occurs
 * @param truncationHints - Optional map of toolName -> hint text for tool-specific guidance
 * @returns Object with wrapper and getTruncationSummary getter
 */
export function createToolResultSizeBouncer(
  maxChars: number,
  logger: ComisLogger,
  truncationHints?: ReadonlyMap<string, string>,
  onTruncation?: (toolCallId: string, meta: { fullChars: number; returnedChars: number }) => void,
): ToolResultSizeBouncerResult {
  const guard = createToolResultSizeGuard();

  // Dedup set keyed by "toolName:toolCallId" -- persists across all LLM calls
  const truncationDedup = new Set<string>();
  // Accumulator for execution-level summary
  let truncatedToolsCount = 0;
  let totalTruncatedChars = 0;

  const wrapper = function toolResultSizeBouncer(next: StreamFn): StreamFn {
    return (model, context, options) => {
      let anyTruncated = false;

      const bouncedMessages: Message[] = context.messages.map((msg) => {
        if (msg.role !== "toolResult") {
          return msg;
        }

        // Look up tool-specific hint
        const toolHint = truncationHints?.get(msg.toolName);

        // Cast SDK (TextContent | ImageContent)[] to guard's ContentBlock[] --
        // structurally compatible, but TS can't prove it due to index signature.
        const result = guard.truncateIfNeeded(msg.content as ContentBlock[], maxChars, toolHint);
        if (!result.truncated) {
          return msg;
        }

        anyTruncated = true;

        // Build dedup key and only log WARN on first occurrence
        const dedupKey = `${msg.toolName}:${msg.toolCallId}`;
        if (!truncationDedup.has(dedupKey)) {
          truncationDedup.add(dedupKey);
          truncatedToolsCount++;
          logger.warn(
            {
              toolName: msg.toolName,
              originalChars: result.metadata!.originalChars,
              truncatedChars: result.metadata!.truncatedChars,
              hint: `Tool result from '${msg.toolName}' exceeded ${maxChars} chars and was truncated; increase agents.<name>.maxToolResultChars if this tool legitimately produces large output`,
              errorKind: "resource" as const,
            },
            "Tool result truncated",
          );
        }

        // Always accumulate chars regardless of dedup
        totalTruncatedChars += result.metadata!.originalChars - result.metadata!.truncatedChars;

        // Notify truncation registry for audit event metadata
        onTruncation?.(msg.toolCallId, {
          fullChars: result.metadata!.originalChars,
          returnedChars: result.metadata!.truncatedChars,
        });

        return { ...msg, content: result.content as typeof msg.content };
      });

      if (anyTruncated) {
        const bouncedContext: Context = {
          ...context,
          messages: bouncedMessages,
        };
        return next(model, bouncedContext, options);
      }

      // No truncation needed -- pass through unchanged
      return next(model, context, options);
    };
  };

  return {
    wrapper,
    getTruncationSummary: () => ({
      truncatedTools: truncatedToolsCount,
      totalTruncatedChars,
    }),
  };
}
