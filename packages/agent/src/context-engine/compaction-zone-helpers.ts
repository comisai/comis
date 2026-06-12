// SPDX-License-Identifier: Apache-2.0
/**
 * Pure zone/estimation helpers for the LLM compaction layer.
 *
 * Extracted from llm-compaction.ts (file-size invariant: ≤800 lines) — these
 * are factory-independent pure functions over `AgentMessage[]`:
 *
 * - `extendHeadForPairSafety` — head-zone boundary extension so a trailing
 *   assistant tool_use and its tool_results never split across zones
 * - `estimateRangeChars` — char total for a half-open message range
 * - `clampFactorText` — the text of one message used to compute its
 *   scriptTokenFactor at the SUMW-01 span-clamp walk (TOK-01, Phase 179)
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageChars } from "../safety/token-estimator.js";

/**
 * Extend head boundary forward to include trailing tool_use/tool_result exchanges.
 * If the last message in the head zone is a user message followed by an assistant
 * with tool_use calls, extend to include the assistant + all matching tool_results.
 * This prevents orphaned tool results in the middle zone.
 */
export function extendHeadForPairSafety(
  messages: AgentMessage[],
  headEndIndex: number,
): number {
  let extended = headEndIndex;
  while (extended < messages.length) {
    const msg = messages[extended]!;
    // If next message is an assistant with tool_use, include it
    if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : [];
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const hasToolUse = content.some(
        (block: any) => block.type === "tool_use" || block.type === "toolCall",
      );
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (hasToolUse) {
        extended++;
        // Include all subsequent tool_result messages
        while (
          extended < messages.length &&
          messages[extended]!.role === "toolResult"
        ) {
          extended++;
        }
        continue;
      }
    }
    break;
  }
  return extended;
}

/**
 * Estimate total chars for a range of messages [startIdx, endIdx).
 */
export function estimateRangeChars(
  messages: AgentMessage[],
  startIdx: number,
  endIdx: number,
): number {
  let total = 0;
  for (let i = startIdx; i < endIdx; i++) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    total += estimateMessageChars(messages[i] as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  return total;
}

/**
 * TOK-01 (Phase 179): the text of one message used to compute its
 * scriptTokenFactor at the SUMW-01 span-clamp walk — string content, or for
 * array content the concatenated text/thinking fields plus JSON.stringify of
 * toolCall arguments, mirroring what estimateContextCharsWithDualRatio counts.
 * A plain concat is sufficient for the FACTOR; the dual-ratio CHAR COUNT stays
 * authoritative and untouched (image/unknown blocks contribute flat synthetic
 * chars there and need no factor input here).
 */
export function clampFactorText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string; arguments?: unknown };
    if (typeof b.text === "string") {
      out += b.text;
    } else if (typeof b.thinking === "string") {
      out += b.thinking;
    } else if (b.type === "toolCall") {
      try {
        out += JSON.stringify(b.arguments ?? {});
      } catch {
        // Unstringifiable args contribute no factor text (the char walk's
        // TOOL_STRINGIFY_FALLBACK still counts them flat).
      }
    }
  }
  return out;
}
