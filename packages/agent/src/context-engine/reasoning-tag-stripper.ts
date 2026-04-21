// SPDX-License-Identifier: Apache-2.0
/**
 * Reasoning tag stripper context engine layer.
 *
 * Strips inline reasoning tags (<think>, <thinking>, <thought>, <antThinking>)
 * from type:"text" blocks in old assistant messages. This handles the case where
 * inline reasoning from non-Anthropic models (e.g., DeepSeek's <think> blocks)
 * persists in session history when switching to a different model.
 *
 * Never touches type:"thinking" blocks -- those are handled by the existing
 * thinking-block-cleaner. Redacted thinking blocks are always preserved.
 *
 * Immutability: never mutates input messages or arrays. Returns new arrays and
 * shallow-copied messages only when changes are needed. When no changes are
 * required, returns the original array reference (zero allocation).
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";
import type { ContextLayer, TokenBudget } from "./types.js";
import { stripReasoningTagsFromText } from "../response-filter/reasoning-tags.js";

// ---------------------------------------------------------------------------
// Reasoning Tag Stripper Layer
// ---------------------------------------------------------------------------

/**
 * Create a reasoning tag stripper layer that removes inline reasoning tags
 * from type:"text" blocks in assistant messages.
 *
 * @param onCleaned - Optional callback reporting the number of text blocks that had tags stripped.
 * @returns A ContextLayer that strips inline reasoning tags from assistant messages.
 */
export function createReasoningTagStripper(
  onCleaned?: (stats: { tagsStripped: number }) => void,
): ContextLayer {
  return {
    name: "reasoning-tag-stripper",

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
      if (messages.length === 0) return messages;

      let anyChanged = false;
      let tagsStripped = 0;
      const result: AgentMessage[] = new Array(messages.length);

      for (let i = 0; i < messages.length; i++) {
        // Messages at or before the cache fence must not be modified
        if (i <= budget.cacheFenceIndex) {
          result[i] = messages[i];
          continue;
        }

        const msg = messages[i] as { role: string; content?: unknown[] };

        // Only process assistant messages with array content
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
          result[i] = messages[i];
          continue;
        }

        let messageChanged = false;
        const newContent: unknown[] = new Array(msg.content.length);

        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j] as { type: string; text?: string };

          // Only process type:"text" blocks with non-empty text.
          // NEVER touch type:"thinking" blocks (handled by thinking-block-cleaner,
          // and destroying redacted thinking blocks would break API continuity).
          if (block.type !== "text" || !block.text) {
            newContent[j] = block;
            continue;
          }

          const cleaned = stripReasoningTagsFromText(block.text);

          if (cleaned !== block.text) {
            // Text was modified -- shallow copy the block with cleaned text
            newContent[j] = { ...block, text: cleaned };
            messageChanged = true;
            tagsStripped++;
          } else {
            newContent[j] = block;
          }
        }

        if (messageChanged) {
          // Create shallow copy of the message with the new content array
          result[i] = { ...msg, content: newContent } as AgentMessage;
          anyChanged = true;
        } else {
          result[i] = messages[i];
        }
      }

      // If no changes were made to any message, return original array reference
      if (!anyChanged) return messages;

      // Report cleaning stats via callback
      onCleaned?.({ tagsStripped });

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Post-Load Role Validation
// ---------------------------------------------------------------------------

/**
 * Validate role attribution in a message array from buildSessionContext().
 *
 * Scans for unexpected role patterns (consecutive user-user or assistant-assistant
 * without tool results between) and emits a WARN log when an anomaly is detected.
 *
 * This is a diagnostic assertion only -- no repair is performed. Repair is handled
 * by `repairOrphanedMessages()` which runs before this check.
 *
 * @param messages - Message array from buildSessionContext()
 * @param logger - Structured logger for emitting diagnostics
 */
export function validateRoleAttribution(messages: AgentMessage[], logger: ComisLogger): void {
  if (messages.length < 2) return;

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1] as { role: string };
    const curr = messages[i] as { role: string };

    // Allow tool results to follow assistant messages (normal pattern)
    // Also allow assistant messages after tool results
    const prevRole = prev.role;
    const currRole = curr.role;

    // Check for consecutive same-role messages (user-user or assistant-assistant)
    // Tool results ("tool", "toolResult") are expected to break alternation
    if (
      (prevRole === "user" && currRole === "user") ||
      (prevRole === "assistant" && currRole === "assistant")
    ) {
      logger.warn(
        {
          anomalyIndex: i,
          expectedRole: prevRole === "user" ? "assistant" : "user",
          actualRole: currRole,
          hint: "Session role attribution anomaly detected; repairOrphanedMessages may not have run",
          errorKind: "state" as const,
        },
        "Post-load role validation anomaly",
      );
      // Report only the first anomaly to avoid log noise
      return;
    }
  }
}
