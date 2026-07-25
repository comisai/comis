// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram voice sender: sends OGG/Opus voice messages via the Bot API.
 *
 * Uses bot.api.sendVoice for native Telegram voice bubble display.
 * Definitive Telegram 400 VOICE_MESSAGES_FORBIDDEN and
 * CHAT_SEND_VOICES_FORBIDDEN rejections trigger fallback to sendDocument so
 * the audio still reaches the user.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { type Bot, InputFile } from "grammy";
import {
  createAttachmentSendReceipt,
  toSafeErrorLogString,
  type AttachmentSendReceipt,
} from "@comis/core";
import { getTelegramBadRequest } from "./telegram-api-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal logger interface for voice sender. */
interface VoiceSenderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TelegramVoiceSenderDeps {
  readonly bot: Bot;
  readonly logger: VoiceSenderLogger;
}

export interface TelegramVoiceSendOptions {
  readonly replyTo?: string;
  readonly threadParams?: { message_thread_id: number };
}

export interface TelegramVoiceSender {
  sendVoice(
    chatId: string,
    filePath: string,
    durationSecs: number,
    options?: TelegramVoiceSendOptions,
  ): Promise<Result<AttachmentSendReceipt, Error>>;
}

function createTelegramVoiceReceipt(messageId: unknown): AttachmentSendReceipt {
  const validMessageId = typeof messageId === "number" &&
    Number.isSafeInteger(messageId) &&
    messageId > 0
    ? String(messageId)
    : undefined;
  return createAttachmentSendReceipt(validMessageId);
}

function warnIfUntracked(
  logger: VoiceSenderLogger,
  chatId: string,
  receipt: AttachmentSendReceipt,
): void {
  if (receipt.kind === "tracked") return;

  logger.warn(
    {
      channelType: "telegram",
      chatId,
      hint: "The send completed without a valid Telegram message ID. Do not retry; inspect the Telegram API response",
      errorKind: "platform" as const,
    },
    "Voice sent without platform tracking",
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Telegram voice sender that wraps bot.api.sendVoice with a
 * definitive Telegram voice-forbidden fallback to sendDocument.
 */
export function createTelegramVoiceSender(deps: TelegramVoiceSenderDeps): TelegramVoiceSender {
  const { bot, logger } = deps;

  return {
    async sendVoice(
      chatId: string,
      filePath: string,
      durationSecs: number,
      options?: TelegramVoiceSendOptions,
    ): Promise<Result<AttachmentSendReceipt, Error>> {
      logger.info(
        { channelType: "telegram", chatId, durationSecs },
        "Voice send started",
      );

      try {
        const file = new InputFile(filePath);
        const replyParams = options?.replyTo
          ? { reply_parameters: { message_id: Number(options.replyTo) } }
          : {};

        const sent = await bot.api.sendVoice(Number(chatId), file, {
          duration: durationSecs,
          ...replyParams,
          ...options?.threadParams,
        });

        const receipt = createTelegramVoiceReceipt(sent.message_id);
        warnIfUntracked(logger, chatId, receipt);
        logger.info(
          {
            channelType: "telegram",
            chatId,
            durationSecs,
            tracking: receipt.kind,
            ...(receipt.kind === "tracked" ? { messageId: receipt.messageId } : {}),
          },
          "Voice send complete",
        );

        return ok(receipt);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        const telegramDescription = getTelegramBadRequest(error)?.description;

        // A Telegram 400 proves the voice was rejected before changing delivery method.
        if (
          telegramDescription === "Bad Request: VOICE_MESSAGES_FORBIDDEN" ||
          telegramDescription === "Bad Request: CHAT_SEND_VOICES_FORBIDDEN"
        ) {
          logger.warn(
            {
              channelType: "telegram",
              chatId,
              hint: "Recipient has premium voice message privacy enabled; falling back to document",
              errorKind: "platform" as const,
            },
            "Voice send forbidden, falling back to document",
          );

          try {
            const docFile = new InputFile(filePath);
            const docSent = await bot.api.sendDocument(Number(chatId), docFile, {
              caption: "Voice message (sent as file)",
            });

            const receipt = createTelegramVoiceReceipt(docSent.message_id);
            warnIfUntracked(logger, chatId, receipt);
            return ok(receipt);
          } catch (docError) {
            return err(new Error(
              `Voice fallback to document failed: ${toSafeErrorLogString(docError)}`,
              { cause: docError },
            ));
          }
        }

        // Non-FORBIDDEN error
        logger.warn(
          {
            channelType: "telegram",
            chatId,
            err: toSafeErrorLogString(sendErr),
            hint: "Check Telegram bot token permissions",
            errorKind: "platform" as const,
          },
          "Voice send failed",
        );

        return err(new Error(
          `Failed to send voice: ${toSafeErrorLogString(sendErr)}`,
          { cause: error },
        ));
      }
    },
  };
}
