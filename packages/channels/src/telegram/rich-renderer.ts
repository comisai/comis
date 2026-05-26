// SPDX-License-Identifier: Apache-2.0
/**
 * Telegram Rich Renderer: Pure functions converting domain types to Grammy/HTML formats.
 *
 * Converts RichButton[][] to InlineKeyboard instances and
 * RichCard[] to HTML-formatted text for Telegram's sendMessage API.
 *
 * Pure functions with no side effects -- fully testable without network.
 *
 * @module
 */

import type { RichButton, RichCard } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { InlineKeyboard } from "grammy";

/** Telegram callback_data byte limit. */
const MAX_CALLBACK_DATA_BYTES = 64;

/** Over-budget callback_data: refuse loud rather than truncate (the signature would corrupt). */
export type CallbackDataBudgetError = {
  kind: "callback_data_overflow";
  bytes: number;
  maxBytes: typeof MAX_CALLBACK_DATA_BYTES;
};

/**
 * Validate that callback_data fits Telegram's 64-byte budget without mutating it.
 *
 * Signed callback payloads carry an HMAC; truncating one corrupts the signature
 * and silently breaks verification. The worst-case signed payload is ~40 bytes
 * (well under the budget), so this is defense-in-depth: it refuses loud (`err`)
 * on the never-expected overflow instead of cutting bytes. Byte length is the
 * UTF-8 encoded length, not the character count.
 */
export function validateCallbackDataWithinBudget(
  data: string,
): Result<string, CallbackDataBudgetError> {
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > MAX_CALLBACK_DATA_BYTES) {
    return err({ kind: "callback_data_overflow", bytes, maxBytes: MAX_CALLBACK_DATA_BYTES });
  }
  return ok(data);
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert domain RichButton rows to a Grammy InlineKeyboard.
 *
 * Each inner array becomes one keyboard row. URL buttons use .url(),
 * callback buttons use .text(). Callback data is validated against Telegram's
 * 64-byte limit and an over-budget callback button is omitted rather than
 * truncated -- truncating would corrupt a signed payload's HMAC. The worst-case
 * signed payload is ~40 bytes, so this guard never fires in practice.
 *
 * @param buttons - Two-dimensional array of RichButton (rows x buttons)
 * @returns InlineKeyboard instance ready for Telegram reply_markup
 */
export function renderTelegramButtons(buttons: RichButton[][]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (let rowIdx = 0; rowIdx < buttons.length; rowIdx++) {
    const row = buttons[rowIdx];
    for (const btn of row) {
      if (btn.url) {
        keyboard.url(btn.text, btn.url);
      } else {
        const budget = validateCallbackDataWithinBudget(btn.callback_data ?? btn.text);
        // Defensive: skip an over-budget callback button rather than truncate
        // (truncation corrupts a signed callback's HMAC). Real payloads always fit.
        if (!budget.ok) continue;
        keyboard.text(btn.text, budget.value);
      }
    }
    // Add row break after each row (except the last)
    if (rowIdx < buttons.length - 1) {
      keyboard.row();
    }
  }

  return keyboard;
}

/**
 * Convert domain RichCard array to Telegram HTML-formatted text.
 *
 * Telegram has no native embed/card concept, so cards are rendered as
 * structured HTML text. Images use invisible links to trigger preview.
 *
 * @param cards - Array of RichCard domain objects
 * @returns HTML string suitable for Telegram parse_mode: "HTML"
 */
export function renderTelegramCards(cards: RichCard[]): string {
  const parts: string[] = [];

  for (const card of cards) {
    const lines: string[] = [];

    if (card.title) {
      lines.push(`<b>${escapeHtml(card.title)}</b>`);
    }
    if (card.description) {
      lines.push(`<i>${escapeHtml(card.description)}</i>`);
    }
    if (card.fields && card.fields.length > 0) {
      for (const f of card.fields) {
        lines.push(`<b>${escapeHtml(f.name)}:</b> ${escapeHtml(f.value)}`);
      }
    }
    if (card.image_url) {
      // Invisible link triggers Telegram's link preview with the image
      lines.push(`<a href="${escapeHtml(card.image_url)}">\u200B</a>`);
    }

    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}
