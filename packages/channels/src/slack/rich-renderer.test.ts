// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderSlackButtons, renderSlackCards } from "./rich-renderer.js";
import type { RichButton, RichCard } from "@comis/core";

// ---------------------------------------------------------------------------
// renderSlackButtons
// ---------------------------------------------------------------------------

describe("renderSlackButtons", () => {
  it("single button: returns actions block with button element", () => {
    const buttons: RichButton[][] = [
      [{ text: "Click", callback_data: "action_1" }],
    ];
    const blocks = renderSlackButtons(buttons);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Click" },
          action_id: "action_1",
        },
      ],
    });
  });

  it("button with URL: element has url field", () => {
    const buttons: RichButton[][] = [
      [{ text: "Open", url: "https://example.com", callback_data: "open" }],
    ];
    const blocks = renderSlackButtons(buttons);
    const element = (blocks[0] as Record<string, unknown[]>).elements[0] as Record<string, unknown>;

    expect(element.url).toBe("https://example.com");
  });

  it("button with style primary: element has style primary", () => {
    const buttons: RichButton[][] = [
      [{ text: "Go", style: "primary", callback_data: "go" }],
    ];
    const blocks = renderSlackButtons(buttons);
    const element = (blocks[0] as Record<string, unknown[]>).elements[0] as Record<string, unknown>;

    expect(element.style).toBe("primary");
  });

  it("button with style danger: element has style danger", () => {
    const buttons: RichButton[][] = [
      [{ text: "Delete", style: "danger", callback_data: "del" }],
    ];
    const blocks = renderSlackButtons(buttons);
    const element = (blocks[0] as Record<string, unknown[]>).elements[0] as Record<string, unknown>;

    expect(element.style).toBe("danger");
  });

  it("button with style secondary: no style field (Slack only supports primary/danger)", () => {
    const buttons: RichButton[][] = [
      [{ text: "Sec", style: "secondary", callback_data: "sec" }],
    ];
    const blocks = renderSlackButtons(buttons);
    const element = (blocks[0] as Record<string, unknown[]>).elements[0] as Record<string, unknown>;

    expect(element.style).toBeUndefined();
  });

  it("button with no style: no style field on element", () => {
    const buttons: RichButton[][] = [
      [{ text: "Plain", callback_data: "plain" }],
    ];
    const blocks = renderSlackButtons(buttons);
    const element = (blocks[0] as Record<string, unknown[]>).elements[0] as Record<string, unknown>;

    expect(element.style).toBeUndefined();
  });

  it("callback_data fallback: action_id defaults to btn.text when callback_data is undefined", () => {
    const buttons: RichButton[][] = [[{ text: "fallback_label" }]];
    const blocks = renderSlackButtons(buttons);
    const element = (blocks[0] as Record<string, unknown[]>).elements[0] as Record<string, unknown>;

    expect(element.action_id).toBe("fallback_label");
  });

  it("multiple rows: each row becomes a separate actions block", () => {
    const buttons: RichButton[][] = [
      [{ text: "A", callback_data: "a" }],
      [
        { text: "B", callback_data: "b" },
        { text: "C", callback_data: "c" },
      ],
    ];
    const blocks = renderSlackButtons(buttons);

    expect(blocks).toHaveLength(2);
    expect((blocks[0] as Record<string, unknown[]>).elements).toHaveLength(1);
    expect((blocks[1] as Record<string, unknown[]>).elements).toHaveLength(2);
  });

  it("empty row: creates actions block with empty elements array", () => {
    const buttons: RichButton[][] = [[]];
    const blocks = renderSlackButtons(buttons);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "actions", elements: [] });
  });
});

// ---------------------------------------------------------------------------
// renderSlackCards
// ---------------------------------------------------------------------------

describe("renderSlackCards", () => {
  it("card with title only: section block with mrkdwn text *Title*", () => {
    const cards: RichCard[] = [{ title: "Status" }];
    const blocks = renderSlackCards(cards);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Status*" },
    });
  });

  it("card with description: section text includes description", () => {
    const cards: RichCard[] = [{ description: "Some info" }];
    const blocks = renderSlackCards(cards);

    expect((blocks[0] as Record<string, Record<string, string>>).text.text).toBe("Some info");
  });

  it("card with title + description: text is *Title*\\nDescription", () => {
    const cards: RichCard[] = [{ title: "Report", description: "Monthly" }];
    const blocks = renderSlackCards(cards);

    expect((blocks[0] as Record<string, Record<string, string>>).text.text).toBe(
      "*Report*\nMonthly",
    );
  });

  it("card with no title or description: mrkdwn text is space fallback", () => {
    const cards: RichCard[] = [{}];
    const blocks = renderSlackCards(cards);

    expect((blocks[0] as Record<string, Record<string, string>>).text.text).toBe(" ");
  });

  it("card with image_url: section has accessory with type image", () => {
    const cards: RichCard[] = [
      { title: "Photo", image_url: "https://example.com/img.png" },
    ];
    const blocks = renderSlackCards(cards);

    expect(blocks[0]).toMatchObject({
      accessory: {
        type: "image",
        image_url: "https://example.com/img.png",
        alt_text: "Photo",
      },
    });
  });

  it("card with image_url but no title: alt_text falls back to 'image'", () => {
    const cards: RichCard[] = [
      { image_url: "https://example.com/pic.png" },
    ];
    const blocks = renderSlackCards(cards);

    expect((blocks[0] as Record<string, Record<string, string>>).accessory.alt_text).toBe("image");
  });

  it("card with fields: separate section block with fields array", () => {
    const cards: RichCard[] = [
      {
        title: "Info",
        fields: [
          { name: "Status", value: "Active" },
          { name: "Priority", value: "High" },
        ],
      },
    ];
    const blocks = renderSlackCards(cards);

    // First block is the main section, second is fields section
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Status*\nActive" },
        { type: "mrkdwn", text: "*Priority*\nHigh" },
      ],
    });
  });

  it("multiple cards: first card main section + fields section + second card section", () => {
    const cards: RichCard[] = [
      {
        title: "Card1",
        fields: [{ name: "F1", value: "V1" }],
      },
      { title: "Card2" },
    ];
    const blocks = renderSlackCards(cards);

    // Card1 main section + Card1 fields section + Card2 main section
    expect(blocks).toHaveLength(3);
    expect((blocks[0] as Record<string, Record<string, string>>).text.text).toBe("*Card1*");
    expect(blocks[1]).toMatchObject({ type: "section", fields: expect.any(Array) });
    expect((blocks[2] as Record<string, Record<string, string>>).text.text).toBe("*Card2*");
  });

  it("card with no fields, no image: just the main section block", () => {
    const cards: RichCard[] = [{ title: "Simple" }];
    const blocks = renderSlackCards(cards);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Simple*" },
    });
    // No accessory, no fields block
    expect((blocks[0] as Record<string, unknown>).accessory).toBeUndefined();
  });
});
