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
 *  in-flight assistant turn, not a new user turn. */
export function isToolResultCarrier(msg: Record<string, unknown>): boolean {
  if (msg.role === "tool") return true;
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return (content as Array<Record<string, unknown>>).every(b => blockKind(b) === "tool_result");
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

