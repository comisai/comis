/**
 * DAG tool result annotator context engine layer.
 *
 * Replaces old tool result content with lightweight placeholders in the
 * assembled output only -- originals are preserved in the DAG for recall
 * via `ctx_inspect`. The annotator follows the same factory pattern as
 * observation-masker.ts with keep-window and trigger-threshold controls.
 *
 * Key behaviors:
 * - Never mutates input messages (immutable, creates new objects)
 * - Never writes back to the store (non-destructive)
 * - Protected-tier tools are exempt from annotation via shared resolveToolMaskingTier()
 * - Ephemeral-tier tools use a shorter keep window (default 10)
 * - Standard-tier tools use the existing annotationKeepWindow
 * - Already-annotated and already-masked results are skipped
 * - Recent tool results within the keep window are preserved
 *
 * DAG Assembly & Annotation.
 * Phase 8: Tier-aware annotation.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";
import { resolveToolMaskingTier, EPHEMERAL_TOOL_KEEP_WINDOW } from "./constants.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the DAG annotator layer. */
export interface DagAnnotatorConfig {
  /** Number of most recent standard-tier tool results to keep with full content. */
  annotationKeepWindow: number;
  /** Character threshold before annotation activates. */
  annotationTriggerChars: number;
  /** Keep window for ephemeral-tier tools. Default: EPHEMERAL_TOOL_KEEP_WINDOW (10). */
  ephemeralAnnotationKeepWindow?: number;
}

/** Dependencies for the DAG annotator layer. */
export interface DagAnnotatorDeps {
  /** Token estimation function (typically `Math.ceil(text.length / 4)`). */
  estimateTokens: (text: string) => number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first text block's content from a tool result message.
 * Returns empty string if content is not an array or has no text blocks.
 */
function getToolResultText(msg: AgentMessage): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const content = (msg as any).content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0];
  if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return "";
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Check if a tool result has already been annotated or masked.
 *
 * Detects four placeholder prefixes:
 * - `[Tool result from` -- DAG annotator placeholder
 * - `[Tool result cleared:` -- legacy observation masker placeholder
 * - `[Tool result summarized:` -- new observation masker placeholder (with digest)
 * - `[Tool result offloaded to disk:` -- microcompaction placeholder
 */
function isAlreadyAnnotated(msg: AgentMessage): boolean {
  const text = getToolResultText(msg);
  return (
    text.startsWith("[Tool result from") ||
    text.startsWith("[Tool result cleared:") ||
    text.startsWith("[Tool result summarized:") ||
    text.startsWith("[Tool result offloaded to disk:")
  );
}

/**
 * Build the annotation placeholder text.
 *
 * Format: `[Tool result from {toolName}: {tokenCount} tokens. Use ctx_inspect to view.]`
 */
function buildAnnotationPlaceholder(toolName: string, tokenCount: number): string {
  return `[Tool result from ${toolName}: ${tokenCount} tokens. Use ctx_inspect to view.]`;
}

/**
 * Calculate total context characters from message array.
 *
 * For text content blocks: sum character lengths.
 * For non-text content blocks: estimate 256 chars each.
 */
function calculateTotalChars(messages: AgentMessage[]): number {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let total = 0;
  for (const msg of messages) {
    const content = (msg as any).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          total += block.text.length;
        } else {
          total += 256; // estimate for non-text content blocks
        }
      }
    }
  }
  return total;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a DAG tool result annotator context layer.
 *
 * The annotator replaces old tool result content with lightweight placeholders
 * in the assembled output only. Originals are preserved in the DAG for recall
 * via `ctx_inspect`.
 *
 * @param config - Annotator configuration (keep window, trigger threshold)
 * @param deps - Dependencies (token estimator)
 * @returns ContextLayer that annotates old tool results with placeholders
 */
export function createDagAnnotatorLayer(
  config: DagAnnotatorConfig,
  deps: DagAnnotatorDeps,
): ContextLayer {
  return {
    name: "dag-annotator",

    async apply(messages: AgentMessage[], _budget: TokenBudget): Promise<AgentMessage[]> {
      // Step 1: Calculate total context chars
      const totalChars = calculateTotalChars(messages);

      // Step 2: Threshold check -- skip annotation for short sessions
      if (totalChars < config.annotationTriggerChars) {
        return messages;
      }

      // Step 3: Walk messages newest to oldest, identify tool results to annotate
      // Per-tier counters: ephemeral and standard tools have independent keep windows
      let ephemeralCount = 0;
      let standardCount = 0;
      const ephemeralWindow = config.ephemeralAnnotationKeepWindow ?? EPHEMERAL_TOOL_KEEP_WINDOW;
      const annotateSet = new Set<number>();

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!; // eslint-disable-line security/detect-object-injection
        if (msg.role !== "toolResult") continue;

        /* eslint-disable @typescript-eslint/no-explicit-any */
        const toolName = (msg as any).toolName ?? "";
        /* eslint-enable @typescript-eslint/no-explicit-any */

        const tier = resolveToolMaskingTier(toolName);

        // (a) Protected tool: NEVER annotate, never count
        if (tier === "protected") {
          continue;
        }

        // (b) Already annotated/masked/offloaded: SKIP
        if (isAlreadyAnnotated(msg)) {
          continue;
        }

        // (c) Tier-specific window check
        const count = tier === "ephemeral" ? ephemeralCount : standardCount;
        const window = tier === "ephemeral" ? ephemeralWindow : config.annotationKeepWindow;

        if (count < window) {
          if (tier === "ephemeral") ephemeralCount++;
          else standardCount++;
          continue;
        }

        // (d) Beyond window: ANNOTATE
        annotateSet.add(i);
        if (tier === "ephemeral") ephemeralCount++;
        else standardCount++;
      }

      // Step 4: If nothing to annotate, return unchanged
      if (annotateSet.size === 0) {
        return messages;
      }

      // Step 5: Build annotated array immutably
      /* eslint-disable @typescript-eslint/no-explicit-any */
      /* eslint-disable security/detect-object-injection -- array index access */
      const result: AgentMessage[] = messages.map((msg, i) => {
        if (!annotateSet.has(i)) return msg;

        const toolName = (msg as any).toolName ?? "unknown";
        const text = getToolResultText(msg);
        const tokenCount = deps.estimateTokens(text);
        const placeholder = buildAnnotationPlaceholder(toolName, tokenCount);

        return {
          ...msg,
          content: [{ type: "text", text: placeholder }],
        } as unknown as AgentMessage;
      });
      /* eslint-enable security/detect-object-injection */
      /* eslint-enable @typescript-eslint/no-explicit-any */

      return result;
    },
  };
}
