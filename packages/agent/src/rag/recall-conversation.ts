// SPDX-License-Identifier: Apache-2.0
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const RECENT_USER_TURN_COUNT = 2;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block === null || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Select the bounded user-authored context that disambiguates the next recall query.
 * Assistant and tool output are excluded so model-generated guesses cannot become
 * retrieval authority for the user's follow-up.
 */
export function selectRecentUserTurns(messages: readonly AgentMessage[]): string[] {
  const userTurns: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !("content" in message)) continue;
    const text = extractText(message.content).trim();
    if (text.length > 0) userTurns.push(text);
  }
  return userTurns.slice(-RECENT_USER_TURN_COUNT);
}
