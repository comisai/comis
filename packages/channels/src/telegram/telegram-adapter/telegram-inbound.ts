// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram inbound message routing.
 *
 * Owns the four grammy event handlers that translate Telegram updates into
 * the channel-agnostic NormalizedMessage shape and dispatch them to the
 * onMessage handlers registered on the adapter handle:
 *   - bot.on("message")        - new messages
 *   - bot.on("edited_message") - edited messages
 *   - bot.on("poll")           - poll result updates
 *   - bot.on("callback_query:data") - button taps
 *
 * State-first protocol: every helper takes `state: TelegramAdapterState`
 * as its first positional parameter, `deps: TelegramAdapterDeps` as
 * second, then per-call args.
 *
 * @module
 */

import {
  runWithContext,
  systemClearTimeout,
  systemNowMs,
  systemSetTimeout,
  toSafeErrorLogString,
} from "@comis/core";
import type { NormalizedMessage, NormalizedReaction } from "@comis/core";
import { createHash, randomUUID } from "node:crypto";
import {
  mapGrammyToNormalized,
  type TelegramBotIdentity,
  type TelegramInboundUpdateKind,
} from "../message-mapper.js";
import { normalizeTelegramPollResult } from "../../shared/poll-normalizer.js";
import { resolveTelegramThreadContext } from "../thread-context.js";
import type {
  TelegramAdapterDeps,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";

const CALLBACK_ACK_TIMEOUT_MS = 1_000;
const CALLBACK_FALLBACK_EPOCH_MS = 1_600_000_000_000;

/** Expected polling rejection used to leave a post-stop update unconfirmed. */
export class TelegramAdapterStoppingError extends Error {
  override readonly name = "TelegramAdapterStoppingError";
}

/** Deterministic GUID for a bot-account-scoped Telegram callback query. */
function telegramCallbackGuid(botAccountId: number, callbackQueryId: string): string {
  const bytes = createHash("sha256")
    .update(`comis:telegram-callback:${botAccountId}:${callbackQueryId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Preserve callback replay identity when Telegram provides no event timestamp. */
function telegramCallbackTimestamp(
  botAccountId: number,
  callbackQueryId: string,
  sourceDateSeconds: number | undefined,
): number {
  if (
    typeof sourceDateSeconds === "number"
    && Number.isSafeInteger(sourceDateSeconds)
    && sourceDateSeconds > 0
  ) return sourceDateSeconds * 1_000;

  const identityOffset = createHash("sha256")
    .update(`comis:telegram-callback-time:${botAccountId}:${callbackQueryId}`, "utf8")
    .digest()
    .readUInt32BE(0);
  return CALLBACK_FALLBACK_EPOCH_MS + identityOffset;
}

// ---------------------------------------------------------------------------
// Single-message ingestion (shared by message + edited_message handlers)
// ---------------------------------------------------------------------------

/**
 * Shared message handler for both new and edited messages.
 *
 * Filters forum-topic service messages, updates state.lastMessageAt, maps
 * grammy to NormalizedMessage, and waits for every registered handler. The
 * middleware must not resolve until the durable inbound pipeline has accepted
 * the update, otherwise Telegram may advance its polling offset first.
 */
export async function handleInboundMessage(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  msg: import("grammy/types").Message,
  chatId: number,
  updateKind: TelegramInboundUpdateKind,
  botIdentity: TelegramBotIdentity,
): Promise<void> {
  // Filter forum topic service messages before they reach the agent
  if (msg.forum_topic_created || msg.forum_topic_edited ||
      msg.forum_topic_closed || msg.forum_topic_reopened ||
      msg.general_forum_topic_hidden || msg.general_forum_topic_unhidden) {
    deps.logger.debug(
      { channelType: "telegram", chatId: String(chatId), threadId: msg.message_thread_id },
      "Skipped forum topic service message",
    );
    return;
  }

  state.lastMessageAt = systemNowMs();
  const normalized = mapGrammyToNormalized(
    msg,
    chatId,
    updateKind,
    botIdentity,
  );

  // Mint traceId at ingress, stamp into metadata so the orchestrator's
  // adapter.onMessage wrap can reuse it. The Pino mixin reads ALS
  // automatically — the "Inbound message" log line below picks up
  // traceId once we enter the runWithContext scope.
  const traceId = randomUUID();
  normalized.metadata.traceId = traceId;

  deps.logger.info(
    { step: "channels-inbound", channelType: "telegram", messageId: normalized.id, chatId: String(chatId), previewLen: (normalized.text ?? "").length, traceId },
    "Inbound message",
  );
  await dispatchMessageHandlers(
    state,
    deps,
    normalized,
    traceId,
    String(chatId),
  );
}

/** Dispatch one normalized update inside its ingress context and propagate failure. */
async function dispatchMessageHandlers(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  normalized: NormalizedMessage,
  traceId: string,
  chatId: string,
): Promise<void> {
  const trustLevel = normalized.senderId.startsWith("chat:") || normalized.senderId.startsWith("unknown:")
    ? "guest" as const
    : "user" as const;
  await runWithContext(
    {
      traceId,
      startedAt: systemNowMs(),
      channelType: "telegram",
      tenantId: "default",
      trustLevel,
    },
    async () => {
      for (const handler of state.handlers) {
        try {
          await handler(normalized);
        } catch (handlerErr) {
          deps.logger.error(
            {
              err: toSafeErrorLogString(handlerErr),
              chatId,
              hint: "Check Telegram message handler logic before restarting polling",
              errorKind: "internal" as const,
            },
            "Message handler error",
          );
          return Promise.reject(handlerErr);
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Grammy event-handler wiring
// ---------------------------------------------------------------------------

/**
 * Install the four grammy event handlers (message, edited_message, poll,
 * callback_query:data) onto state.bot. Called once from startLifecycle
 * after token validation succeeds.
 */
export function bindInboundHandlers(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  botIdentity: TelegramBotIdentity,
): void {
  // Set up Grammy middleware for incoming messages
  state.bot.on("message", (ctx) => {
    if (ctx.message) {
      return trackInboundUpdate(state, () => handleInboundMessage(
        state,
        deps,
        ctx.message,
        ctx.message.chat.id,
        "message",
        botIdentity,
      ));
    }
  });

  state.bot.on("edited_message", (ctx) => {
    if (ctx.editedMessage) {
      return trackInboundUpdate(state, () => handleInboundMessage(
        state,
        deps,
        ctx.editedMessage,
        ctx.editedMessage.chat.id,
        "edited_message",
        botIdentity,
      ));
    }
  });

  // Poll events bypass runWithContext — they are aggregated votes via
  // deps.onPollResult, not per-user inbound messages. No traceId semantic.
  state.bot.on("poll", (ctx) => trackInboundUpdate(state, async () => {
    if (!ctx.poll) return;
    const poll = ctx.poll;
    try {
      const normalized = normalizeTelegramPollResult({
        id: poll.id,
        question: poll.question,
        options: poll.options.map((o) => ({
          text: o.text,
          voter_count: o.voter_count,
        })),
        total_voter_count: poll.total_voter_count,
        is_closed: poll.is_closed,
      });
      deps.logger.debug(
        {
          channelType: "telegram",
          pollId: normalized.pollId,
          totalVoters: normalized.totalVoters,
          isClosed: normalized.isClosed,
        },
        "Poll result received",
      );
      if (deps.onPollResult) {
        deps.onPollResult(normalized);
      }
    } catch (pollErr) {
      deps.logger.warn(
        {
          channelType: "telegram",
          err: toSafeErrorLogString(pollErr),
          hint: "Check poll data structure from Telegram API",
          errorKind: "platform" as const,
        },
        "Poll normalization failed",
      );
    }
  }));

  // Button callback query listener
  state.bot.on("callback_query:data", (ctx) => trackInboundUpdate(state, async () => {
    // The acknowledgement only clears Telegram's loading animation. It must
    // never delay durable callback dispatch or hold the polling offset open.
    const acknowledgementController = new AbortController();
    const acknowledgementTimer = systemSetTimeout(
      () => acknowledgementController.abort(),
      CALLBACK_ACK_TIMEOUT_MS,
    );
    acknowledgementTimer.unref();
    // grammY's declaration resolves AbortSignal through its polyfill package;
    // Node's runtime signal is API-compatible but not nominally assignable.
    const acknowledgementSignal = acknowledgementController.signal as unknown as
      Parameters<typeof ctx.answerCallbackQuery>[1];
    void Promise.resolve()
      .then(() => ctx.answerCallbackQuery(undefined, acknowledgementSignal))
      .catch((error) => {
        deps.logger.warn(
          {
            channelType: "telegram",
            err: toSafeErrorLogString(error),
            hint: "Check Telegram callback acknowledgement connectivity; forwarding continues",
            errorKind: "platform" as const,
          },
          "Callback query acknowledgement failed",
        );
      })
      .finally(() => systemClearTimeout(acknowledgementTimer));

    const normalized: NormalizedMessage = {
      id: telegramCallbackGuid(botIdentity.id, ctx.callbackQuery.id),
      channelType: "telegram",
      channelId: String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id),
      senderId: String(ctx.from.id),
      text: ctx.callbackQuery.data,
      timestamp: telegramCallbackTimestamp(
        botIdentity.id,
        ctx.callbackQuery.id,
        ctx.callbackQuery.message?.date,
      ),
      attachments: [],
      metadata: {
        isButtonCallback: true,
        callbackData: ctx.callbackQuery.data,
        messageId: ctx.callbackQuery.message
          ? String(ctx.callbackQuery.message.message_id)
          : undefined,
        senderName: ctx.from.username ?? ctx.from.first_name ?? "unknown",
      },
    };

    // Extract thread metadata from callback query source message
    const cbMsg = ctx.callbackQuery.message;
    if (cbMsg && "message_thread_id" in cbMsg) {
      const cbChat = cbMsg.chat;
      const cbIsForum = "is_forum" in cbChat && cbChat.is_forum === true;
      const cbIsGroup = cbChat.type === "group" || cbChat.type === "supergroup";
      const cbRawThreadId = (cbMsg as { message_thread_id?: number }).message_thread_id;
      const cbThread = resolveTelegramThreadContext({
        isForum: cbIsForum,
        isGroup: cbIsGroup,
        rawThreadId: cbRawThreadId,
      });
      if (cbThread.threadId !== undefined) {
        normalized.metadata.telegramThreadId = cbThread.threadId;
        normalized.metadata.threadId = String(cbThread.threadId);
      }
      if (cbThread.scope !== "none") {
        normalized.metadata.telegramIsForum = cbIsForum;
        normalized.metadata.telegramThreadScope = cbThread.scope;
      }
    }

    // Mint traceId at ingress for callback_query dispatch.
    const traceId = randomUUID();
    normalized.metadata.traceId = traceId;
    await dispatchMessageHandlers(
      state,
      deps,
      normalized,
      traceId,
      String(ctx.from.id),
    );
  }));

  // Inbound reaction-add capture. Sequential polling explicitly opts into
  // "message_reaction" because Telegram excludes it from the default update
  // set. A reaction-ADD = an emoji present in new_reaction but NOT in
  // old_reaction; a removal-only update is skipped.
  state.bot.on("message_reaction", (ctx) => trackInboundUpdate(state, async () => {
    const mr = ctx.messageReaction;
    if (!mr || !mr.user) return; // anonymous channel reaction → no reactor id
    // Bot-own filter — never count the bot's own reactions.
    if (mr.user.id === botIdentity.id) return;

    const oldEmojis = new Set(emojiNames(mr.old_reaction));
    const added = emojiNames(mr.new_reaction).filter((emoji) => !oldEmojis.has(emoji));
    if (added.length === 0) return; // removal-only / non-emoji update → skip

    for (const emoji of added) {
      const normalized: NormalizedReaction = {
        messageId: String(mr.message_id),
        reactorId: String(mr.user.id),
        emoji,
        channelType: "telegram",
        channelId: String(mr.chat.id),
      };
      for (const handler of state.reactionHandlers) {
        try {
          await handler(normalized);
        } catch (handlerErr) {
          warnReactionHandlerFailed(deps, handlerErr);
        }
      }
    }
  }));
}

/** Register middleware work so shutdown cannot confirm its update prematurely. */
function trackInboundUpdate(
  state: TelegramAdapterState,
  run: () => Promise<void>,
): Promise<void> {
  if (!state.acceptingUpdates) {
    state.stopGateTriggered = true;
    return Promise.reject(new TelegramAdapterStoppingError(
      "Telegram adapter is stopping and cannot accept another update",
    ));
  }
  const task = Promise.resolve().then(run);
  state.inFlightUpdates.add(task);
  const remove = (): void => { state.inFlightUpdates.delete(task); };
  void task.then(remove, remove);
  return task;
}

/**
 * Extract the plain-emoji names from a grammy reaction list, dropping
 * custom-emoji and paid reactions (only plain emoji can match the reactionMap
 * downstream). `r.type === "emoji"` narrows to ReactionTypeEmoji whose `emoji`
 * is the closed Telegram emoji union — returned as plain strings.
 */
function emojiNames(reactions: import("grammy/types").ReactionType[] | undefined): string[] {
  const out: string[] = [];
  for (const r of reactions ?? []) {
    if (r.type === "emoji") out.push(r.emoji);
  }
  return out;
}

/** Log a non-fatal Telegram reaction-handler failure (sync throw or rejected promise). */
function warnReactionHandlerFailed(deps: TelegramAdapterDeps, handlerErr: unknown): void {
  deps.logger.warn(
    {
      channelType: "telegram",
      err: toSafeErrorLogString(handlerErr),
      hint: "Telegram reaction handler threw; reaction dropped (non-fatal)",
      errorKind: "platform" as const,
    },
    "Reaction handler failed",
  );
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/** Append a MessageHandler to the adapter's dispatch list. */
export function registerMessageHandler(
  state: TelegramAdapterState,
  handler: import("@comis/core").MessageHandler,
): void {
  state.handlers.push(handler);
}

/** Append a ReactionHandler to the adapter's reaction dispatch list. */
export function registerReactionHandler(
  state: TelegramAdapterState,
  handler: import("@comis/core").ReactionHandler,
): void {
  state.reactionHandlers.push(handler);
}
