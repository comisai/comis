// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderGoogleChatButtons, renderGoogleChatCards } from "./googlechat-rich-renderer.js";
import { GOOGLECHAT_APPROVAL_FUNCTION } from "./googlechat-actions.js";
import type { RichButton, RichCard } from "@comis/core";

// A representative signed callback wire (v1.<choice>.<shortId>.<hmac>) — neutral literal.
const SIGNED_CB = "v1.approve.Abc123Def456.QWERTYuiop123456";

/** The widgets of the first section of a single cardsV2 entry. */
function widgetsOf(entry: Record<string, unknown>): Record<string, unknown>[] {
  const card = entry.card as Record<string, unknown>;
  const sections = card.sections as Record<string, unknown>[];
  return sections[0]!.widgets as Record<string, unknown>[];
}

/** The buttons of a buttonList widget. */
function buttonsOf(widget: Record<string, unknown>): Record<string, unknown>[] {
  const list = widget.buttonList as Record<string, unknown>;
  return list.buttons as Record<string, unknown>[];
}

// Type-level guard: the renderer accepts ONLY cards / button rows. RichEffect is
// not an input to either export — a spoiler/silent effect can never be emitted
// because it can never be passed in.
const _cardsSig: (cards: RichCard[]) => Record<string, unknown>[] = renderGoogleChatCards;
const _buttonsSig: (buttons: RichButton[][]) => Record<string, unknown> = renderGoogleChatButtons;
void _cardsSig;
void _buttonsSig;

describe("renderGoogleChatCards cardsV2 envelope", () => {
  it("wraps each card in a cardsV2 entry with a non-empty cardId and one section of widgets", () => {
    const cardsV2 = renderGoogleChatCards([{ title: "T" }]);

    expect(cardsV2).toHaveLength(1);
    expect(typeof cardsV2[0]!.cardId).toBe("string");
    expect((cardsV2[0]!.cardId as string).length).toBeGreaterThan(0);
    const card = cardsV2[0]!.card as Record<string, unknown>;
    const sections = card.sections as Record<string, unknown>[];
    expect(Array.isArray(sections)).toBe(true);
    expect(Array.isArray(sections[0]!.widgets)).toBe(true);
  });

  it("gives each card its own cardsV2 entry with a distinct cardId", () => {
    const cardsV2 = renderGoogleChatCards([{ title: "A" }, { title: "B" }]);

    expect(cardsV2).toHaveLength(2);
    expect(cardsV2[0]!.cardId).not.toBe(cardsV2[1]!.cardId);
  });
});

describe("renderGoogleChatCards widgets per field", () => {
  it("renders the title as a bolded textParagraph (HTML subset)", () => {
    const widgets = widgetsOf(renderGoogleChatCards([{ title: "Approval required" }])[0]!);

    expect(widgets).toContainEqual({ textParagraph: { text: "<b>Approval required</b>" } });
  });

  it("renders the description as a plain textParagraph", () => {
    const widgets = widgetsOf(renderGoogleChatCards([{ description: "Do the thing" }])[0]!);

    expect(widgets).toContainEqual({ textParagraph: { text: "Do the thing" } });
  });

  it("renders image_url as an image widget with imageUrl and altText", () => {
    const cards: RichCard[] = [{ title: "Pic", image_url: "https://example.com/y.png" }];
    const widgets = widgetsOf(renderGoogleChatCards(cards)[0]!);

    expect(widgets).toContainEqual({
      image: { imageUrl: "https://example.com/y.png", altText: "Pic" },
    });
  });

  it("falls back the image altText to a neutral label when the card has no title", () => {
    const widgets = widgetsOf(
      renderGoogleChatCards([{ image_url: "https://example.com/y.png" }])[0]!,
    );
    const image = widgets.find((w) => "image" in w)!.image as Record<string, unknown>;

    expect(image.altText).toBe("image");
  });

  it("degrades card fields to a single textParagraph (no FactSet in the minimal set)", () => {
    const cards: RichCard[] = [
      {
        fields: [
          { name: "Tool", value: "bash" },
          { name: "Risk", value: "high" },
        ],
      },
    ];
    const widgets = widgetsOf(renderGoogleChatCards(cards)[0]!);
    const paragraph = widgets.find((w) => "textParagraph" in w)!.textParagraph as {
      text: string;
    };

    expect(paragraph.text).toBe("<b>Tool</b>: bash<br><b>Risk</b>: high");
  });
});

