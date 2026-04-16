/**
 * Telegram emoji variant fallback chain for lifecycle reactions.
 *
 * Telegram restricts which emoji can be used as reactions in some chats.
 * When the primary emoji fails with REACTION_INVALID, this module tries
 * a chain of safe emoji until one succeeds.
 *
 * @module
 */

import type { ChannelPort } from "@comis/core";
import type { Result } from "@comis/shared";

/**
 * Fallback chain of emoji that are almost always available in Telegram
 * restricted chats. Ordered by likelihood of acceptance.
 */
export const TELEGRAM_SAFE_EMOJI: readonly string[] = [
  "\u{1F44D}",      // thumbs up
  "\u{1F440}",      // eyes
  "\u{2764}\u{FE0F}", // red heart
  "\u{1F525}",      // fire
  "\u{2705}",       // green check mark
  "\u{274C}",       // red cross mark
];

/**
 * Try to react with the primary emoji. If the error is REACTION_INVALID,
 * try each emoji in the TELEGRAM_SAFE_EMOJI chain until one succeeds.
 *
 * Non-REACTION_INVALID errors are returned immediately without fallback
 * (e.g., network errors, rate limits, message not found).
 *
 * @param adapter - The channel adapter to call reactToMessage on
 * @param channelId - Target chat ID
 * @param messageId - Platform message ID
 * @param primaryEmoji - The preferred emoji to try first
 * @returns Result from the successful reaction or the last error
 */
export async function reactWithFallback(
  adapter: ChannelPort,
  channelId: string,
  messageId: string,
  primaryEmoji: string,
): Promise<Result<void, Error>> {
  // Try primary emoji first
  const primaryResult = await adapter.reactToMessage(channelId, messageId, primaryEmoji);
  if (primaryResult.ok) return primaryResult;

  // Check if error is a REACTION_INVALID type
  const errorMessage = primaryResult.error.message ?? "";
  const isReactionInvalid =
    errorMessage.includes("REACTION_INVALID") ||
    /reaction/i.test(errorMessage);

  // Non-REACTION_INVALID errors: return immediately without fallback
  if (!isReactionInvalid) return primaryResult;

  // Try each safe emoji in the fallback chain
  let lastResult: Result<void, Error> = primaryResult;
  for (const safeEmoji of TELEGRAM_SAFE_EMOJI) {
    // Skip if same as the primary that just failed
    if (safeEmoji === primaryEmoji) continue;

    lastResult = await adapter.reactToMessage(channelId, messageId, safeEmoji);
    if (lastResult.ok) return lastResult;
  }

  // All fallbacks failed -- return the last error
  return lastResult;
}
