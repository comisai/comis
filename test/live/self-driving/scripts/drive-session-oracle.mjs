// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Resolve the driver's explicit absolute-file form without consuming @bot mentions. */
export function driveTextFilePath(textArg) {
  return typeof textArg === "string" && textArg.startsWith("@/")
    ? textArg.slice(1)
    : undefined;
}

/** Remove the single line terminator added by a shell text producer while
 * preserving every newline that belongs to the Telegram message itself. */
export function normalizeDriveStdinText(source) {
  if (source.endsWith("\r\n")) return source.slice(0, -2);
  if (source.endsWith("\n")) return source.slice(0, -1);
  return source;
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

const MEDIA_DELIVERY_LABELS = new Map([
  ["sendPhoto", "photo"],
  ["sendDocument", "document"],
  ["sendAudio", "audio"],
  ["sendVoice", "voice"],
  ["sendVideo", "video"],
  ["sendAnimation", "animation"],
]);

export function isOutboundMediaDelivery(outbound) {
  return MEDIA_DELIVERY_LABELS.has(outbound?.method);
}

/** Return comparable visible content, including captionless media deliveries. */
export function outboundVisibleContent(outbound) {
  const text = outboundVisibleText(outbound);
  if (text) return text;
  const mediaLabel = MEDIA_DELIVERY_LABELS.get(outbound?.method);
  return mediaLabel === undefined ? "" : `[${mediaLabel} delivered]`;
}

/**
 * Whether a `✓`/`❌`-led line is a progress FRAME rather than an answer that
 * merely opens with the marker.
 *
 * The activity renderer emits plain status frames (`✓ done`,
 * `❌ managing skills`, `❌ dependency — a step failed outside the tool
 * timeline`). But the agent also OPENS real answers with the same markers — its
 * Hebrew acknowledgement style is `✓ <b>הובן.</b> …`. Treating every marker-led
 * line as progress made the drive discard the answer, wait out its window and
 * report `[NO SUBSTANTIVE ANSWER]` for a turn the wire shows was answered — a
 * FALSE FAILURE, which costs a campaign exactly what a false success does
 * (measured live: 3 of 7 corpus rows, comis-moshe 2026-08-06).
 *
 * A delivered answer is rendered through the channel's markdown-IR formatter
 * and carries markup; a status frame is plain text. Length does NOT separate
 * them — the `dependency` frame above is longer than several real answers.
 *
 * Residual limitation: a marker-led answer containing NO markup at all still
 * reads as progress. Text is the only input here, and markup is the strongest
 * signal it carries.
 */
function isMarkerLedProgressFrame(text) {
  const remainder = text.replace(/^(?:✓|❌)\s*/u, "").trim();
  if (remainder.length === 0) return true;
  return !/<[a-z/]/i.test(remainder); // markup ⇒ rendered answer, not a frame
}

function isApprovalResolutionFrame(text) {
  return /^(?:Approved|Denied):\s.+\s\([^)]+\)$/.test(text)
    || /^(?:Approved|Denied) \d+ pending approval\(s\)\.$/.test(text);
}

export function isDriveProgressText(text) {
  if (!text) return true;
  // 🔧/🤖/⏳ are pure tool/agent status markers — the agent never opens an
  // answer with them, so they stay unconditional.
  if (/^(🔧|🤖|⏳)/u.test(text)) return true;
  if (/^(?:✓|❌)/u.test(text)) return isMarkerLedProgressFrame(text);
  return (
    isApprovalResolutionFrame(text)
    || /\(running/.test(text)
    || /reading ~/.test(text)
    || /^\s*\[[ x~]\]/.test(text)
    || /\(step \d+ of \d+\)/i.test(text)
    || /^\s*───\s*$/.test(text)
  );
}

/**
 * Recover records that reuse an existing Telegram message id.
 *
 * The emulator's long-poll cursor is a Telegram message id, while edits retain
 * the original id. Its append-only full snapshot therefore remains the
 * authoritative wire record. When the pre-inject snapshot is still an exact
 * prefix, return every appended record; if the chat was reset or changed
 * underneath the drive, keep the already-correlated polled records.
 */
export function reconcileDriveOutbound(initial, polled, snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length < initial.length) return polled;
  for (let index = 0; index < initial.length; index += 1) {
    if (JSON.stringify(initial[index]) !== JSON.stringify(snapshot[index])) {
      return polled;
    }
  }
  return snapshot.slice(initial.length);
}

/** Use answer quiescence only when no authoritative trajectory can end the turn. */
export function wireQuiescenceFinished({
  trajectoryAvailable,
  sawAnswer,
  lastNewMs,
  nowMs,
  quiesceMs,
}) {
  return !trajectoryAvailable
    && sawAnswer
    && nowMs - lastNewMs >= quiesceMs;
}