describe("renderGoogleChatCards card-text escaping (HTML-subset injection guard)", () => {
  it("escapes &, <, > in the title before wrapping it in the bold tag", () => {
    const widgets = widgetsOf(renderGoogleChatCards([{ title: "a<b>&c" }])[0]!);

    expect(widgets).toContainEqual({ textParagraph: { text: "<b>a&lt;b&gt;&amp;c</b>" } });
  });

  it("escapes &, <, > in the description so agent text cannot inject card markup", () => {
    const widgets = widgetsOf(
      renderGoogleChatCards([{ description: "<i>x</i> & <script>y</script>" }])[0]!,
    );

    expect(widgets).toContainEqual({
      textParagraph: { text: "&lt;i&gt;x&lt;/i&gt; &amp; &lt;script&gt;y&lt;/script&gt;" },
    });
  });

  it("escapes field names and values against the HTML subset", () => {
    const cards: RichCard[] = [{ fields: [{ name: "K<x>", value: "v&w" }] }];
    const paragraph = (
      widgetsOf(renderGoogleChatCards(cards)[0]!).find((w) => "textParagraph" in w)!
        .textParagraph as { text: string }
    ).text;

    expect(paragraph).toBe("<b>K&lt;x&gt;</b>: v&amp;w");
  });
});

describe("renderGoogleChatButtons buttonList widget", () => {
  it("returns a single buttonList widget wrapping the button rows", () => {
    const widget = renderGoogleChatButtons([[{ text: "A" }]]);

    expect(Object.keys(widget)).toEqual(["buttonList"]);
    expect(buttonsOf(widget)).toHaveLength(1);
  });

  it("maps an interactive callback_data button to onClick.action stamping the shared function + cb param", () => {
    const buttons: RichButton[][] = [[{ text: "Approve", callback_data: SIGNED_CB }]];
    const btn = buttonsOf(renderGoogleChatButtons(buttons))[0]!;

    expect(btn).toEqual({
      text: "Approve",
      onClick: {
        action: {
          function: GOOGLECHAT_APPROVAL_FUNCTION,
          parameters: [{ key: "cb", value: SIGNED_CB }],
        },
      },
    });
  });

  it("stamps the function that equals the normalizer's shared approval function (no drift)", () => {
    const buttons: RichButton[][] = [
      [{ text: "Deny", callback_data: "v1.deny.Abc123Def456.ZXCVbnmasdfghjkl0" }],
    ];
    const btn = buttonsOf(renderGoogleChatButtons(buttons))[0]!;
    const action = (btn.onClick as Record<string, unknown>).action as Record<string, unknown>;

    expect(action.function).toBe(GOOGLECHAT_APPROVAL_FUNCTION);
  });

  it("maps a url button to onClick.openLink carrying the destination url", () => {
    const buttons: RichButton[][] = [[{ text: "Docs", url: "https://example.com" }]];
    const btn = buttonsOf(renderGoogleChatButtons(buttons))[0]!;

    expect(btn).toEqual({
      text: "Docs",
      onClick: { openLink: { url: "https://example.com" } },
    });
  });

  it("maps a static button (no callback_data, no url) to a plain button with no onClick", () => {
    const btn = buttonsOf(renderGoogleChatButtons([[{ text: "Refresh" }]]))[0]!;

    expect(btn).toEqual({ text: "Refresh" });
    expect(btn.onClick).toBeUndefined();
  });

  it("prefers the interactive action form when a button carries BOTH callback_data and url", () => {
    const buttons: RichButton[][] = [
      [{ text: "Both", callback_data: SIGNED_CB, url: "https://example.com" }],
    ];
    const btn = buttonsOf(renderGoogleChatButtons(buttons))[0]!;
    const onClick = btn.onClick as Record<string, unknown>;

    expect("action" in onClick).toBe(true);
    expect("openLink" in onClick).toBe(false);
  });

  it("flattens multiple button rows into one buttonList in order", () => {
    const buttons: RichButton[][] = [
      [{ text: "A", callback_data: "cb-a" }],
      [
        { text: "B", url: "https://example.com/b" },
        { text: "C" },
      ],
    ];
    const btns = buttonsOf(renderGoogleChatButtons(buttons));

    expect(btns).toHaveLength(3);
    expect(btns.map((b) => b.text)).toEqual(["A", "B", "C"]);
  });

  it("escapes &, <, > in a plain button label against the HTML subset (parity with card text widgets)", () => {
    const btn = buttonsOf(renderGoogleChatButtons([[{ text: "Fish & <Chips>" }]]))[0]!;
    expect(btn.text).toBe("Fish &amp; &lt;Chips&gt;");
  });

  it("escapes an interactive button label while leaving the opaque signed cb param byte-exact", () => {
    const buttons: RichButton[][] = [
      [{ text: "<b>Yes</b> & go", callback_data: SIGNED_CB }],
    ];
    const btn = buttonsOf(renderGoogleChatButtons(buttons))[0]!;
    expect(btn.text).toBe("&lt;b&gt;Yes&lt;/b&gt; &amp; go");
    const action = (btn.onClick as Record<string, unknown>).action as {
      parameters: Array<{ key: string; value: string }>;
    };
    // The signed callback wire is opaque — escaping it would break the HMAC.
    expect(action.parameters[0]!.value).toBe(SIGNED_CB);
  });
});

