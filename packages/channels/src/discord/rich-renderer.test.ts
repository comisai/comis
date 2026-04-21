// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderDiscordButtons, renderDiscordCards } from "./rich-renderer.js";
import type { RichButton, RichCard } from "@comis/core";
import { ButtonStyle } from "discord.js";

// ---------------------------------------------------------------------------
// renderDiscordButtons
// ---------------------------------------------------------------------------

describe("renderDiscordButtons", () => {
  it("single URL button creates ActionRow with Link style and URL set", () => {
    const buttons: RichButton[][] = [
      [{ text: "Visit", url: "https://example.com" }],
    ];
    const rows = renderDiscordButtons(buttons);
    expect(rows).toHaveLength(1);

    const json = rows[0].toJSON();
    expect(json.components).toHaveLength(1);
    expect(json.components[0].style).toBe(ButtonStyle.Link);
    expect(json.components[0].url).toBe("https://example.com");
    expect(json.components[0].label).toBe("Visit");
  });

  it("single callback button creates ButtonBuilder with Primary style and customId", () => {
    const buttons: RichButton[][] = [
      [{ text: "Click", callback_data: "action_click" }],
    ];
    const rows = renderDiscordButtons(buttons);
    const json = rows[0].toJSON();

    expect(json.components[0].style).toBe(ButtonStyle.Primary);
    expect(json.components[0].custom_id).toBe("action_click");
  });

  it("button with style secondary uses ButtonStyle.Secondary", () => {
    const buttons: RichButton[][] = [
      [{ text: "Sec", style: "secondary", callback_data: "s" }],
    ];
    const rows = renderDiscordButtons(buttons);
    const json = rows[0].toJSON();

    expect(json.components[0].style).toBe(ButtonStyle.Secondary);
  });

  it("button with style danger uses ButtonStyle.Danger", () => {
    const buttons: RichButton[][] = [
      [{ text: "Del", style: "danger", callback_data: "d" }],
    ];
    const rows = renderDiscordButtons(buttons);
    const json = rows[0].toJSON();

    expect(json.components[0].style).toBe(ButtonStyle.Danger);
  });

  it("button with no style and no URL defaults to ButtonStyle.Primary", () => {
    const buttons: RichButton[][] = [
      [{ text: "Default", callback_data: "def" }],
    ];
    const rows = renderDiscordButtons(buttons);
    const json = rows[0].toJSON();

    expect(json.components[0].style).toBe(ButtonStyle.Primary);
  });

  it("callback_data fallback: when callback_data is undefined, customId uses btn.text", () => {
    const buttons: RichButton[][] = [[{ text: "fallback_text" }]];
    const rows = renderDiscordButtons(buttons);
    const json = rows[0].toJSON();

    expect(json.components[0].custom_id).toBe("fallback_text");
  });

  it("row clamping: 7 buttons per row -> only 5 kept (MAX_BUTTONS_PER_ROW)", () => {
    const sevenButtons: RichButton[] = Array.from({ length: 7 }, (_, i) => ({
      text: `btn${i}`,
      callback_data: `cb${i}`,
    }));
    const rows = renderDiscordButtons([sevenButtons]);

    const json = rows[0].toJSON();
    expect(json.components).toHaveLength(5);
  });

  it("max rows: 6 rows input -> only 5 rows output (MAX_ROWS)", () => {
    const sixRows: RichButton[][] = Array.from({ length: 6 }, (_, i) => [
      { text: `row${i}`, callback_data: `r${i}` },
    ]);
    const rows = renderDiscordButtons(sixRows);

    expect(rows).toHaveLength(5);
  });

  it("empty buttons array returns empty array", () => {
    const rows = renderDiscordButtons([]);
    expect(rows).toHaveLength(0);
  });

  it("multiple rows: each inner array becomes a separate ActionRowBuilder", () => {
    const buttons: RichButton[][] = [
      [{ text: "a", callback_data: "a" }],
      [
        { text: "b", callback_data: "b" },
        { text: "c", callback_data: "c" },
      ],
    ];
    const rows = renderDiscordButtons(buttons);

    expect(rows).toHaveLength(2);
    expect(rows[0].toJSON().components).toHaveLength(1);
    expect(rows[1].toJSON().components).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// renderDiscordCards
// ---------------------------------------------------------------------------

describe("renderDiscordCards", () => {
  it("card with title only: embed has title set", () => {
    const cards: RichCard[] = [{ title: "Hello" }];
    const embeds = renderDiscordCards(cards);

    expect(embeds).toHaveLength(1);
    expect(embeds[0].toJSON().title).toBe("Hello");
  });

  it("card with description: embed has description set", () => {
    const cards: RichCard[] = [{ description: "Some description" }];
    const embeds = renderDiscordCards(cards);

    expect(embeds[0].toJSON().description).toBe("Some description");
  });

  it("card with image_url: embed has image set", () => {
    const cards: RichCard[] = [{ image_url: "https://example.com/img.png" }];
    const embeds = renderDiscordCards(cards);

    expect(embeds[0].toJSON().image).toEqual({
      url: "https://example.com/img.png",
    });
  });

  it("card with color: embed has color set", () => {
    const cards: RichCard[] = [{ color: 0x0099ff }];
    const embeds = renderDiscordCards(cards);

    expect(embeds[0].toJSON().color).toBe(0x0099ff);
  });

  it("card with fields: embed has fields with name, value, inline", () => {
    const cards: RichCard[] = [
      {
        fields: [
          { name: "Key", value: "Val", inline: true },
          { name: "Key2", value: "Val2" },
        ],
      },
    ];
    const embeds = renderDiscordCards(cards);
    const json = embeds[0].toJSON();

    expect(json.fields).toHaveLength(2);
    expect(json.fields![0]).toEqual({ name: "Key", value: "Val", inline: true });
    expect(json.fields![1]).toEqual({
      name: "Key2",
      value: "Val2",
      inline: false,
    });
  });

  it("field inline defaults to false when not specified", () => {
    const cards: RichCard[] = [
      { fields: [{ name: "F", value: "V" }] },
    ];
    const embeds = renderDiscordCards(cards);
    const json = embeds[0].toJSON();

    expect(json.fields![0].inline).toBe(false);
  });

  it("field clamping: card with 30 fields -> only 25 fields (MAX_FIELDS_PER_EMBED)", () => {
    const fields = Array.from({ length: 30 }, (_, i) => ({
      name: `f${i}`,
      value: `v${i}`,
    }));
    const cards: RichCard[] = [{ fields }];
    const embeds = renderDiscordCards(cards);

    expect(embeds[0].toJSON().fields).toHaveLength(25);
  });

  it("multiple cards: returns array of EmbedBuilder, one per card", () => {
    const cards: RichCard[] = [
      { title: "Card 1" },
      { title: "Card 2" },
      { title: "Card 3" },
    ];
    const embeds = renderDiscordCards(cards);

    expect(embeds).toHaveLength(3);
    expect(embeds[0].toJSON().title).toBe("Card 1");
    expect(embeds[1].toJSON().title).toBe("Card 2");
    expect(embeds[2].toJSON().title).toBe("Card 3");
  });

  it("card with no optional fields: returns valid embed (no crash)", () => {
    const cards: RichCard[] = [{}];
    const embeds = renderDiscordCards(cards);

    expect(embeds).toHaveLength(1);
    const json = embeds[0].toJSON();
    // Should have at least the type field, but no title/description/etc
    expect(json.title).toBeUndefined();
    expect(json.description).toBeUndefined();
    expect(json.image).toBeUndefined();
    expect(json.color).toBeUndefined();
    expect(json.fields).toBeUndefined();
  });
});
