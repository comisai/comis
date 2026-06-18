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

import { runWithContext, systemNowMs } from "@comis/core";
import type { NormalizedMessage, NormalizedReaction } from "@comis/core";
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
  runWithContext(
    {
      traceId,
      startedAt: systemNowMs(),
      channelType: "telegram",
      tenantId: "default",
      trustLevel: "admin",
    },
    () => {
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

  // Poll events bypass runWithContext — they are aggregated votes via
  // deps.onPollResult, not per-user inbound messages. No traceId semantic.
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

      // Mint traceId at ingress for callback_query dispatch.
      const traceId = randomUUID();
      normalized.metadata.traceId = traceId;
      runWithContext(
        {
          traceId,
          startedAt: systemNowMs(),
          channelType: "telegram",
          tenantId: "default",
          trustLevel: "admin",
        },
        () => {
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
        },
      );
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

  // REACT-01: inbound reaction-add capture. Requires the runner allowed_updates
  // opt-in to include "message_reaction" (telegram-lifecycle.ts) — without it
  // Telegram never delivers this update. A reaction-ADD = an emoji present in
  // new_reaction but NOT in old_reaction; a removal-only update is skipped.
  // NOTE (webhook mode): telegram-webhook.ts picks runner vs webhook via
  // shouldUseRunner; the allowed_updates opt-in covers the runner (polling)
  // path. A webhook deployment must pass the same allowed_updates list to
  // setWebhook (operator-side config, DOC-01) — out of scope for this binder.
  state.bot.on("message_reaction", (ctx) => {
    const mr = ctx.messageReaction;
    if (!mr || !mr.user) return; // anonymous channel reaction → no reactor id
    // Bot-own filter — never count the bot's own reactions.
    if (state.botIdentity && mr.user.id === state.botIdentity.id) return;

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
        // try/catch + .catch so a sync OR async handler throw is non-fatal.
        try {
          Promise.resolve(handler(normalized)).catch((handlerErr) =>
            warnReactionHandlerFailed(deps, handlerErr),
          );
        } catch (handlerErr) {
          warnReactionHandlerFailed(deps, handlerErr);
        }
      }
    }
  });
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
      err: handlerErr instanceof Error ? handlerErr : new Error(String(handlerErr)),
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

/** Append a ReactionHandler to the adapter's reaction dispatch list (REACT-01). */
export function registerReactionHandler(
  state: TelegramAdapterState,
  handler: import("@comis/core").ReactionHandler,
): void {
  state.reactionHandlers.push(handler);
}
