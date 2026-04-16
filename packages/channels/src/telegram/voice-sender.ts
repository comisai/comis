/**
 * Telegram voice sender: sends OGG/Opus voice messages via the Bot API.
 *
 * Uses bot.api.sendVoice for native Telegram voice bubble display.
 * VOICE_MESSAGES_FORBIDDEN / CHAT_SEND_VOICES_FORBIDDEN errors trigger graceful
 * fallback to sendDocument so the audio still reaches the user.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { type Bot, InputFile } from "grammy";

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
  ): Promise<Result<string, Error>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Telegram voice sender that wraps bot.api.sendVoice with
 * VOICE_MESSAGES_FORBIDDEN fallback to sendDocument.
 */
export function createTelegramVoiceSender(deps: TelegramVoiceSenderDeps): TelegramVoiceSender {
  const { bot, logger } = deps;

  return {
    async sendVoice(
      chatId: string,
      filePath: string,
      durationSecs: number,
      options?: TelegramVoiceSendOptions,
    ): Promise<Result<string, Error>> {
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

        const messageId = String(sent.message_id);
        logger.info(
          { channelType: "telegram", messageId, chatId, durationSecs },
          "Voice send complete",
        );

        return ok(messageId);
      } catch (error) {
        const sendErr = error instanceof Error ? error : new Error(String(error));
        const message = sendErr.message;

        // Graceful fallback for VOICE_MESSAGES_FORBIDDEN
        if (
          message.includes("VOICE_MESSAGES_FORBIDDEN") ||
          message.includes("CHAT_SEND_VOICES_FORBIDDEN")
        ) {
          logger.warn(
            {
              channelType: "telegram",
              chatId,
              hint: "Recipient has premium voice message privacy enabled; falling back to document",
              errorKind: "platform",
            },
            "Voice send forbidden, falling back to document",
          );

          try {
            const docFile = new InputFile(filePath);
            const docSent = await bot.api.sendDocument(Number(chatId), docFile, {
              caption: "Voice message (sent as file)",
            });

            return ok(String(docSent.message_id));
          } catch (docError) {
            const docErr = docError instanceof Error ? docError : new Error(String(docError));
            return err(new Error(`Voice fallback to document failed: ${docErr.message}`));
          }
        }

        // Non-FORBIDDEN error
        logger.warn(
          {
            channelType: "telegram",
            chatId,
            err: sendErr,
            hint: "Check Telegram bot token permissions",
            errorKind: "platform",
          },
          "Voice send failed",
        );

        return err(new Error(`Failed to send voice: ${sendErr.message}`));
      }
    },
  };
}
