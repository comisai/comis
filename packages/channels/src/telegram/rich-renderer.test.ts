import { describe, expect, it } from "vitest";
import {
  renderTelegramButtons,
  renderTelegramCards,
} from "./rich-renderer.js";
import type { RichButton, RichCard } from "@comis/core";

// ---------------------------------------------------------------------------
// renderTelegramButtons
// ---------------------------------------------------------------------------

describe("renderTelegramButtons", () => {
  it("URL button: keyboard row has button with url property", () => {
    const buttons: RichButton[][] = [
      [{ text: "Open", url: "https://example.com" }],
    ];
    const keyboard = renderTelegramButtons(buttons);
    const rows = keyboard.inline_keyboard;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0][0]).toMatchObject({
      text: "Open",
      url: "https://example.com",
    });
  });

  it("callback button: keyboard row has button with callback_data", () => {
    const buttons: RichButton[][] = [
      [{ text: "Click", callback_data: "do_action" }],
    ];
    const keyboard = renderTelegramButtons(buttons);
    const rows = keyboard.inline_keyboard;

    expect(rows[0][0]).toMatchObject({
      text: "Click",
      callback_data: "do_action",
    });
  });

  it("callback data truncation: callback_data > 64 bytes truncated to 64 bytes", () => {
    // Use multi-byte UTF-8 chars: each emoji is 4 bytes, 17 emojis = 68 bytes
    const longData = "\u{1F600}".repeat(17); // 68 bytes
    const buttons: RichButton[][] = [
      [{ text: "Test", callback_data: longData }],
    ];
    const keyboard = renderTelegramButtons(buttons);
    const data = keyboard.inline_keyboard[0][0].callback_data as string;

    // Verify truncated to <= 64 bytes
    const encoder = new TextEncoder();
    expect(encoder.encode(data).length).toBeLessThanOrEqual(64);
    // Should have lost at least 1 emoji (4 bytes trimmed)
    expect(data.length).toBeLessThan(longData.length);
  });

  it("callback_data fallback: when callback_data undefined, uses btn.text", () => {
    const buttons: RichButton[][] = [[{ text: "fallback_label" }]];
    const keyboard = renderTelegramButtons(buttons);

    expect(keyboard.inline_keyboard[0][0].callback_data).toBe("fallback_label");
  });

  it("multiple rows with row breaks: each inner array is a separate row", () => {
    const buttons: RichButton[][] = [
      [{ text: "A", callback_data: "a" }],
      [
        { text: "B", callback_data: "b" },
        { text: "C", callback_data: "c" },
      ],
    ];
    const keyboard = renderTelegramButtons(buttons);
    const rows = keyboard.inline_keyboard;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(1);
    expect(rows[1]).toHaveLength(2);
  });

  it("single row: no trailing row break (all buttons in one row)", () => {
    const buttons: RichButton[][] = [
      [
        { text: "X", callback_data: "x" },
        { text: "Y", callback_data: "y" },
      ],
    ];
    const keyboard = renderTelegramButtons(buttons);
    const rows = keyboard.inline_keyboard;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
  });

  it("empty input: returns keyboard with no buttons", () => {
    const keyboard = renderTelegramButtons([]);
    // Grammy InlineKeyboard initializes with one empty row [[]]
    // No buttons are added, so the keyboard has a single empty row
    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderTelegramCards
// ---------------------------------------------------------------------------

describe("renderTelegramCards", () => {
  it("card with title: rendered as <b>Title</b>", () => {
    const cards: RichCard[] = [{ title: "Hello" }];
    const html = renderTelegramCards(cards);

    expect(html).toContain("<b>Hello</b>");
  });

  it("card with description: rendered as <i>Description</i>", () => {
    const cards: RichCard[] = [{ description: "Some info" }];
    const html = renderTelegramCards(cards);

    expect(html).toContain("<i>Some info</i>");
  });

  it("card with fields: rendered as <b>FieldName:</b> FieldValue", () => {
    const cards: RichCard[] = [
      { fields: [{ name: "Status", value: "Active" }] },
    ];
    const html = renderTelegramCards(cards);

    expect(html).toContain("<b>Status:</b> Active");
  });

  it("card with image_url: rendered as invisible link with zero-width space", () => {
    const cards: RichCard[] = [
      { image_url: "https://example.com/img.png" },
    ];
    const html = renderTelegramCards(cards);

    expect(html).toContain(
      '<a href="https://example.com/img.png">\u200B</a>',
    );
  });

  it("HTML escaping: title with <>&  chars properly escaped", () => {
    const cards: RichCard[] = [{ title: "A <b> & C > D" }];
    const html = renderTelegramCards(cards);

    expect(html).toContain("<b>A &lt;b&gt; &amp; C &gt; D</b>");
    // Verify raw chars are NOT present outside tags
    expect(html).not.toContain("<b>A <b>");
  });

  it("multiple cards: separated by double newline", () => {
    const cards: RichCard[] = [
      { title: "Card1" },
      { title: "Card2" },
    ];
    const html = renderTelegramCards(cards);

    expect(html).toBe("<b>Card1</b>\n\n<b>Card2</b>");
  });

  it("card with all fields: title + description + fields + image in correct order", () => {
    const cards: RichCard[] = [
      {
        title: "Report",
        description: "Monthly stats",
        fields: [{ name: "Revenue", value: "$1000" }],
        image_url: "https://example.com/chart.png",
      },
    ];
    const html = renderTelegramCards(cards);
    const lines = html.split("\n");

    // Order: title, description, fields, image
    expect(lines[0]).toBe("<b>Report</b>");
    expect(lines[1]).toBe("<i>Monthly stats</i>");
    expect(lines[2]).toBe("<b>Revenue:</b> $1000");
    expect(lines[3]).toBe('<a href="https://example.com/chart.png">\u200B</a>');
  });
});
