// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram Channel Adapter: ChannelPort implementation using Grammy.
 *
 * Provides the bridge between Telegram's Bot API and Comis's
 * channel-agnostic ChannelPort interface. Uses:
 * - @grammyjs/runner for concurrent update processing
 * - @grammyjs/auto-retry for 429 rate limit handling
 * - @grammyjs/files for file hydration
 *
 * Lifecycle: start() validates token -> sets up middleware -> starts polling.
 * Messages are translated via mapGrammyToNormalized and dispatched to handlers.
 *
 * @module
 */

import type {
  AttachmentPayload,
  ChannelPort,
  ChannelStatus,
  FetchedMessage,
  FetchMessagesOptions,
  MessageHandler,
  NormalizedMessage,
  SendMessageOptions,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { Result } from "@comis/shared";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import { run } from "@grammyjs/runner";
import { ok, err } from "@comis/shared";
import { Bot, InputFile } from "grammy";
import { randomUUID } from "node:crypto";
import { validateBotToken, validateWebhookSecret } from "./credential-validator.js";
import { mapGrammyToNormalized } from "./message-mapper.js";
import { normalizeTelegramPollResult } from "../shared/poll-normalizer.js";
import { resolveTelegramThreadContext, resolveOutboundThreadParams, isTelegramThreadNotFoundError, buildTypingThreadParams } from "./thread-context.js";
import { renderTelegramButtons, renderTelegramCards } from "./rich-renderer.js";
import { createTelegramVoiceSender } from "./voice-sender.js";

// ---------------------------------------------------------------------------
// Bot commands for Telegram autocomplete menu (via setMyCommands)
// Excludes: /config (admin-only), /reasoning (alias for /think)
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a new conversation" },
  { command: "reset", description: "Reset the current session" },
  { command: "status", description: "Show session status and stats" },
  { command: "usage", description: "Show token usage breakdown" },
  { command: "context", description: "Show context window info" },
  { command: "model", description: "Show or switch the current model" },
  { command: "think", description: "Set thinking level (off/low/medium/high)" },
  { command: "verbose", description: "Toggle verbose mode" },
  { command: "compact", description: "Compact the conversation history" },
  { command: "export", description: "Export session to HTML" },
  { command: "stop", description: "Stop the current execution" },
  { command: "fork", description: "Fork the conversation" },
  { command: "branch", description: "Navigate conversation branches" },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TelegramAdapterDeps {
  botToken: string;
  webhookSecret?: string;
  webhookUrl?: string;
  logger: ComisLogger;
  /** Optional callback for emitting poll result events */
  onPollResult?: (result: import("@comis/core").NormalizedPollResult) => void;
}

export interface TelegramAdapterHandle extends ChannelPort {
  /** Grammy Bot instance for media resolver creation. */
  readonly bot: Bot;
}

// ---------------------------------------------------------------------------
// HTML parse error detection
// ---------------------------------------------------------------------------

const TELEGRAM_PARSE_ERR_RE = /can't parse entities|find end of the entity/i;

/** Detect Telegram HTML parse errors that should trigger a plain-text fallback. */
function isTelegramHtmlParseError(err: unknown): boolean {
  if (err instanceof Error) return TELEGRAM_PARSE_ERR_RE.test(err.message);
  return TELEGRAM_PARSE_ERR_RE.test(String(err));
}

// ---------------------------------------------------------------------------
// Thread-not-found fallback
// ---------------------------------------------------------------------------

/**
 * Retry a send operation without `message_thread_id` if the target forum
 * topic has been deleted or closed. Non-thread errors re-throw.
 *
 * Design Section 5.4.8: The `sendFn` receives thread params as an argument
 * so the wrapper can retry with `undefined` to strip them on fallback.
 */
async function sendWithThreadFallback<T>(
  sendFn: (threadParams?: { message_thread_id: number }) => Promise<T>,
  threadParams: { message_thread_id: number } | undefined,
  logger: ComisLogger,
): Promise<T> {
  try {
    return await sendFn(threadParams);
  } catch (err) {
    if (threadParams && isTelegramThreadNotFoundError(err)) {
      logger.warn(
        {
          channelType: "telegram",
          messageThreadId: threadParams.message_thread_id,
          err: err instanceof Error ? err : new Error(String(err)),
          hint: "Topic may have been deleted; retrying without thread context",
          errorKind: "platform" as const,
        },
        "Thread-not-found fallback triggered",
      );
      return await sendFn(undefined);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTML sanitization for Telegram
// ---------------------------------------------------------------------------

/** Telegram-supported HTML tags (case-insensitive). */
const TELEGRAM_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "span", "tg-spoiler", "a", "tg-emoji",
  "code", "pre", "blockquote",
]);

/**
 * Escape `<` characters that are NOT part of a valid Telegram HTML tag.
 * Prevents Telegram from rejecting messages containing text like `<5%`
 * or `<foo` that isn't a recognized HTML element.
 *
 * Already-valid tags (e.g. `<b>`, `</code>`, `<a href="...">`) pass through.
 */
function sanitizeTelegramHtml(text: string): string {
  return text.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|</g, (match, slash, tagName) => {
    if (tagName && TELEGRAM_TAGS.has(tagName.toLowerCase())) return match;
    if (tagName) return "&lt;" + match.slice(1); // unknown tag — escape the `<`
    return "&lt;"; // bare `<` not followed by a tag pattern
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Telegram adapter implementing the ChannelPort interface.
 *
 * Uses Grammy for Telegram Bot API communication, with auto-retry for
 * rate limiting and runner for concurrent update processing.
 */
export function createTelegramAdapter(deps: TelegramAdapterDeps): TelegramAdapterHandle {
  const bot = new Bot(deps.botToken);

  // Install auto-retry transformer for 429 handling
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  // Install file hydration transformer
  bot.api.config.use(hydrateFiles(deps.botToken));

  const handlers: MessageHandler[] = [];
  let _channelId = "telegram-pending";
  let runnerHandle: ReturnType<typeof run> | null = null;

  // Health tracking
  let _connected = false;
  let _startedAt: number | undefined;
  let _lastMessageAt: number | undefined;
  let _lastError: string | undefined;

  // Shared message handler for both new and edited messages
  function handleMessage(msg: import("grammy/types").Message, chatId: number): void {
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

    _lastMessageAt = Date.now();
    const normalized = mapGrammyToNormalized(msg, chatId);
    deps.logger.info(
      { channelType: "telegram", messageId: normalized.id, chatId: String(chatId), previewLen: (normalized.text ?? "").length },
      "Inbound message",
    );
    for (const handler of handlers) {
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

  const adapter: TelegramAdapterHandle = {
    get channelId(): string {
      return _channelId;
    },

    get channelType(): string {
      return "telegram";
    },

    async start(): Promise<Result<void, Error>> {
      // Fail fast on invalid token
      const tokenResult = await validateBotToken(deps.botToken);
      if (!tokenResult.ok) {
        deps.logger.error(
          {
            channelType: "telegram",
            err: tokenResult.error,
            hint: "Verify TELEGRAM_BOT_TOKEN is a valid bot token from @BotFather",
            errorKind: "auth" as const,
          },
          "Adapter start failed",
        );
        return err(tokenResult.error);
      }

      const botInfo = tokenResult.value;
      _channelId = `telegram-${botInfo.id}`;

      // Validate webhook secret if provided
      if (deps.webhookSecret) {
        const secretResult = validateWebhookSecret(deps.webhookSecret);
        if (!secretResult.ok) {
          deps.logger.error(
            {
              channelType: "telegram",
              err: secretResult.error,
              hint: "Verify TELEGRAM_BOT_TOKEN is a valid bot token from @BotFather",
              errorKind: "auth" as const,
            },
            "Adapter start failed",
          );
          return err(secretResult.error);
        }
      }

      // Register slash commands with Telegram for autocomplete menu
      bot.api.setMyCommands(TELEGRAM_BOT_COMMANDS).catch((cmdErr) => {
        deps.logger.warn(
          {
            channelType: "telegram",
            err: cmdErr instanceof Error ? cmdErr : new Error(String(cmdErr)),
            hint: "Bot commands menu will not be available — check bot token permissions",
            errorKind: "platform" as const,
          },
          "Failed to register bot commands",
        );
      });

      // Set up Grammy middleware for incoming messages
      bot.on("message", (ctx) => {
        if (ctx.message) {
          handleMessage(ctx.message, ctx.message.chat.id);
        }
      });

      bot.on("edited_message", (ctx) => {
        if (ctx.editedMessage) {
          handleMessage(ctx.editedMessage, ctx.editedMessage.chat.id);
        }
      });

      // Poll result handler: normalize Telegram poll updates and forward
      bot.on("poll", (ctx) => {
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
      bot.on("callback_query:data", async (ctx) => {
        try {
          // Immediate ack -- removes loading animation
          await ctx.answerCallbackQuery();

          const normalized: NormalizedMessage = {
            id: randomUUID(),
            channelType: "telegram",
            channelId: String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id),
            senderId: String(ctx.from.id),
            text: ctx.callbackQuery.data,
            timestamp: Date.now(),
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

          for (const handler of handlers) {
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

      // Start polling (webhook mode deferred to Phase 6/9)
      if (!deps.webhookUrl) {
        runnerHandle = run(bot);
      }

      _connected = true;
      _startedAt = Date.now();

      deps.logger.info(
        { channelType: "telegram", botId: botInfo.id, username: botInfo.username, mode: deps.webhookUrl ? "webhook" : "polling" },
        "Adapter started",
      );

      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      try {
        if (runnerHandle && runnerHandle.isRunning()) {
          runnerHandle.stop();
        }
        _connected = false;
        deps.logger.info({ channelType: "telegram" }, "Adapter stopped");
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to stop Telegram adapter: ${message}`));
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      try {
        // Apply effects
        const isSpoiler = options?.effects?.includes("spoiler");
        const isSilent = options?.effects?.includes("silent");

        // Render cards as HTML if present (prepend to text)
        let finalText = text;
        if (options?.cards && options.cards.length > 0) {
          const cardHtml = renderTelegramCards(options.cards);
          finalText = cardHtml + (text ? "\n\n" + text : "");
          deps.logger.debug({ channelType: "telegram", cardsRendered: options.cards.length }, "Rich cards rendered as HTML");
        }

        // Apply spoiler effect
        if (isSpoiler) {
          finalText = `<tg-spoiler>${finalText}</tg-spoiler>`;
        }

        // Log effects if any are applied
        if (options?.effects && options.effects.length > 0) {
          deps.logger.debug({ channelType: "telegram", effectsRendered: options.effects }, "Rich effects applied");
        }

        // Log buttons if present
        if (options?.buttons && options.buttons.length > 0) {
          deps.logger.debug({ channelType: "telegram", buttonsRendered: options.buttons.length }, "Rich buttons rendered");
        }

        const baseOpts = {
          ...(options?.replyTo
            ? { reply_parameters: { message_id: Number(options.replyTo) } }
            : {}),
          ...(options?.disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
          ...(isSilent ? { disable_notification: true } : {}),
          ...(options?.buttons && options.buttons.length > 0
            ? { reply_markup: renderTelegramButtons(options.buttons) }
            : {}),
        };

        // Sanitize bare `<` that aren't valid Telegram HTML tags (e.g. `<5%`)
        finalText = sanitizeTelegramHtml(finalText);

        const threadParams = resolveOutboundThreadParams(options);

        const doSend = async (tp?: { message_thread_id: number }) => {
          const opts = { ...baseOpts, ...(tp ?? {}) };
          try {
            return await bot.api.sendMessage(Number(chatId), finalText, { parse_mode: "HTML", ...opts });
          } catch (htmlErr) {
            if (isTelegramHtmlParseError(htmlErr)) {
              deps.logger.warn(
                { channelType: "telegram", chatId, err: htmlErr instanceof Error ? htmlErr : new Error(String(htmlErr)), hint: "HTML parse failed, retrying as plain text", errorKind: "platform" as const },
                "HTML parse fallback triggered",
              );
              return await bot.api.sendMessage(Number(chatId), finalText, opts);
            }
            throw htmlErr;
          }
        };

        const sent = await sendWithThreadFallback(doSend, threadParams, deps.logger);
        _lastMessageAt = Date.now();
        _lastError = undefined;
        deps.logger.debug(
          { channelType: "telegram", messageId: String(sent.message_id), chatId, preview: finalText.slice(0, 1500) },
          "Outbound message",
        );
        return ok(String(sent.message_id));
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        _lastError = sendErr.message;
        deps.logger.warn(
          {
            channelType: "telegram",
            chatId,
            err: sendErr,
            hint: "Check Telegram bot token permissions and chat accessibility",
            errorKind: "platform" as const,
          },
          "Send message failed",
        );
        return err(new Error(`Failed to send message: ${sendErr.message}`));
      }
    },

    async editMessage(
      chatId: string,
      messageId: string,
      text: string,
    ): Promise<Result<void, Error>> {
      try {
        const sanitizedText = sanitizeTelegramHtml(text);
        try {
          await bot.api.editMessageText(Number(chatId), Number(messageId), sanitizedText, {
            parse_mode: "HTML",
          });
        } catch (htmlErr) {
          if (isTelegramHtmlParseError(htmlErr)) {
            deps.logger.warn(
              { channelType: "telegram", chatId, messageId, err: htmlErr instanceof Error ? htmlErr : new Error(String(htmlErr)), hint: "HTML parse failed on edit, retrying as plain text", errorKind: "platform" as const },
              "HTML parse fallback triggered (edit)",
            );
            await bot.api.editMessageText(Number(chatId), Number(messageId), text);
          } else {
            throw htmlErr;
          }
        }
        deps.logger.debug(
          { channelType: "telegram", messageId, chatId, preview: text.slice(0, 1500) },
          "Outbound message",
        );
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to edit message: ${message}`));
      }
    },

    async reactToMessage(
      chatId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      try {
        await bot.api.setMessageReaction(Number(chatId), Number(messageId), [
          { type: "emoji", emoji } as import("grammy/types").ReactionTypeEmoji,
        ]);
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to react to message: ${message}`));
      }
    },

    async removeReaction(
      chatId: string,
      messageId: string,
      _emoji: string,
    ): Promise<Result<void, Error>> {
      try {
        await bot.api.setMessageReaction(Number(chatId), Number(messageId), []);
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to remove reaction: ${message}`));
      }
    },

    async deleteMessage(chatId: string, messageId: string): Promise<Result<void, Error>> {
      try {
        await bot.api.deleteMessage(Number(chatId), Number(messageId));
        return ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Failed to delete message: ${message}`));
      }
    },

     
    async fetchMessages(_channelId: string, _options?: FetchMessagesOptions): Promise<Result<FetchedMessage[], Error>> {
      return err(
        new Error(
          "Fetching message history is not supported on Telegram. Bots can only see messages they receive in real-time.",
        ),
      );
    },

    async sendAttachment(
      chatId: string,
      attachment: AttachmentPayload,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      // Voice note dispatch: use voice-specific API for native voice bubbles
      if (attachment.isVoiceNote && attachment.type === "audio") {
        const voiceSender = createTelegramVoiceSender({ bot, logger: deps.logger });
        const threadParams = resolveOutboundThreadParams(options);
        return voiceSender.sendVoice(
          chatId,
          attachment.url,
          attachment.durationSecs ?? 0,
          {
            replyTo: options?.replyTo,
            threadParams,
          },
        );
      }

      try {
        const isLocalPath = !attachment.url.includes("://");
        const file = isLocalPath
          ? new InputFile(attachment.url)
          : new InputFile(new URL(attachment.url));
        const replyParams = options?.replyTo
          ? { reply_parameters: { message_id: Number(options.replyTo) } }
          : {};
        const threadParams = resolveOutboundThreadParams(options);

        const doSend = async (tp?: { message_thread_id: number }) => {
          const opts = { caption: attachment.caption, ...replyParams, ...(tp ?? {}) };
          switch (attachment.type) {
            case "image": return bot.api.sendPhoto(Number(chatId), file, opts);
            case "audio": return bot.api.sendAudio(Number(chatId), file, opts);
            case "video": return bot.api.sendVideo(Number(chatId), file, opts);
            default:      return bot.api.sendDocument(Number(chatId), file, opts);
          }
        };

        const sent = await sendWithThreadFallback(doSend, threadParams, deps.logger);

        if (isLocalPath) {
          deps.logger.info(
            { channelType: "telegram", messageId: String(sent.message_id), chatId, fileName: attachment.fileName },
            "Local file attachment sent",
          );
        }
        deps.logger.debug(
          { channelType: "telegram", messageId: String(sent.message_id), chatId, preview: (attachment.caption ?? attachment.fileName ?? "").slice(0, 1500) },
          "Outbound attachment",
        );
        return ok(String(sent.message_id));
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        deps.logger.warn(
          {
            channelType: "telegram",
            chatId,
            err: sendErr,
            hint: "Check Telegram bot token permissions and file accessibility",
            errorKind: "platform" as const,
          },
          "Send attachment failed",
        );
        return err(new Error(`Failed to send attachment: ${sendErr.message}`));
      }
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      try {
        // Telegram chat IDs can be numeric or string; convert appropriately
        const resolveChatId = (raw: unknown): number | string => {
          const s = String(raw);
          return /^-?\d+$/.test(s) ? Number(s) : s;
        };

        switch (action) {
          case "pin": {
            const chatId = resolveChatId(params.chat_id);
            const messageId = Number(params.message_id);
            await bot.api.pinChatMessage(chatId, messageId);
            return ok({ pinned: true });
          }
          case "unpin": {
            const chatId = resolveChatId(params.chat_id);
            const messageId = params.message_id ? Number(params.message_id) : undefined;
            await bot.api.unpinChatMessage(chatId, messageId);
            return ok({ unpinned: true });
          }
          case "poll": {
            const chatId = resolveChatId(params.chat_id);
            const question = String(params.question);
            const options = params.options as string[];
            const result = await bot.api.sendPoll(chatId, question, options);
            return ok({ pollSent: true, chatId, messageId: result.message_id });
          }
          case "sticker": {
            const chatId = resolveChatId(params.chat_id);
            const stickerId = String(params.sticker_id);
            await bot.api.sendSticker(chatId, stickerId);
            return ok({ stickerSent: true, chatId });
          }
          case "chat_info": {
            const chatId = resolveChatId(params.chat_id);
            const chat = await bot.api.getChat(chatId);
            return ok(chat);
          }
          case "member_count": {
            const chatId = resolveChatId(params.chat_id);
            const count = await bot.api.getChatMemberCount(chatId);
            return ok({ count });
          }
          case "get_admins": {
            const chatId = resolveChatId(params.chat_id);
            const admins = await bot.api.getChatAdministrators(chatId);
            return ok({
              admins: admins.map((a) => ({
                userId: a.user.id,
                firstName: a.user.first_name,
                isBot: a.user.is_bot,
                status: a.status,
              })),
            });
          }
          case "sendTyping": {
            const chatId = resolveChatId(params.chatId ?? params.chat_id);
            const threadId = params.threadId != null ? Number(params.threadId) : undefined;
            const typingParams = buildTypingThreadParams(threadId);
            await bot.api.sendChatAction(chatId, "typing", typingParams ?? {});
            return ok({ typing: true });
          }
          case "set_title": {
            const chatId = resolveChatId(params.chat_id);
            const title = String(params.title);
            await bot.api.setChatTitle(chatId, title);
            return ok({ titleSet: true });
          }
          case "set_description": {
            const chatId = resolveChatId(params.chat_id);
            const description = String(params.description);
            await bot.api.setChatDescription(chatId, description);
            return ok({ descriptionSet: true });
          }
          case "ban": {
            const chatId = resolveChatId(params.chat_id);
            const userId = Number(params.user_id);
            await bot.api.banChatMember(chatId, userId);
            return ok({ banned: true, chatId, userId });
          }
          case "unban": {
            const chatId = resolveChatId(params.chat_id);
            const userId = Number(params.user_id);
            await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
            return ok({ unbanned: true });
          }
          case "promote": {
            const chatId = resolveChatId(params.chat_id);
            const userId = Number(params.user_id);
            const rights = (params.rights as object | undefined) ?? {};
            await bot.api.promoteChatMember(chatId, userId, rights);
            return ok({ promoted: true });
          }
          case "createForumTopic": {
            const chatId = resolveChatId(params.chat_id);
            const name = String(params.name);
            const iconColor = params.icon_color != null ? Number(params.icon_color) : undefined;
            const iconCustomEmojiId = params.icon_custom_emoji_id ? String(params.icon_custom_emoji_id) : undefined;
            const result = await bot.api.createForumTopic(chatId, name, {
              icon_color: iconColor as 0x6FB9F0 | 0xFFD67E | 0xCB86DB | 0x8EEE98 | 0xFF93B2 | 0xFB6F5F | undefined,
              icon_custom_emoji_id: iconCustomEmojiId,
            });
            return ok({ topicId: result.message_thread_id, name: result.name });
          }
          case "editForumTopic": {
            const chatId = resolveChatId(params.chat_id);
            const threadId = Number(params.message_thread_id);
            await bot.api.editForumTopic(chatId, threadId, {
              name: params.name ? String(params.name) : undefined,
              icon_custom_emoji_id: params.icon_custom_emoji_id ? String(params.icon_custom_emoji_id) : undefined,
            });
            return ok({ edited: true });
          }
          case "closeForumTopic": {
            const chatId = resolveChatId(params.chat_id);
            const threadId = Number(params.message_thread_id);
            await bot.api.closeForumTopic(chatId, threadId);
            return ok({ closed: true });
          }
          case "reopenForumTopic": {
            const chatId = resolveChatId(params.chat_id);
            const threadId = Number(params.message_thread_id);
            await bot.api.reopenForumTopic(chatId, threadId);
            return ok({ reopened: true });
          }
          default: {
            const unsupportedErr = new Error(`Unsupported action: ${action} on telegram`);
            deps.logger.warn(
              {
                channelType: "telegram",
                err: unsupportedErr,
                hint: `Action '${action}' is not supported by the Telegram adapter`,
                errorKind: "validation" as const,
              },
              "Unsupported platform action",
            );
            return err(unsupportedErr);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Telegram action '${action}' failed: ${message}`));
      }
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    getStatus(): ChannelStatus {
      return {
        connected: _connected,
        channelId: _channelId,
        channelType: "telegram",
        uptime: _connected && _startedAt ? Date.now() - _startedAt : undefined,
        lastMessageAt: _lastMessageAt,
        error: _lastError,
        connectionMode: "polling",
      };
    },

    bot, // Expose Grammy Bot instance for resolver creation
  };

  return adapter;
}