/**
 * Whether one emulator wire record belongs to the selected Telegram topic.
 *
 * Telegram accepts a reply to a message inside a forum topic without a separate
 * `message_thread_id`. In that shape, the exact inbound reply target is the
 * routing evidence. Do not broaden arbitrary threadless messages: only the
 * injected inbound message id may substitute for an explicit thread id.
 */
export function telegramOutboundMatchesThread(outbound, threadId, inboundMessageId) {
  if (threadId === undefined) {
    return outbound?.messageThreadId === undefined || outbound?.messageThreadId === null;
  }
  const expected = Number(threadId);
  const actual = Number(outbound?.messageThreadId);
  if (Number.isFinite(expected) && Number.isFinite(actual)) {
    return actual === expected;
  }
  const expectedReply = Number(inboundMessageId);
  const actualReply = Number(
    outbound?.replyToMessageId
    ?? outbound?.raw?.reply_parameters?.message_id
    ?? outbound?.raw?.reply_to_message_id,
  );
  return Number.isFinite(expected)
    && Number.isFinite(expectedReply)
    && Number.isFinite(actualReply)
    && actualReply === expectedReply;
}

/** Return the last substantive wire reply from one exact Telegram conversation. */
export function findTelegramConversationWireAnswer(outbound, threadId, inboundMessageId) {
  for (let index = outbound.length - 1; index >= 0; index -= 1) {
    const item = outbound[index];
    if (!telegramOutboundMatchesThread(item, threadId, inboundMessageId)) continue;
    const visibleContent = outboundVisibleContent(item);
    if (visibleContent && !isDriveProgressText(visibleContent)) return visibleContent;
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
  const filenames = threadId === undefined
    ? [
        "conversation.jsonl.trajectory.jsonl",
        "conversation~thread~1.jsonl.trajectory.jsonl",
      ]
    : [`conversation~thread~${threadId}.jsonl.trajectory.jsonl`];
  for (const filename of filenames) {
    const expected = `${directory}${filename}`;
    const match = candidates
      .filter(({ path }) => path === expected)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
    if (match !== undefined) return match;
  }
  return null;
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

/**
 * The user-visible prose carried by one transcript `type:"message"` record.
 *
 * Exported so the concurrency oracle reads a transcript record exactly the way
 * the sequential drive does. Two private definitions of "the text of a record"
 * drift, and a drifted definition makes two oracles disagree about the same
 * turn.
 */
export function transcriptMessageText(message) {
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
      const text = transcriptMessageText(record.message);
      if (text.includes(inboundId)) {
        ownUserSeen = true;
        reply = null;
      }
      continue;
    }
    if (!ownUserSeen || record.message?.role !== "assistant") continue;
    const text = transcriptMessageText(record.message).trim();
    if (text) reply = text;
  }
  return reply;
}

/**
 * Reduce one wire payload to comparable prose (markup, entities and
 * whitespace collapsed). Exported so delivery-duplicate detection compares
 * texts by the SAME normalization the reply-correlation check uses.
 */
export function normalizeWireText(value) {
  return value
    .replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/__(.*?)__/gs, "$1")
    .replace(/~~(.*?)~~/gs, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, "")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_row, cells) => cells.replaceAll("|", " "))
    .replace(/^(?:\s*-{3,})+\s*$/gm, "")
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
        || telegramOutboundMatchesThread(
          item,
          route.threadId,
          route.inboundMessageId,
        )
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
  inboundMessageId,
}) {
  if (
    correlatedAnswer !== null
    && wireContainsAssistantReply(
      outbound,
      correlatedAnswer,
      { threadId, inboundMessageId },
    )
  ) {
    return true;
  }
  return turnEnded && sawAnswer;
}

/**
 * Stop a direct-message drive after both the turn and its wire delivery settle.
 *
 * Session summary can precede delivery post-processing. An ended turn with no
 * visible answer after that terminal remains open for the longer delivery
 * grace. A launch acknowledgement from before the final child terminal is not
 * proof that completion delivery has settled.
 */
export function directConversationFinished({
  sawAnswer,
  sawMediaDelivery = false,
  turnEnded,
  turnEndedAtMs,
  nowMs,
  deliveryGraceMs,
  answerQuiesceMs,
  lastOutboundAtMs,
  lastAnswerAtMs,
}) {
  if (!turnEnded) return false;
  if (typeof turnEndedAtMs !== "number") return false;
  // The grace measures SILENCE, not an absolute span from turn-end. A background completion's
  // DELIVERY can trail its terminal record: measured live, a turn ended correctly (its spawned
  // workers balanced) and the substantive answer landed after the fixed window, so the drive
  // reported the interim acknowledgement as the answer. Raising the fixed bound only trades against
  // answerless-turn latency; anchoring on the last outbound keeps the window open exactly while the
  // runtime is still emitting and closes promptly on real silence.
  //
  // An outbound that PREDATES turn-end must not extend anything (no retro-extension), so the anchor
  // is the later of the two. Omitting `lastOutboundAtMs` preserves the original behaviour.
  const anchorMs = typeof lastOutboundAtMs === "number" && lastOutboundAtMs > turnEndedAtMs
    ? lastOutboundAtMs
    : turnEndedAtMs;
  const settledDeliveryObserved = sawMediaDelivery || (
    sawAnswer
    && typeof lastAnswerAtMs === "number"
    && lastAnswerAtMs >= turnEndedAtMs
  );
  return nowMs - anchorMs >= (settledDeliveryObserved ? answerQuiesceMs : deliveryGraceMs);
}

