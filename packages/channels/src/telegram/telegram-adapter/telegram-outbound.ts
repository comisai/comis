// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Telegram SDK boundary throws; consumed by adapter try/catch + inbound-pipeline catch.
/** Telegram outbound operations using state-first adapter helpers. */

import { InputFile } from "grammy";
import { ok, err } from "@comis/shared";
import { systemNowMs } from "@comis/core";
import type { Result } from "@comis/shared";
import type {
  AttachmentPayload,
  SendMessageOptions,
} from "@comis/core";
import { renderTelegramButtons, renderTelegramCards } from "../rich-renderer.js";
import {
  buildTypingThreadParams,
  resolveOutboundThreadParams,
} from "../thread-context.js";
import { createTelegramVoiceSender } from "../voice-sender.js";
import type {
  TelegramAdapterDeps,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";
import {
  isTelegramHtmlParseError,
  sanitizeTelegramHtml,
  sendWithThreadFallback,
} from "./telegram-webhook.js";

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

export async function sendMessage(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
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
        return await state.bot.api.sendMessage(Number(chatId), finalText, { parse_mode: "HTML", ...opts });
      } catch (htmlErr) {
        if (isTelegramHtmlParseError(htmlErr)) {
          deps.logger.warn(
            { channelType: "telegram", chatId, err: htmlErr instanceof Error ? htmlErr : new Error(String(htmlErr)), hint: "HTML parse failed, retrying as plain text", errorKind: "platform" as const },
            "HTML parse fallback triggered",
          );
          return await state.bot.api.sendMessage(Number(chatId), finalText, opts);
        }
        throw htmlErr;
      }
    };

    const sent = await sendWithThreadFallback(doSend, threadParams, deps.logger);
    state.lastMessageAt = systemNowMs();
    state.lastError = undefined;
    deps.logger.info(
      { step: "channels-outbound", channelType: "telegram", messageId: String(sent.message_id), chatId },
      "Outbound message",
    );
    return ok(String(sent.message_id));
  } catch (error) {
    const sendErr = error instanceof Error ? error : new Error(String(error));
    state.lastError = sendErr.message;
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
    // Preserve the typed GrammyError (error_code/parameters) as `cause` so an
    // activity render-actions adapter can classify it STRUCTURALLY —
    // it must never parse this generic message string.
    return err(new Error(`Failed to send message: ${sendErr.message}`, { cause: error }));
  }
}

// ---------------------------------------------------------------------------
// editMessage
// ---------------------------------------------------------------------------

export async function editMessage(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  chatId: string,
  messageId: string,
  text: string,
): Promise<Result<void, Error>> {
  try {
    const sanitizedText = sanitizeTelegramHtml(text);
    try {
      await state.bot.api.editMessageText(Number(chatId), Number(messageId), sanitizedText, {
        parse_mode: "HTML",
      });
    } catch (htmlErr) {
      if (isTelegramHtmlParseError(htmlErr)) {
        deps.logger.warn(
          { channelType: "telegram", chatId, messageId, err: htmlErr instanceof Error ? htmlErr : new Error(String(htmlErr)), hint: "HTML parse failed on edit, retrying as plain text", errorKind: "platform" as const },
          "HTML parse fallback triggered (edit)",
        );
        await state.bot.api.editMessageText(Number(chatId), Number(messageId), text);
      } else {
        throw htmlErr;
      }
    }
    deps.logger.info(
      { step: "channels-outbound", channelType: "telegram", messageId, chatId },
      "Outbound message",
    );
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve the typed GrammyError as `cause` for structural classification
    // (429 → rate_limited, message-not-found → not_supported).
    return err(new Error(`Failed to edit message: ${message}`, { cause: error }));
  }
}

// ---------------------------------------------------------------------------
// reactToMessage / removeReaction / deleteMessage
// ---------------------------------------------------------------------------

