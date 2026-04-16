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
import { InlineKeyboard } from "grammy";

/** Telegram callback_data byte limit. */
const MAX_CALLBACK_DATA_BYTES = 64;

/**
 * Truncate callback data to fit within Telegram's 64-byte limit.
 */
function truncateCallbackData(data: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  if (bytes.length <= MAX_CALLBACK_DATA_BYTES) return data;

  // Truncate bytes and decode back -- TextDecoder handles partial chars
  const truncated = bytes.slice(0, MAX_CALLBACK_DATA_BYTES);
  return new TextDecoder("utf-8", { fatal: false }).decode(truncated);
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
 * callback buttons use .text(). Callback data is truncated to 64 bytes
 * per Telegram's limit.
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
        const data = truncateCallbackData(btn.callback_data ?? btn.text);
        keyboard.text(btn.text, data);
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