describe("renderGoogleChatCards nested card buttons", () => {
  it("folds a card's own button rows into its section as a buttonList (never silently dropped)", () => {
    const cards: RichCard[] = [
      {
        title: "Choose",
        buttons: [[{ text: "Yes", callback_data: SIGNED_CB }, { text: "No" }]],
      },
    ];
    const widgets = widgetsOf(renderGoogleChatCards(cards)[0]!);
    const buttonList = widgets.find((w) => "buttonList" in w);

    expect(buttonList).toBeDefined();
    const btns = buttonsOf(buttonList!);
    expect(btns.map((b) => b.text)).toEqual(["Yes", "No"]);
    const yesAction = (btns[0]!.onClick as Record<string, unknown>).action as Record<
      string,
      unknown
    >;
    expect(yesAction.function).toBe(GOOGLECHAT_APPROVAL_FUNCTION);
    expect(btns[1]!.onClick).toBeUndefined();
  });

  it("omits the buttonList widget entirely for a card with no buttons", () => {
    const widgets = widgetsOf(renderGoogleChatCards([{ title: "T" }])[0]!);

    expect(widgets.some((w) => "buttonList" in w)).toBe(false);
  });
});

describe("renderGoogleChat effect + unsupported degradation", () => {
  it("never emits a spoiler or silent effect field in the rendered output", () => {
    const cardsSerialized = JSON.stringify(renderGoogleChatCards([{ title: "T", description: "D" }]));
    const buttonsSerialized = JSON.stringify(
      renderGoogleChatButtons([[{ text: "Go", callback_data: SIGNED_CB }]]),
    );

    expect(cardsSerialized).not.toContain("spoiler");
    expect(cardsSerialized).not.toContain("silent");
    expect(buttonsSerialized).not.toContain("spoiler");
    expect(buttonsSerialized).not.toContain("silent");
  });

  it("sends the outbound action field (function), never the inbound receive field name", () => {
    const serialized = JSON.stringify(
      renderGoogleChatButtons([[{ text: "Approve", callback_data: SIGNED_CB }]]),
    );

    expect(serialized).toContain("function");
    expect(serialized).not.toContain("actionMethodName");
  });

  it("drops the card color accent (no cardsV2 widget equivalent) rather than emitting it", () => {
    const serialized = JSON.stringify(renderGoogleChatCards([{ title: "T", color: 0x0099ff }]));

    expect(serialized).not.toContain('"color"');
  });
});