export async function reactToMessage(
  state: TelegramAdapterState,
  _deps: TelegramAdapterDeps,
  chatId: string,
  messageId: string,
  emoji: string,
): Promise<Result<void, Error>> {
  try {
    await state.bot.api.setMessageReaction(Number(chatId), Number(messageId), [
      { type: "emoji", emoji } as import("grammy/types").ReactionTypeEmoji,
    ]);
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Failed to react to message: ${message}`));
  }
}

export async function removeReaction(
  state: TelegramAdapterState,
  _deps: TelegramAdapterDeps,
  chatId: string,
  messageId: string,
  _emoji: string,
): Promise<Result<void, Error>> {
  try {
    await state.bot.api.setMessageReaction(Number(chatId), Number(messageId), []);
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new Error(`Failed to remove reaction: ${message}`));
  }
}

export async function deleteMessage(
  state: TelegramAdapterState,
  _deps: TelegramAdapterDeps,
  chatId: string,
  messageId: string,
): Promise<Result<void, Error>> {
  try {
    await state.bot.api.deleteMessage(Number(chatId), Number(messageId));
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve the typed GrammyError as `cause` for structural classification.
    return err(new Error(`Failed to delete message: ${message}`, { cause: error }));
  }
}

// ---------------------------------------------------------------------------
// sendAttachment
// ---------------------------------------------------------------------------

export async function sendAttachment(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
  chatId: string,
  attachment: AttachmentPayload,
  options?: SendMessageOptions,
): Promise<Result<string, Error>> {
  // Voice note dispatch: use voice-specific API for native voice bubbles
  if (attachment.isVoiceNote && attachment.type === "audio") {
    const voiceSender = createTelegramVoiceSender({ bot: state.bot, logger: deps.logger });
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
        case "image": return state.bot.api.sendPhoto(Number(chatId), file, opts);
        case "audio": return state.bot.api.sendAudio(Number(chatId), file, opts);
        case "video": return state.bot.api.sendVideo(Number(chatId), file, opts);
        default:      return state.bot.api.sendDocument(Number(chatId), file, opts);
      }
    };

    const sent = await sendWithThreadFallback(doSend, threadParams, deps.logger);

    // A successful Telegram send ALWAYS returns a numeric message_id. A missing id
    // means the platform did not accept the media — returning ok(String(undefined))
    // === "undefined" is a false success that hides a real delivery failure
    // (generated media can produce real artifacts that are never delivered while
    // the adapter logs "attachment sent" with messageId:"undefined"). Fail
    // honestly + name the knob instead of a silent false-success.
    const sentMessageId = (sent as { message_id?: number } | undefined)?.message_id;
    if (sentMessageId == null) {
      deps.logger.warn(
        {
          channelType: "telegram",
          chatId,
          attachmentType: attachment.type,
          captionLength: attachment.caption?.length ?? 0,
          hasFileName: attachment.fileName !== undefined,
          hint: "Telegram media send returned no message_id — the send was not accepted (a non-standard/empty response or a dropped upload); verify the chat exists and that the Bot API method supports this media type",
          errorKind: "platform" as const,
        },
        "Media attachment send returned no message_id",
      );
      return err(
        new Error(
          `Telegram ${attachment.type} send returned no message_id (send not accepted)`,
        ),
      );
    }

    if (isLocalPath) {
      deps.logger.info(
        {
          channelType: "telegram",
          messageId: String(sentMessageId),
          chatId,
          attachmentType: attachment.type,
          captionLength: attachment.caption?.length ?? 0,
          hasFileName: attachment.fileName !== undefined,
        },
        "Local file attachment sent",
      );
    }
    deps.logger.debug(
      {
        channelType: "telegram",
        messageId: String(sentMessageId),
        chatId,
        attachmentType: attachment.type,
        captionLength: attachment.caption?.length ?? 0,
        hasFileName: attachment.fileName !== undefined,
      },
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
}

// ---------------------------------------------------------------------------
// platformAction
// ---------------------------------------------------------------------------

export async function platformAction(
  state: TelegramAdapterState,
  deps: TelegramAdapterDeps,
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
        await state.bot.api.pinChatMessage(chatId, messageId);
        return ok({ pinned: true });
      }
      case "unpin": {
        const chatId = resolveChatId(params.chat_id);
        const messageId = params.message_id ? Number(params.message_id) : undefined;
        await state.bot.api.unpinChatMessage(chatId, messageId);
        return ok({ unpinned: true });
      }
      case "poll": {
        const chatId = resolveChatId(params.chat_id);
        const question = String(params.question);
        const options = params.options as string[];
        const result = await state.bot.api.sendPoll(chatId, question, options);
        return ok({ pollSent: true, chatId, messageId: result.message_id });
      }
      case "sticker": {
        const chatId = resolveChatId(params.chat_id);
        const stickerId = String(params.sticker_id);
        await state.bot.api.sendSticker(chatId, stickerId);
        return ok({ stickerSent: true, chatId });
      }
      case "chat_info": {
        const chatId = resolveChatId(params.chat_id);
        const chat = await state.bot.api.getChat(chatId);
        return ok(chat);
      }
      case "member_count": {
        const chatId = resolveChatId(params.chat_id);
        const count = await state.bot.api.getChatMemberCount(chatId);
        return ok({ count });
      }
      case "get_admins": {
        const chatId = resolveChatId(params.chat_id);
        const admins = await state.bot.api.getChatAdministrators(chatId);
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
        await state.bot.api.sendChatAction(chatId, "typing", typingParams ?? {});
        return ok({ typing: true });
      }
      case "set_title": {
        const chatId = resolveChatId(params.chat_id);
        const title = String(params.title);
        await state.bot.api.setChatTitle(chatId, title);
        return ok({ titleSet: true });
      }
      case "set_description": {
        const chatId = resolveChatId(params.chat_id);
        const description = String(params.description);
        await state.bot.api.setChatDescription(chatId, description);
        return ok({ descriptionSet: true });
      }
      case "ban": {
        const chatId = resolveChatId(params.chat_id);
        const userId = Number(params.user_id);
        await state.bot.api.banChatMember(chatId, userId);
        return ok({ banned: true, chatId, userId });
      }
      case "unban": {
        const chatId = resolveChatId(params.chat_id);
        const userId = Number(params.user_id);
        await state.bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
        return ok({ unbanned: true });
      }
      case "promote": {
        const chatId = resolveChatId(params.chat_id);
        const userId = Number(params.user_id);
        const rights = (params.rights as object | undefined) ?? {};
        await state.bot.api.promoteChatMember(chatId, userId, rights);
        return ok({ promoted: true });
      }
      case "createForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const name = String(params.name);
        const iconColor = params.icon_color != null ? Number(params.icon_color) : undefined;
        const iconCustomEmojiId = params.icon_custom_emoji_id ? String(params.icon_custom_emoji_id) : undefined;
        const result = await state.bot.api.createForumTopic(chatId, name, {
          icon_color: iconColor as 0x6FB9F0 | 0xFFD67E | 0xCB86DB | 0x8EEE98 | 0xFF93B2 | 0xFB6F5F | undefined,
          icon_custom_emoji_id: iconCustomEmojiId,
        });
        return ok({ topicId: result.message_thread_id, name: result.name });
      }
      case "editForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const threadId = Number(params.message_thread_id);
        await state.bot.api.editForumTopic(chatId, threadId, {
          name: params.name ? String(params.name) : undefined,
          icon_custom_emoji_id: params.icon_custom_emoji_id ? String(params.icon_custom_emoji_id) : undefined,
        });
        return ok({ edited: true });
      }
      case "closeForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const threadId = Number(params.message_thread_id);
        await state.bot.api.closeForumTopic(chatId, threadId);
        return ok({ closed: true });
      }
      case "reopenForumTopic": {
        const chatId = resolveChatId(params.chat_id);
        const threadId = Number(params.message_thread_id);
        await state.bot.api.reopenForumTopic(chatId, threadId);
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
}
