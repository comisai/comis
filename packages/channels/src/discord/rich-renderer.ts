/**
 * Discord Rich Renderer: Pure functions converting domain types to discord.js builders.
 *
 * Converts RichButton[][] to ActionRowBuilder<ButtonBuilder>[] and
 * RichCard[] to EmbedBuilder[] for use in Discord message payloads.
 *
 * Pure functions with no side effects -- fully testable without network.
 *
 * @module
 */

import type { RichButton, RichCard } from "@comis/core";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

/** Discord limits: max 5 buttons per row, max 5 rows per message. */
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
/** Discord limits: max 25 fields per embed. */
const MAX_FIELDS_PER_EMBED = 25;

/**
 * Map a RichButton style string to a discord.js ButtonStyle enum value.
 */
function mapButtonStyle(style: string | undefined, hasUrl: boolean): ButtonStyle {
  if (hasUrl) return ButtonStyle.Link;
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "secondary":
      return ButtonStyle.Secondary;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Primary;
  }
}

/**
 * Convert domain RichButton rows to Discord ActionRowBuilder arrays.
 *
 * Each inner array becomes one ActionRowBuilder. Buttons per row are clamped
 * to 5, and total rows are clamped to 5 (Discord API limits).
 *
 * @param buttons - Two-dimensional array of RichButton (rows x buttons)
 * @returns Array of ActionRowBuilder<ButtonBuilder> ready for Discord payload
 */
export function renderDiscordButtons(
  buttons: RichButton[][],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (const row of buttons) {
    if (rows.length >= MAX_ROWS) break;

    const actionRow = new ActionRowBuilder<ButtonBuilder>();
    const clamped = row.slice(0, MAX_BUTTONS_PER_ROW);

    for (const btn of clamped) {
      const builder = new ButtonBuilder()
        .setLabel(btn.text)
        .setStyle(mapButtonStyle(btn.style, !!btn.url));

      if (btn.url) {
        builder.setURL(btn.url);
      } else {
        builder.setCustomId(btn.callback_data ?? btn.text);
      }

      actionRow.addComponents(builder);
    }

    rows.push(actionRow);
  }

  return rows;
}

/**
 * Convert domain RichCard array to Discord EmbedBuilder array.
 *
 * Each card becomes one EmbedBuilder. Fields per embed are clamped to 25
 * (Discord API limit).
 *
 * @param cards - Array of RichCard domain objects
 * @returns Array of EmbedBuilder ready for Discord payload
 */
export function renderDiscordCards(cards: RichCard[]): EmbedBuilder[] {
  return cards.map((card) => {
    const embed = new EmbedBuilder();

    if (card.title) embed.setTitle(card.title);
    if (card.description) embed.setDescription(card.description);
    if (card.image_url) embed.setImage(card.image_url);
    if (card.color !== undefined) embed.setColor(card.color);

    if (card.fields && card.fields.length > 0) {
      const clamped = card.fields.slice(0, MAX_FIELDS_PER_EMBED);
      embed.addFields(
        clamped.map((f) => ({
          name: f.name,
          value: f.value,
          inline: f.inline ?? false,
        })),
      );
    }

    return embed;
  });
}
