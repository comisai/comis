// SPDX-License-Identifier: Apache-2.0
/**
 * Utilities for cleaning raw session message content before display.
 */

/** Strip NO_REPLY / HEARTBEAT_OK silent tokens from agent responses. */
export function stripSilentTokens(text: string): string {
  return text.replace(/\b(?:NO_REPLY|HEARTBEAT_OK)\b/g, "").trim();
}

/**
 * Extract the actual user message from raw session content that may include
 * injected system context, memory context, and channel metadata.
 *
 * Raw format:
 *   [Relevant context from memory: ...] (optional)
 *   [System context] ... [End system context]
 *   [telegram] 678314278 (9:34 AM):
 *   Hello                              <-- actual message
 */
export function stripUserSystemContext(text: string): string {
  // Fast path: no system context injected
  if (!text.includes("[System context]") && !text.includes("[End system context]")) {
    return text;
  }

  // Strategy: extract text after the channel header that follows [End system context].
  // The channel header looks like: [telegram] 678314278 (9:34 AM):\n
  const endMarker = "[End system context]";
  const endIdx = text.lastIndexOf(endMarker);
  if (endIdx === -1) return text;

  const afterContext = text.slice(endIdx + endMarker.length);

  // Strip the channel header: [channel_name] sender_id (time):
  const channelHeaderMatch = afterContext.match(
    /\s*\[[\w-]+\]\s+\S+\s+\([^)]*\):\s*/,
  );
  if (channelHeaderMatch) {
    const msgStart = afterContext.indexOf(channelHeaderMatch[0]) + channelHeaderMatch[0].length;
    return afterContext.slice(msgStart).trim();
  }

  // Fallback: return everything after the end marker, trimmed
  return afterContext.trim();
}

/** Clean message content for display based on role. */
export function cleanMessageContent(content: string, role: string): string {
  if (role === "assistant") return stripSilentTokens(content);
  if (role === "user") return stripUserSystemContext(content);
  return content;
}