/**
 * Count logical answers without treating Telegram's transport chunks as
 * separate async follow-ups.
 *
 * Telegram accepts at most 4,096 characters. Formatting and balanced markup
 * can make a full transport chunk land slightly below that limit. A
 * substantive record after a near-limit chunk is therefore
 * part of the same logical answer. A later record after the final short chunk
 * starts a new answer. This is deliberately conservative: ambiguity extends
 * the bounded wait instead of manufacturing a follow-up-delivered verdict.
 */
export function logicalSubstantiveAnswerCount(outbound) {
  const nearTelegramLimit = 4_000;
  const seenMessageIds = new Set();
  let logicalCount = 0;
  let previousWasFullTelegramChunk = false;

  for (let index = 0; index < outbound.length; index += 1) {
    const item = outbound[index];
    const visibleContent = outboundVisibleContent(item);
    if (!visibleContent || isDriveProgressText(visibleContent)) continue;

    const messageKey = item?.messageId ?? `missing-${index}`;
    if (seenMessageIds.has(messageKey)) continue;
    seenMessageIds.add(messageKey);

    if (!previousWasFullTelegramChunk) logicalCount += 1;
    previousWasFullTelegramChunk = visibleContent.length >= nearTelegramLimit;
  }

  return logicalCount;
}

/**
 * Stop an opt-in async follow-up wait after one logical follow-up answer or
 * after the bounded window measured from the launch acknowledgement.
 */
export function followupWaitFinished({
  followupAnswerCount,
  firstAnswerAtMs,
  nowMs,
  waitMs,
}) {
  if (followupAnswerCount >= 1) return true;
  if (typeof firstAnswerAtMs !== "number") return false;
  return nowMs - firstAnswerAtMs >= waitMs;
}

/**
 * Has the driven turn actually ENDED, given the trajectory lines appended since the drive began?
 *
 * A terminal record alone is not turn-end: a turn can hand work OFF and finish, and both hand-off
 * paths were observed live on heavy questions. A pre-model clarification is independently terminal:
 * the input guard deliberately emits no model-backed session summary after returning its response.
 *   1. **background task** — the parent's own `session.summary` record carries
 *      `finishReason:"background_pending"` (same line; verified in live trajectories).
 *   2. **sub-agent spawn** — the parent turn finishes cleanly (`endReason:"success"`) while a
 *      spawned worker keeps running; the trajectory tracks `subagent.spawned` /
 *      `subagent.completed`, so an unmatched spawn means the answer does not exist yet.
 *
 * Why it matters: the interim "I'm running it now, I'll report back" prose is NOT a progress card,
 * so it satisfies `sawAnswer` and the post-turn grace exits immediately. Across a 15-question heavy
 * run every real answer landed 30–384 s after that point, and the two best answers were reported as
 * content-free. PURE: same lines → same verdict.
 *
 * @param lines Trajectory JSONL lines appended since the drive's baseline.
 * @returns true only when a clean terminal record exists AND no spawned worker is outstanding.
 */
export function trajectoryTurnEnded(lines) {
  let spawned = 0;
  let completed = 0;
  let terminal = false;
  for (const line of lines) {
    if (line.includes('"type":"subagent.spawned"')) spawned += 1;
    else if (
      line.includes('"type":"subagent.completed"')
      || line.includes('"type":"subagent.killed"')
    ) completed += 1;
    else if (
      line.includes('"type":"session.summary"')
      || line.includes('"type":"execution.aborted"')
      || line.includes('"type":"request.clarification_required"')
    ) {
      if (!line.includes('"finishReason":"background_pending"')) terminal = true;
    }
  }
  return terminal && spawned <= completed;
}

/**
 * Count persisted JSONL records for a pre-inject trajectory baseline.
 *
 * Writers terminate each record with a newline. `String.split("\n").length`
 * therefore counts the trailing separator as a record and causes the first
 * appended terminal record to be sliced away by the watcher.
 */
export function trajectoryBaselineLineCount(jsonl) {
  if (jsonl.length === 0) return 0;
  const lines = jsonl.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}
