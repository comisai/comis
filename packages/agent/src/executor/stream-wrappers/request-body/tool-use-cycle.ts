// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-use cycle detection for replay-time thinking preservation.
 *
 * The provider forbids altering the newest assistant turn's thinking blocks only while that turn is
 * still being CONTINUED — it emitted `tool_use` and everything after it is a `tool_result` carrier
 * bringing answers back. Once a real user turn closes the cycle the restriction lifts and the turn
 * can be stripped like any other history.
 *
 * Scoping the exception to that window is what keeps the cached prefix stable: an ordinary
 * conversational turn is stripped immediately and never changes again, instead of keeping its
 * thinking and losing it one turn later (a per-turn prefix mutation at a marching index).
 *
 * Block kinds are resolved through {@link blockKind}, never by reading `block.type` directly: the
 * Bedrock Converse shape carries no `type` field, so a direct read finds neither the `toolUse` that
 * opens a cycle nor the `toolResult` that continues it, and every Bedrock turn looks closed.
 *
 * @module
 */

import { blockKind } from "./block-kind.js";

/** Index of the newest assistant message, or -1. */

export function findLatestAssistantIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return i;
  }
  return -1;
}

/** True when a message carries ONLY tool_result blocks — a carrier returning answers into an
 *  in-flight assistant turn, not a new user turn. A cache-marker block is ignored: the keyed
 *  provider's marker is a separate `{cachePoint}` block appended to the last message of the
 *  request, which mid-turn IS the carrier — a marker is placement metadata, not content, and
 *  must not reclassify the carrier as the current user turn. */
export function isToolResultCarrier(msg: Record<string, unknown>): boolean {
  if (msg.role === "tool") return true;
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  let toolResults = 0;
  for (const b of content as Array<Record<string, unknown>>) {
    const kind = blockKind(b);
    if (kind === "tool_result") toolResults++;
    else if (kind !== "cache_marker") return false;
  }
  return toolResults > 0;
}

/**
 * Index of the user message that carries the CURRENT TURN's query — the newest user message that is
 * not a tool-result carrier — or -1.
 *
 * "Newest `role === "user"`" is not the same thing. Bedrock returns tool results as USER messages
 * carrying `{toolResult}` blocks, so mid-turn the newest user message is a carrier and the real
 * query sits behind it. Two consumers locating the current turn that way disagree about which
 * message it is: the recall-history strip treats the query as historical and removes its recall,
 * while the recall-defer targets the carrier and so never moved that recall onto the uncached tail.
 * One strips what the other is supposed to protect, mutating an already-cached message.
 */
export function findCurrentTurnUserIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user" || isToolResultCarrier(msg)) continue;
    return i;
  }
  return -1;
}

/**
 * True when the assistant turn at `idx` is still being continued: it emitted at least one tool_use
 * and every message after it is a tool_result carrier. That is exactly the window in which the
 * provider forbids altering its thinking blocks.
 */
export function isUnclosedToolUseCycle(messages: Array<Record<string, unknown>>, idx: number): boolean {
  const content = messages[idx]!.content;
  if (!Array.isArray(content)) return false;
  const hasToolUse = (content as Array<Record<string, unknown>>).some(b => blockKind(b) === "tool_use");
  if (!hasToolUse) return false;
  for (let i = idx + 1; i < messages.length; i++) {
    if (!isToolResultCarrier(messages[i]!)) return false;
  }
  return true;
}

