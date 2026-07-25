// SPDX-License-Identifier: Apache-2.0
/** Trusted Telegram API error narrowing for delivery-changing fallbacks. */

import { GrammyError } from "grammy";

/**
 * Return a definitive Telegram 400 rejection from grammY itself.
 *
 * Generic errors and structurally similar objects are deliberately rejected:
 * only the SDK class proves that Telegram returned the response. The direct
 * cause form supports adapter boundary errors that preserve the SDK error.
 */
export function getTelegramBadRequest(error: unknown): GrammyError | undefined {
  const telegramError = error instanceof GrammyError
    ? error
    : error instanceof Error && error.cause instanceof GrammyError
      ? error.cause
      : undefined;

  return telegramError?.error_code === 400 ? telegramError : undefined;
}
