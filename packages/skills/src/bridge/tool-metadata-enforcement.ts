// SPDX-License-Identifier: Apache-2.0
/**
 * Tool metadata enforcement wrapper.
 *
 * Standalone pipeline wrapper that applies metadata-driven behavior
 * (pre-flight input validation, post-execution result truncation) to
 * every tool invocation. Runs unconditionally -- NOT gated by eventBus --
 * because the daemon path passes eventBus: undefined which skips the
 * audit wrapper entirely.
 *
 * @module
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { getToolMetadata, truncateContentBlocks } from "@comis/core";

/** Content block from AgentToolResult -- text or image. */
type ContentBlock = NonNullable<AgentToolResult<unknown>["content"]>[number];

/**
 * Check whether a tool result's content is effectively empty.
 *
 * Returns `true` when the LLM would see a blank tool_result content block:
 * - content is falsy (undefined/null)
 * - content is an empty array
 * - content contains ONLY text blocks where every `.text` is empty or whitespace-only
 *
 * Returns `false` if content contains any ImageContent blocks (images are never "empty")
 * or any TextContent with non-whitespace text.
 *
 * @param content - The tool result content array to inspect
 * @returns Whether the content is effectively empty
 */
export function isToolResultContentEmpty(
  content: ContentBlock[] | undefined | null,
): boolean {
  if (!content) return true;
  if (content.length === 0) return true;

  for (const block of content) {
    // Any non-text block (e.g. image) means content is not empty
    if (block.type !== "text") return false;
    // Any text block with non-whitespace content means not empty
    if ((block as { type: "text"; text: string }).text.trim().length > 0) return false;
  }

  return true;
}

/**
 * Wrap an AgentTool with metadata enforcement.
 *
 * Pre-flight: If `validateInput` is registered, calls it with params.
 * On failure, throws with `[invalid_value]` prefix (matches pi-agent SDK
 * error classification).
 *
 * Post-execution: If `maxResultSizeChars` is registered and the result
 * has content blocks, truncates them via `truncateContentBlocks()`.
 * Returns the original result by reference when no truncation occurs.
 *
 * @param tool - The AgentTool to wrap
 * @returns A new AgentTool with metadata enforcement
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
export function wrapWithMetadataEnforcement(tool: AgentTool<any>): AgentTool<any> {
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentToolResult generic per pi-agent-core API
    ): Promise<AgentToolResult<any>> {
      const meta = getToolMetadata(tool.name);

      // Pre-flight validation
      if (meta?.validateInput) {
        const validationError = await meta.validateInput(params as Record<string, unknown>);
        if (validationError !== undefined && validationError !== "") {
          const err = new Error(`[invalid_value] ${validationError}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attach errorKind for audit wrapper propagation
          (err as any).errorKind = "validation";
          throw err;
        }
      }

      // Execute the original tool
      const result = await tool.execute(toolCallId, params, signal, onUpdate);

      // Post-execution result truncation
      if (meta?.maxResultSizeChars && result?.content) {
        // Cast through unknown: AgentToolResult.content is (TextContent | ImageContent)[]
        // while truncateContentBlocks accepts a looser ContentBlock[] with index signature.
        // The shapes are structurally compatible at runtime (both have type + text fields).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capped = truncateContentBlocks(result.content as any, meta.maxResultSizeChars);
        // Only create a new result object if truncation actually occurred
        if (capped !== result.content) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { ...result, content: capped as any };
        }
      }

      // Empty result marker injection -- prevent LLM confusion on empty tool_result.
      // Runs AFTER truncation so truncated results (which add a notice) are never marked empty.
      // Error results (isError: true) are exempt -- empty errors are a different signal.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- isError is set by SDK agent-loop, not in AgentToolResult type
      if (!(result as any)?.isError && isToolResultContentEmpty(result?.content)) {
        return {
          ...result,
          content: [{ type: "text" as const, text: `(${tool.name} completed with no output)` }],
        };
      }

      return result;
    },
  };
}
