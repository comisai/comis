// SPDX-License-Identifier: Apache-2.0
import { wrapExternalContent } from "@comis/core";

/** One caller-supplied message accepted by an OpenAI-compatible endpoint. */
export interface ApiConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Executor inputs derived from one caller-supplied conversation. */
export interface PreparedApiConversation {
  message: string;
  systemPrompt?: string;
}

/**
 * Preserve caller-supplied role and content boundaries without granting
 * client-authored assistant turns trusted SDK-assistant authority.
 */
export function prepareApiConversation(
  messages: readonly ApiConversationMessage[],
): PreparedApiConversation | undefined {
  if (!messages.some(
    (message) => message.role === "user" && message.content.length > 0,
  )) {
    return undefined;
  }

  let leadingSystemCount = 0;
  for (const message of messages) {
    if (message.role !== "system") break;
    leadingSystemCount += 1;
  }

  const wrapTurn = (turn: ApiConversationMessage, index: number): string => (
    wrapExternalContent(turn.content, {
      source: "api",
      subject: `Conversation turn ${index + 1}; role=${turn.role}`,
      includeWarning: true,
    })
  );

  // Only a leading contiguous system prefix can be placed ahead of the user-side
  // conversation without changing caller order. Any later system turn remains in
  // the serialized conversation at its exact original position.
  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const conversation = messages.slice(leadingSystemCount);
  const message = conversation.map((turn, index) => (
    wrapTurn(turn, leadingSystemCount + index)
  )).join("\n\n");
  const systemPrompt = leadingSystemMessages.length === 0
    ? undefined
    : leadingSystemMessages.map(wrapTurn).join("\n\n");

  return {
    message,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
}
