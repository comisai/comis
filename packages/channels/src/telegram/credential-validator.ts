// SPDX-License-Identifier: Apache-2.0
import { ok, err, type Result } from "@comis/shared";
import { Bot } from "grammy";
import type { HttpsProxyAgent } from "https-proxy-agent";
import { classifiedValidationErr } from "../shared/credential-validation-error.js";

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
 * @param apiRoot - Optional Bot API root URL override. Production: undefined
 *   (grammy defaults to https://api.telegram.org). E2E tests: 127.0.0.1 mock.
 * @param agent - Optional HttpsProxyAgent for egress-proxy environments. grammy
 *   uses a node-fetch-style transport that does NOT honor undici's global
 *   dispatcher, so the proxy must be wired explicitly via `baseFetchConfig.agent`
 *   — the same agent the adapter uses at runtime. MUST be passed when a proxy is
 *   configured, otherwise this pre-flight getMe() goes direct and fails in
 *   egress-locked networks even though the bot token is valid.
 * @returns BotInfo on success, Error on failure
 */
export async function validateBotToken(
  token: string,
  apiRoot?: string,
  agent?: HttpsProxyAgent<string>,
): Promise<Result<BotInfo, Error>> {
  if (token.trim() === "") {
    return err(new Error("Invalid Telegram credentials: token must not be empty"));
  }
  try {
    // E2E seam: passing the grammy `client.apiRoot` option only when the
    // caller redirected — production callers leave `apiRoot` undefined and
    // grammy uses its default (https://api.telegram.org).
    // Proxy: mirror the adapter's baseFetchConfig.agent wiring so the pre-flight
    // getMe() routes through the configured egress proxy.
    const baseFetchConfig = agent ? { compress: true, agent } : undefined;
    const clientOptions = {
      ...(apiRoot ? { apiRoot } : {}),
      ...(baseFetchConfig ? { baseFetchConfig } : {}),
    };
    const bot =
      Object.keys(clientOptions).length > 0
        ? new Bot(token, { client: clientOptions })
        : new Bot(token);
    const me = await bot.api.getMe();
    return ok({
      id: me.id,
      username: me.username ?? "",
      isBot: me.is_bot,
    });
  } catch (error: unknown) {
    // Branch by failure class: a network/proxy reachability failure is NOT a bad
    // token — surfacing "invalid token" sent operators the wrong way during the
    // egress-proxy incident.
    return classifiedValidationErr(
      error,
      "Invalid Telegram bot token",
      "Telegram getMe() unreachable (network/proxy)",
    );
  }
}

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
