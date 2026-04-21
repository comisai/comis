// SPDX-License-Identifier: Apache-2.0
/**
 * Objective reinforcement context engine layer.
 *
 * Re-injects the subagent's objective statement after compaction is detected,
 * ensuring the objective survives context window management. Only activates
 * when compaction has occurred -- avoids token waste on normal turns where
 * the objective is already present in the system prompt.
 *
 * - Objective survives compaction via transformContext hook
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";

// ---------------------------------------------------------------------------
// Compaction Detection Helpers
// ---------------------------------------------------------------------------

/**
 * Safely extract text content from an AgentMessage.
 *
 * AgentMessage is a union type that includes BashExecutionMessage (no `content`
 * field), so we must use `"content" in` guard before accessing it.
 */
function getMessageTextContent(msg: AgentMessage): string | undefined {
  if (!("content" in msg)) return undefined;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return undefined;
}

/**
 * Check if a message is a compaction summary by inspecting both the
 * `compactionSummary` flag and the content text for the "[Compaction Summary]"
 * marker. Different versions of the compaction layer use different markers.
 */
function isCompactionMessage(msg: AgentMessage): boolean {
  // Flag-based detection (typed as any since compactionSummary is a runtime extension)
  if ((msg as any).compactionSummary === true) return true; // eslint-disable-line @typescript-eslint/no-explicit-any

  // Content-based detection
  const text = getMessageTextContent(msg);
  return text !== undefined && text.includes("[Compaction Summary]");
}

/**
 * Check if the objective reinforcement message has already been injected
 * (prevents duplication on subsequent turns after compaction).
 */
function hasExistingReinforcement(messages: AgentMessage[]): boolean {
  return messages.some((msg) => {
    const text = getMessageTextContent(msg);
    return text !== undefined && text.includes("[Objective Reinforcement]");
  });
}

// ---------------------------------------------------------------------------
// Layer Factory
// ---------------------------------------------------------------------------

/**
 * Create an objective reinforcement context layer.
 *
 * The layer monitors for compaction events and injects a user-role message
 * containing the objective immediately after the compaction summary. This
 * ensures the subagent re-reads its objective after context is compacted.
 *
 * @param objective - The subagent's objective statement
 * @returns ContextLayer that injects objective after compaction
 */
export function createObjectiveReinforcementLayer(objective: string): ContextLayer {
  return {
    name: "objective-reinforcement",

    async apply(messages: AgentMessage[], _budget: TokenBudget): Promise<AgentMessage[]> {
      // No-op when objective is empty
      if (!objective) return messages;

      // Find the compaction summary message
      const compactionIndex = messages.findIndex(isCompactionMessage);
      if (compactionIndex === -1) return messages;

      // Skip if reinforcement already injected (prevent duplication)
      if (hasExistingReinforcement(messages)) return messages;

      // Create reinforcement message
      const reinforcementMessage: AgentMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: `[Objective Reinforcement]\nYour primary objective: ${objective}\nStay focused on this objective. The conversation was compacted -- re-read your system prompt for full context.` }],
        timestamp: Date.now(),
      };

      // Splice after the compaction summary (new array, no mutation)
      const result = [...messages];
      result.splice(compactionIndex + 1, 0, reinforcementMessage);
      return result;
    },
  };
}
