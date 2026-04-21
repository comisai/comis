// SPDX-License-Identifier: Apache-2.0
/**
 * Slack Rich Renderer: Pure functions converting domain types to Block Kit JSON.
 *
 * Converts RichButton[][] to Block Kit "actions" blocks and
 * RichCard[] to Block Kit "section" blocks for Slack's message API.
 *
 * Pure functions with no side effects -- fully testable without network.
 *
 * @module
 */

import type { RichButton, RichCard } from "@comis/core";

/**
 * Convert domain RichButton rows to Slack Block Kit actions blocks.
 *
 * Each row becomes one "actions" block containing button elements.
 * Slack only supports "primary" and "danger" styles; "secondary" = no style.
 *
 * @param buttons - Two-dimensional array of RichButton (rows x buttons)
 * @returns Array of Block Kit actions blocks
 */
export function renderSlackButtons(buttons: RichButton[][]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const row of buttons) {
    const elements: Record<string, unknown>[] = [];

    for (const btn of row) {
      const element: Record<string, unknown> = {
        type: "button",
        text: { type: "plain_text", text: btn.text },
        action_id: btn.callback_data ?? btn.text,
      };

      if (btn.url) {
        element.url = btn.url;
      }

      if (btn.style === "primary") {
        element.style = "primary";
      } else if (btn.style === "danger") {
        element.style = "danger";
      }

      elements.push(element);
    }

    blocks.push({ type: "actions", elements });
  }

  return blocks;
}

/**
 * Convert domain RichCard array to Slack Block Kit section blocks.
 *
 * Each card becomes one or more section blocks:
 * - Main section with title/description as mrkdwn text and optional image accessory
 * - Additional section with fields if the card has structured fields
 *
 * @param cards - Array of RichCard domain objects
 * @returns Flat array of Block Kit section blocks
 */
export function renderSlackCards(cards: RichCard[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const card of cards) {
    const textParts: string[] = [];
    if (card.title) textParts.push(`*${card.title}*`);
    if (card.description) textParts.push(card.description);
    const mrkdwnText = textParts.join("\n") || " ";

    const section: Record<string, unknown> = {
      type: "section",
      text: { type: "mrkdwn", text: mrkdwnText },
    };

    if (card.image_url) {
      section.accessory = {
        type: "image",
        image_url: card.image_url,
        alt_text: card.title ?? "image",
      };
    }

    blocks.push(section);

    // Add fields as separate section block
    if (card.fields && card.fields.length > 0) {
      blocks.push({
        type: "section",
        fields: card.fields.map((f) => ({
          type: "mrkdwn",
          text: `*${f.name}*\n${f.value}`,
        })),
      });
    }
  }

  return blocks;
}
