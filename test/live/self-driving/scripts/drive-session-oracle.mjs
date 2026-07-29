// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Mirror the Telegram adapter's bot-account-scoped normalized message identity. */
export function telegramInboundGuid(botAccountId, chatId, messageId) {
  const bytes = createHash("sha256")
    .update(`comis:telegram-message:${botAccountId}:${chatId}:${messageId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Return a fail-loud reason when synthetic mention metadata cannot address the bot. */
export function telegramInjectAddressingError(text, opts, botUsername) {
  if (opts?.mention !== true) return undefined;
  if (typeof botUsername !== "string" || botUsername.length === 0) {
    return "INJECT_OPTS.mention=true requires getMe to return the bot username";
  }
  const handle = `@${botUsername}`;
  if (!text.includes(handle)) {
    return `INJECT_OPTS.mention=true requires the literal bot handle ${handle} in the message text`;
  }
  return undefined;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Return the assistant text that follows one specific normalized inbound.
 *
 * Group conversations serialize multiple senders into one session file. Looking
 * for the normalized id in the user record prevents one parallel driver from
 * accepting another sender's earlier assistant reply.
 */
export function findAssistantReplyAfterInbound(source, inboundId) {
  let ownUserSeen = false;
  let reply = null;
  for (const line of source.split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "message") continue;
    if (record.message?.role === "user") {
      const text = messageText(record.message);
      if (text.includes(inboundId)) {
        ownUserSeen = true;
        reply = null;
      }
      continue;
    }
    if (!ownUserSeen || record.message?.role !== "assistant") continue;
    const text = messageText(record.message).trim();
    if (text) reply = text;
  }
  return reply;
}

function normalizeWireText(value) {
  return value
    .replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/~~(.*?)~~/gs, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether the recorded Telegram wire contains this session-correlated answer. */
export function wireContainsAssistantReply(outbound, assistantReply) {
  const expected = normalizeWireText(assistantReply);
  return outbound.some(
    (item) =>
      item?.method === "sendMessage" &&
      typeof item.text === "string" &&
      normalizeWireText(item.text) === expected,
  );
}
