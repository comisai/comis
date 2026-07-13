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

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ComisLogger } from "@comis/core";
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
 * Validate role attribution in the assembled message array from
 * `buildSessionContext()`, AFTER `repairOrphanedMessages()` has run.
 *
 * Scans for consecutive same-role messages (user-user or assistant-assistant;
 * tool results break alternation) and classifies the FIRST one by whether the
 * RAW session tree still carries it:
 *
 *   - `rawTreeHasUnrepairedAnomaly === true` — the repair ran and the raw
 *     session tree STILL has a consecutive-role anomaly. That is genuine,
 *     unrepaired corruption (the repair did not resolve it) → WARN.
 *   - `rawTreeHasUnrepairedAnomaly === false` — the raw tree is well-formed
 *     (the repair correctly made no change), so the adjacency exists only in
 *     the assembled/merged view. The provider adapter normalizes consecutive
 *     same-role turns, so this is BENIGN → DEBUG (once per turn).
 *
 * This is a diagnostic assertion — no repair is performed here.
 *
 * Rationale (live incident 2026-07-08): the old unconditional WARN fired
 * `errorKind:"internal"` on ~every turn (index 47, 30× over 2 days) for a
 * benign, provider-normalized adjacency on a session whose raw tree was clean
 * and every request succeeded. Worse, its hint ("repairOrphanedMessages may
 * not have run") was FALSE — the repair ran every turn — and sent the operator
 * the wrong way. The severity now tracks whether the raw tree is genuinely
 * unrepaired, and the hint states what actually happened.
 *
 * @param messages - Assembled message array from buildSessionContext()
 * @param rawTreeHasUnrepairedAnomaly - Whether the raw session tree (getBranch)
 *   still carries a consecutive-role anomaly after the repair pass ran.
 * @param logger - Structured logger for emitting diagnostics
 */
export function validateRoleAttribution(
  messages: AgentMessage[],
  rawTreeHasUnrepairedAnomaly: boolean,
  logger: ComisLogger,
): void {
  if (messages.length < 2) return;

  for (let i = 1; i < messages.length; i++) {
    const prevRole = (messages[i - 1] as { role: string }).role;
    const currRole = (messages[i] as { role: string }).role;

    // Consecutive same-role (user-user or assistant-assistant). Tool results
    // ("tool"/"toolResult") have their own role and break alternation.
    if (
      (prevRole === "user" && currRole === "user") ||
      (prevRole === "assistant" && currRole === "assistant")
    ) {
      const fields = {
        anomalyIndex: i,
        expectedRole: prevRole === "user" ? "assistant" : "user",
        actualRole: currRole,
      };
      if (rawTreeHasUnrepairedAnomaly) {
        logger.warn(
          {
            ...fields,
            hint: "The raw session tree still carries a consecutive-role anomaly after repairOrphanedMessages ran — the repair did not resolve it. Inspect the session for an orphaned/interrupted turn.",
            errorKind: "internal" as const,
          },
          "Unrepaired session role anomaly",
        );
      } else {
        // Benign: the raw tree is well-formed; the adjacency is only in the
        // assembled/merged view and the provider adapter normalizes it.
        logger.debug(
          {
            ...fields,
            hint: "Consecutive same-role messages in the assembled context; the raw session tree is well-formed (repair correctly made no change) and the provider adapter normalizes consecutive same-role turns — no repair needed.",
          },
          "Assembled-context role adjacency (benign)",
        );
      }
      // Report only the first anomaly to avoid log noise.
      return;
    }
  }
}

/**
 * Does the RAW session tree (getBranch message entries) carry a consecutive
 * same-role anomaly? This is the SAME scan `repairMidSessionAnomalies` uses to
 * decide whether there is anything to repair — so a `true` here after the
 * repair ran means the repair failed to resolve it. Pure (no I/O), so the
 * caller (pi-executor) passes the result into `validateRoleAttribution` for
 * severity classification.
 */
export function sessionTreeHasSameRoleAnomaly(sessionManager: {
  getBranch?: () => ReadonlyArray<{ type: string; message?: { role?: string } }>;
}): boolean {
  // Defensive: a session manager without getBranch (test harnesses / minimal
  // shapes) yields the safe default — no detectable raw-tree anomaly, so the
  // detector treats any assembled adjacency as benign (DEBUG, never a false WARN).
  if (typeof sessionManager?.getBranch !== "function") return false;
  const roles = sessionManager
    .getBranch()
    .filter((e) => e.type === "message")
    .map((e) => e.message?.role);
  for (let i = 1; i < roles.length; i++) {
    const a = roles[i - 1];
    const b = roles[i];
    if ((a === "user" && b === "user") || (a === "assistant" && b === "assistant")) {
      return true;
    }
  }
  return false;
}
