import { ok, err, type Result } from "@comis/shared";
import { createCredentialValidator } from "../shared/credential-validator-factory.js";

/**
 * Bot identity information returned after successful Discord token validation.
 */
export interface DiscordBotInfo {
  /** Discord bot user ID */
  id: string;
  /** Bot username */
  username: string;
  /** Bot discriminator (legacy, usually "0" for new bots) */
  discriminator: string;
}

/**
 * Validate a Discord bot token by calling the /users/@me REST endpoint.
 *
 * Uses the discord.js REST class (not a full Client) to avoid starting
 * a gateway connection just for validation. This is the Discord equivalent
 * of Telegram's getMe() call.
 *
 * @param token - The Discord bot token
 * @returns DiscordBotInfo on success, Error on failure
 */
export const validateDiscordToken: (token: string) => Promise<Result<DiscordBotInfo, Error>> =
  createCredentialValidator<string, DiscordBotInfo>({
    platform: "Discord",
    validateInputs: (token) => (token.trim() === "" ? "token must not be empty" : undefined),
    callApi: async (token) => {
      try {
        const { REST, Routes } = await import("discord.js");
        const rest = new REST({ version: "10" }).setToken(token);
        const me = (await rest.get(Routes.user("@me"))) as {
          id: string;
          username: string;
          discriminator: string;
        };

        return ok({
          id: me.id,
          username: me.username,
          discriminator: me.discriminator,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return err(new Error(`Invalid Discord bot token: ${message}`));
      }
    },
  });
