import { ok, err, type Result } from "@comis/shared";
import { Bot } from "grammy";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

/**
 * Bot identity information returned after successful token validation.
 */
export interface BotInfo {
  /** Telegram bot user ID */
  id: number;
  /** Bot username (e.g. "my_cool_bot") */
  username: string;
  /** Whether the user is a bot (always true for valid bot tokens) */
  isBot: boolean;
}

/**
 * Validate a Telegram bot token by calling the getMe() API.
 *
 * Creates a temporary Bot instance, calls getMe(), and returns the bot's
 * identity on success. On failure, wraps the Grammy error with a clear
 * message.
 *
 * This should be called at adapter startup to fail fast on invalid tokens.
 *
 * @param token - The Telegram bot token (e.g. "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11")
 * @returns BotInfo on success, Error on failure
 */
export const validateBotToken: (token: string) => Promise<Result<BotInfo, Error>> =
  createCredentialValidator<string, BotInfo>({
    platform: "Telegram",
    validateInputs: (token) => (token.trim() === "" ? "token must not be empty" : undefined),
    callApi: async (token) => {
      try {
        const bot = new Bot(token);
        const me = await bot.api.getMe();
        return ok({
          id: me.id,
          username: me.username ?? "",
          isBot: me.is_bot,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Invalid Telegram bot token: ${message}`));
      }
    },
  });

/**
 * Validate a webhook secret token for Telegram's secret_token parameter.
 *
 * Telegram's requirements:
 * - Must be non-empty
 * - 1-256 characters
 * - ASCII characters only (1-255 byte range, no nulls)
 *
 * @param secret - The webhook secret to validate
 * @returns The validated secret on success, Error on failure
 */
export function validateWebhookSecret(secret: string): Result<string, Error> {
  if (secret.length === 0) {
    return err(new Error("Webhook secret must not be empty"));
  }

  if (secret.length > 256) {
    return err(new Error(`Webhook secret must be 1-256 characters, got ${secret.length}`));
  }

  // Check for ASCII-only characters (codes 1-127)
  for (let i = 0; i < secret.length; i++) {
    const code = secret.charCodeAt(i);
    if (code > 127 || code === 0) {
      return err(new Error("Webhook secret must contain only ASCII characters"));
    }
  }

  return ok(secret);
}
