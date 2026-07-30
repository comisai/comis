// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Resolve the driver's explicit absolute-file form without consuming @bot mentions. */
export function driveTextFilePath(textArg) {
  return typeof textArg === "string" && textArg.startsWith("@/")
    ? textArg.slice(1)
    : undefined;
}

/** Return the user-visible prose carried by one outbound wire record.
 * Telegram attachments carry their only prose in `caption`, so treating only
 * `text` as an answer fabricates an empty-final failure after a successful
 * document/photo/video delivery. */
export function outboundVisibleText(outbound) {
  if (typeof outbound?.text === "string" && outbound.text.length > 0) {
    return outbound.text;
  }
  return typeof outbound?.caption === "string" ? outbound.caption : "";
}

/** Match the progress-only frames emitted by the live activity renderer. */
export function isDriveProgressText(text) {
  return (
    !text
    || /^(🔧|✓|🤖|❌|⏳)/.test(text)
    || /\(running/.test(text)
    || /reading ~/.test(text)
    || /^\s*\[[ x~]\]/.test(text)
    || /\(step \d+ of \d+\)/i.test(text)
    || /^\s*───\s*$/.test(text)
  );
}

/** Whether one emulator wire record belongs to the selected Telegram topic. */
export function telegramOutboundMatchesThread(outbound, threadId) {
  if (threadId === undefined) {
    return outbound?.messageThreadId === undefined || outbound?.messageThreadId === null;
  }
  const expected = Number(threadId);
  const actual = Number(outbound?.messageThreadId);
  return Number.isFinite(expected) && Number.isFinite(actual) && actual === expected;
}

/** Return the last substantive wire reply from one exact Telegram conversation. */
export function findTelegramConversationWireAnswer(outbound, threadId) {
  for (let index = outbound.length - 1; index >= 0; index -= 1) {
    const item = outbound[index];
    if (!telegramOutboundMatchesThread(item, threadId)) continue;
    const visibleText = outboundVisibleText(item);
    if (visibleText && !isDriveProgressText(visibleText)) return visibleText;
  }
  return null;
}

/** Keep the model draft recorded in the session distinct from the delivered reply. */
export function reconcileAssistantSurfaces(sessionDraft, outbound, threadId) {
  return {
    sessionDraft,
    wireReply: findTelegramConversationWireAnswer(outbound, threadId),
  };
}

function encodeSessionPathComponent(value) {
  let encoded = "";
  for (const character of value) {
    if (/^[a-zA-Z0-9._-]$/.test(character)) {
      encoded += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) {
      encoded += `@${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return encoded;
}

/**
 * Resolve only the parent channel trajectory.
 *
 * Parent and sub-agent transcripts deliberately retain the same principal
 * filename. Their channel directories distinguish them, so a recursive
 * newest-file selection can watch a child and miss the parent turn end.
 */
export function selectMainTrajectoryPath(
  candidates,
  sessionsRoot,
  tenantId,
  channelId,
  expectedFilename,
) {
  const root = sessionsRoot.endsWith("/") ? sessionsRoot.slice(0, -1) : sessionsRoot;
  const directory =
    `${root}/${encodeSessionPathComponent(tenantId)}/${encodeSessionPathComponent(channelId)}/`;
  return candidates
    .filter(({ path }) => path === `${directory}${expectedFilename}`)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path ?? null;
}

/** Resolve one exact Telegram group/forum conversation trajectory. */
export function selectTelegramConversationTrajectoryPath(
  candidates,
  sessionsRoot,
  tenantId,
  botAccountId,
  chatId,
  threadId,
) {
  const root = sessionsRoot.endsWith("/") ? sessionsRoot.slice(0, -1) : sessionsRoot;
  const channelInstance = `telegram:telegram-${botAccountId}:${chatId}`;
  const directory =
    `${root}/${encodeSessionPathComponent(tenantId)}/${encodeSessionPathComponent(channelInstance)}/`;
  const filename =
    threadId === undefined
      ? "conversation.jsonl.trajectory.jsonl"
      : `conversation~thread~${threadId}.jsonl.trajectory.jsonl`;
  const expected = `${directory}${filename}`;
  return candidates
    .filter(({ path }) => path === expected)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path ?? null;
}

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
  const handle =
    typeof botUsername === "string" && botUsername.length > 0
      ? `@${botUsername}`
      : undefined;
  if (opts?.mention !== true) {
    return handle !== undefined && text.includes(handle)
      ? `message text contains ${handle}; set INJECT_OPTS.mention=true so the emulator emits Telegram mention metadata`
      : undefined;
  }
  if (typeof botUsername !== "string" || botUsername.length === 0) {
    return "INJECT_OPTS.mention=true requires getMe to return the bot username";
  }
  const requiredHandle = `@${botUsername}`;
  if (!text.includes(requiredHandle)) {
    return `INJECT_OPTS.mention=true requires the literal bot handle ${requiredHandle} in the message text`;
  }
  return undefined;
}

/** Mirror the deployed normalized-message text bound before an async channel inject. */
export function normalizedInboundTextError(text, limitChars) {
  return text.length > limitChars
    ? `message text is ${text.length} characters; the deployed normalized-message limit is ${limitChars}`
    : undefined;
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
export function wireContainsAssistantReply(outbound, assistantReply, route) {
  const expected = normalizeWireText(assistantReply);
  return outbound.some(
    (item) =>
      item?.method === "sendMessage" &&
      typeof item.text === "string" &&
      (
        route === undefined
        || telegramOutboundMatchesThread(item, route.threadId)
      ) &&
      normalizeWireText(item.text) === expected,
  );
}

/**
 * Stop a shared-conversation drive only on evidence tied to that conversation:
 * either the persisted assistant reply matches the wire, or the exact
 * conversation trajectory ended after a substantive wire reply became visible.
 */
export function sharedConversationFinished({
  outbound,
  correlatedAnswer,
  sawAnswer,
  turnEnded,
  threadId,
}) {
  if (
    correlatedAnswer !== null
    && wireContainsAssistantReply(outbound, correlatedAnswer, { threadId })
  ) {
    return true;
  }
  return turnEnded && sawAnswer;
}

/**
 * Stop a direct-message drive after both the turn and its wire delivery settle.
 *
 * Session summary can precede delivery post-processing, so an ended turn with
 * no visible answer remains open for a bounded drain window. The bound still
 * lets true empty-final and aborted turns terminate deterministically.
 */
export function directConversationFinished({
  sawAnswer,
  turnEnded,
  turnEndedAtMs,
  nowMs,
  deliveryGraceMs,
}) {
  if (!turnEnded) return false;
  if (sawAnswer) return true;
  return typeof turnEndedAtMs === "number"
    && nowMs - turnEndedAtMs >= deliveryGraceMs;
}
