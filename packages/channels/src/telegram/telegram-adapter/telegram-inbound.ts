// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram inbound message routing (Phase 43 split per FILE-SPLIT-12).
 *
 * Owns the four grammy event handlers that translate Telegram updates into
 * the channel-agnostic NormalizedMessage shape and dispatch them to the
 * onMessage handlers registered on the adapter handle:
 *   - bot.on("message")        - new messages
 *   - bot.on("edited_message") - edited messages
 *   - bot.on("poll")           - poll result updates
 *   - bot.on("callback_query:data") - button taps
 *
 * State-first protocol (matches Phase 42 pi-executor + Phase 43 mcp-client):
 * every helper takes `state: TelegramAdapterState` as its first positional
 * parameter, `deps: TelegramAdapterDeps` as second, then per-call args.
 *
 * @module
 */

import { systemNowMs } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mapGrammyToNormalized } from "../message-mapper.js";
import { normalizeTelegramPollResult } from "../../shared/poll-normalizer.js";
import { resolveTelegramThreadContext } from "../thread-context.js";
import type {
  TelegramAdapterDeps,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";

// ---------------------------------------------------------------------------
// Single-message ingestion (shared by message + edited_message handlers)
// ---------------------------------------------------------------------------

/**
 * Shared message handler for both new and edited messages.
 *
 * Filters forum-topic service messages, updates state.lastMessageAt, maps
 * grammy to NormalizedMessage, and dispatches to every registered handler
 * with fire-and-forget semantics so a slow handler cannot block grammy's
 * middleware chain.
 */
export function handleInboundMessage(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  msg: import("grammy/types").Message,
  chatId: number,
): void {
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
  const normalized = mapGrammyToNormalized(msg, chatId, state.botIdentity);
  deps.logger.info(
    { channelType: "telegram", messageId: normalized.id, chatId: String(chatId), previewLen: (normalized.text ?? "").length },
    "Inbound message",
  );
  for (const handler of state.handlers) {
    // Fire-and-forget: don't block Grammy middleware
    try {
      Promise.resolve(handler(normalized)).catch((handlerErr) => {
        deps.logger.error({ err: handlerErr, chatId: String(chatId), hint: "Check Telegram message handler logic", errorKind: "internal" as const }, "Message handler error");
      });
    } catch (handlerErr) {
      deps.logger.error({ err: handlerErr, chatId: String(chatId), hint: "Check Telegram message handler logic", errorKind: "internal" as const }, "Message handler error");
    }
  }
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
): void {
  // Set up Grammy middleware for incoming messages
  state.bot.on("message", (ctx) => {
    if (ctx.message) {
      handleInboundMessage(state, deps, ctx.message, ctx.message.chat.id);
    }
  });

  state.bot.on("edited_message", (ctx) => {
    if (ctx.editedMessage) {
      handleInboundMessage(state, deps, ctx.editedMessage, ctx.editedMessage.chat.id);
    }
  });

  // Poll result handler: normalize Telegram poll updates and forward
  state.bot.on("poll", (ctx) => {
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
          err: pollErr instanceof Error ? pollErr : new Error(String(pollErr)),
          hint: "Check poll data structure from Telegram API",
          errorKind: "platform" as const,
        },
        "Poll normalization failed",
      );
    }
  });

  // Button callback query listener
  state.bot.on("callback_query:data", async (ctx) => {
    try {
      // Immediate ack: removes loading animation
      await ctx.answerCallbackQuery();

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "telegram",
        channelId: String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id),
        senderId: String(ctx.from.id),
        text: ctx.callbackQuery.data,
        timestamp: systemNowMs(),
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
        const cbThread = resolveTelegramThreadContext({ isForum: cbIsForum, isGroup: cbIsGroup, rawThreadId: cbRawThreadId });
        if (cbThread.threadId !== undefined) {
          normalized.metadata.telegramThreadId = cbThread.threadId;
          normalized.metadata.threadId = String(cbThread.threadId);
        }
        if (cbThread.scope !== "none") {
          normalized.metadata.telegramIsForum = cbIsForum;
          normalized.metadata.telegramThreadScope = cbThread.scope;
        }
      }

      for (const handler of state.handlers) {
        try {
          Promise.resolve(handler(normalized)).catch((handlerErr) => {
            deps.logger.error(
              {
                err: handlerErr,
                chatId: String(ctx.from.id),
                hint: "Check Telegram callback handler for unhandled errors",
                errorKind: "internal" as const,
              },
              "Callback query handler error",
            );
          });
        } catch (handlerErr) {
          deps.logger.error(
            {
              err: handlerErr,
              chatId: String(ctx.from.id),
              hint: "Check Telegram callback handler for unhandled errors",
              errorKind: "internal" as const,
            },
            "Callback query handler error",
          );
        }
      }
    } catch (error) {
      deps.logger.warn(
        {
          channelType: "telegram",
          err: error instanceof Error ? error : new Error(String(error)),
          hint: "Callback query acknowledgement or forwarding failed",
          errorKind: "platform" as const,
        },
        "Callback query failed",
      );
    }
  });
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
