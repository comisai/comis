// SPDX-License-Identifier: Apache-2.0
/**
 * Re-read detector: identifies duplicate tool calls across a session.
 *
 * Detects exact-match duplicate tool calls (same tool name + same parameters)
 * between the current assistant message and all prior assistant messages in
 * the full session history. Uses deterministic sorted-key JSON serialization
 * for parameter comparison to avoid insertion-order false negatives.
 *
 * - Standalone pure-function re-read detector module
 * - Integrated into pipeline via context-engine.ts
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of re-read detection for a single pipeline run. */
export interface RereadDetectorResult {
  /** Number of exact-match duplicate tool calls detected. */
  rereadCount: number;
  /** Deduplicated tool names that were re-read. */
  rereadTools: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a deterministic key for a tool call using sorted-key JSON serialization.
 *
 * IMPORTANT: Uses Object.entries().sort() to ensure key ordering is deterministic
 * regardless of insertion order. Plain JSON.stringify
 * produces different output for { a: 1, b: 2 } vs { b: 2, a: 1 }.
 */
function buildToolCallKey(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = JSON.stringify(
    Object.fromEntries(Object.entries(args).sort()),
  );
  return `${toolName}::${sortedArgs}`;
}

/**
 * Extract tool calls from an assistant message content array.
 *
 * Handles both pi-agent-core formats:
 * - `type: "toolCall"` with `arguments` field
 * - `type: "tool_use"` with `input` field
 */
function extractToolCalls(
  message: unknown,
): Array<{ toolName: string; args: Record<string, unknown> }> {
  if (!message || typeof message !== "object") return [];

  const msg = message as Record<string, unknown>;
  if (msg.role !== "assistant") return [];

  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const results: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;

    if (b.type === "toolCall" || b.type === "tool_use") {
      const toolName = (b.toolName ?? b.name ?? "") as string;
      const args = (b.arguments ?? b.input ?? {}) as Record<string, unknown>;
      if (toolName) {
        results.push({ toolName, args });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect exact-match duplicate tool calls between the current turn and
 * the full session history.
 *
 * @param currentMessages - Post-pipeline messages for the current turn
 * @param fullSessionEntries - Full session entries from fileEntries
 *        (each entry has shape `{ type: "message", message: { role, content } }`)
 * @returns RereadDetectorResult with count and deduplicated tool names
 */
export function detectRereads(
  currentMessages: AgentMessage[],
  fullSessionEntries: unknown[],
): RereadDetectorResult {
  const empty: RereadDetectorResult = { rereadCount: 0, rereadTools: [] };

  if (!currentMessages || currentMessages.length === 0) return empty;

  // The last message in currentMessages must be an assistant message.
  // If it's a user/toolResult message, there is no "current" assistant turn to check.
  const lastMessage = currentMessages[currentMessages.length - 1]!;
  if ((lastMessage as unknown as Record<string, unknown>).role !== "assistant") return empty;

  const lastAssistant = lastMessage;

  // Extract tool calls from the last assistant message
  const currentToolCalls = extractToolCalls(lastAssistant);
  if (currentToolCalls.length === 0) return empty;

  // Build a Set of tool call keys from ALL prior assistant messages in the full session
  const priorKeys = new Set<string>();

  for (const entry of fullSessionEntries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "message") continue;

    const message = e.message;
    if (!message || typeof message !== "object") continue;

    const priorToolCalls = extractToolCalls(message);
    for (const tc of priorToolCalls) {
      priorKeys.add(buildToolCallKey(tc.toolName, tc.args));
    }
  }

  // Check each current tool call against the prior set
  let rereadCount = 0;
  const rereadToolSet = new Set<string>();

  for (const tc of currentToolCalls) {
    const key = buildToolCallKey(tc.toolName, tc.args);
    if (priorKeys.has(key)) {
      rereadCount++;
      rereadToolSet.add(tc.toolName);
    }
  }

  return {
    rereadCount,
    rereadTools: Array.from(rereadToolSet),
  };
}
