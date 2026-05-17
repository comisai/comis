// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";

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
 * @param apiRoot - Optional REST API root URL override (production: undefined;
 *   E2E tests: `http://127.0.0.1:<mock-port>`). When set, the REST client
 *   talks to this URL instead of `https://discord.com/api`.
 * @returns DiscordBotInfo on success, Error on failure
 */
export async function validateDiscordToken(
  token: string,
  apiRoot?: string,
): Promise<Result<DiscordBotInfo, Error>> {
  if (token.trim() === "") {
    return err(new Error("Invalid Discord credentials: token must not be empty"));
  }
  try {
    const { REST, Routes } = await import("discord.js");
    // E2E seam: when caller passes `apiRoot`, point @discordjs/rest at the
    // override URL. Production path leaves the option object untouched so
    // discord.js uses its built-in default.
    const rest = apiRoot
      ? new REST({ version: "10", api: apiRoot }).setToken(token)
      : new REST({ version: "10" }).setToken(token);
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
}
