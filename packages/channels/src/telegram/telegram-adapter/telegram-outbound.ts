// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Telegram SDK boundary throws; consumed by adapter try/catch + inbound-pipeline catch.
/** Telegram outbound operations using state-first adapter helpers. */

import { InputFile } from "grammy";
import { ok, err } from "@comis/shared";
import {
  createAttachmentSendReceipt,
  systemNowMs,
  toSafeErrorLogString,
} from "@comis/core";
import type { Result } from "@comis/shared";
import type {
  AttachmentPayload,
  AttachmentSendReceipt,
  SendMessageOptions,
} from "@comis/core";
import { renderTelegramButtons, renderTelegramCards } from "../rich-renderer.js";
import {
  resolveOutboundThreadParams,
} from "../thread-context.js";
import { createTelegramVoiceSender } from "../voice-sender.js";
import type {
  TelegramAdapterDeps,
  TelegramAdapterState,
} from "./telegram-adapter-types.js";
import { getActiveBot } from "./telegram-active-bot.js";
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
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
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
            { channelType: "telegram", chatId, err: toSafeErrorLogString(htmlErr), hint: "HTML parse failed, retrying as plain text", errorKind: "platform" as const },
            "HTML parse fallback triggered",
          );
          return await bot.api.sendMessage(Number(chatId), finalText, opts);
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
    const safeSendError = toSafeErrorLogString(sendErr);
    state.lastError = safeSendError;
    deps.logger.warn(
      {
        channelType: "telegram",
        chatId,
        err: safeSendError,
        hint: "Check Telegram bot token permissions and chat accessibility",
        errorKind: "platform" as const,
      },
      "Send message failed",
    );
    // Preserve the typed GrammyError (error_code/parameters) as `cause` so an
    // activity render-actions adapter can classify it STRUCTURALLY —
    // it must never parse this generic message string.
    return err(new Error(`Failed to send message: ${safeSendError}`, { cause: error }));
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
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
  try {
    const sanitizedText = sanitizeTelegramHtml(text);
    try {
      await bot.api.editMessageText(Number(chatId), Number(messageId), sanitizedText, {
        parse_mode: "HTML",
      });
    } catch (htmlErr) {
      if (isTelegramHtmlParseError(htmlErr)) {
        deps.logger.warn(
          { channelType: "telegram", chatId, messageId, err: toSafeErrorLogString(htmlErr), hint: "HTML parse failed on edit, retrying as plain text", errorKind: "platform" as const },
          "HTML parse fallback triggered (edit)",
        );
        await bot.api.editMessageText(Number(chatId), Number(messageId), text);
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
    const message = toSafeErrorLogString(error);
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
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
  try {
    await bot.api.setMessageReaction(Number(chatId), Number(messageId), [
      { type: "emoji", emoji } as import("grammy/types").ReactionTypeEmoji,
    ]);
    return ok(undefined);
  } catch (error) {
    const message = toSafeErrorLogString(error);
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
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
  try {
    await bot.api.setMessageReaction(Number(chatId), Number(messageId), []);
    return ok(undefined);
  } catch (error) {
    const message = toSafeErrorLogString(error);
    return err(new Error(`Failed to remove reaction: ${message}`));
  }
}

export async function deleteMessage(
  state: TelegramAdapterState,
  _deps: TelegramAdapterDeps,
  chatId: string,
  messageId: string,
): Promise<Result<void, Error>> {
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
  try {
    await bot.api.deleteMessage(Number(chatId), Number(messageId));
    return ok(undefined);
  } catch (error) {
    const message = toSafeErrorLogString(error);
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
): Promise<Result<AttachmentSendReceipt, Error>> {
  const activeBot = getActiveBot(state);
  if (!activeBot.ok) return activeBot;
  const bot = activeBot.value;
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

    const sentMessageId = (sent as { message_id?: number } | undefined)?.message_id;
    if (!Number.isSafeInteger(sentMessageId) || (sentMessageId ?? 0) <= 0) {
      deps.logger.warn(
        {
          channelType: "telegram",
          chatId,
          attachmentType: attachment.type,
          captionLength: attachment.caption?.length ?? 0,
          hasFileName: attachment.fileName !== undefined,
          hint: "Verify the Telegram Bot API response and that the selected media method returns a positive numeric message_id",
          errorKind: "platform" as const,
        },
        "Media attachment send returned no message_id",
      );
      return err(new Error(`Telegram ${attachment.type} send returned no valid message_id`));
    }
    const receipt = createAttachmentSendReceipt(String(sentMessageId));

    if (isLocalPath) {
      deps.logger.info(
        {
          channelType: "telegram",
          ...(receipt.kind === "tracked" ? { messageId: receipt.messageId } : {}),
          tracking: receipt.kind,
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
        ...(receipt.kind === "tracked" ? { messageId: receipt.messageId } : {}),
        tracking: receipt.kind,
        chatId,
        attachmentType: attachment.type,
        captionLength: attachment.caption?.length ?? 0,
        hasFileName: attachment.fileName !== undefined,
      },
      "Outbound attachment",
    );
    return ok(receipt);
  } catch (error) {
    const safeSendError = toSafeErrorLogString(error);
    deps.logger.warn(
      {
        channelType: "telegram",
        chatId,
        err: safeSendError,
        hint: "Check Telegram bot token permissions and file accessibility",
        errorKind: "platform" as const,
      },
      "Send attachment failed",
    );
    return err(new Error(`Failed to send attachment: ${safeSendError}`, { cause: error }));
  }
}
