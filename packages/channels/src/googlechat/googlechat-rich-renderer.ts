// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat rich renderer: pure functions mapping domain rich types to
 * Cards v2 widget JSON.
 *
 * Converts `RichCard[]` into `cardsV2` entries (one card per entry, a single
 * section of widgets) and `RichButton[][]` into a `buttonList` widget.
 * Interactive buttons (`callback_data`) stamp the shared approval function on
 * `onClick.action.function` — the SAME constant the inbound normalizer
 * validates, so the rendered function set and the validated set cannot drift —
 * and ride the opaque signed callback as an `onClick.action.parameters` entry.
 * `url` buttons become `onClick.openLink`; a button with neither is a plain
 * button.
 *
 * `RichEffect` ("spoiler"/"silent") has no Cards v2 equivalent and is not an
 * input here — it is dropped upstream. Fields with no widget equivalent (the
 * key/value list, the color accent) degrade to a text paragraph or are omitted.
 *
 * Card text is emitted in the Cards v2 basic-HTML subset (`<b>`, `<br>`), so
 * agent-supplied text is escaped against that subset before it is placed inside
 * a tag — user text can never inject card markup. Message-body text is a
 * separate surface handled by the message-text formatter, not this module.
 *
 * Pure functions, no side effects, no I/O — fully testable without network. The
 * outbound action field is `onClick.action.function`; the distinct inbound
 * receive field is the normalizer's concern — the two directions are never
 * conflated here.
 *
 * @module
 */

import type { RichButton, RichCard } from "@comis/core";
import { randomUUID } from "node:crypto";
import { GOOGLECHAT_APPROVAL_FUNCTION } from "./googlechat-actions.js";

/**
 * Escape agent text against the Cards v2 basic-HTML subset so it cannot inject
 * tags when placed inside a `textParagraph`. `&` is escaped first so an already
 * escaped entity is never doubled.
 */
function escapeCardText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the widgets for one card: a bolded title paragraph, a plain description
 * paragraph, an image, and a single paragraph folding the key/value fields —
 * each emitted only when its field is present. The domain `color` integer accent
 * has no widget equivalent and is dropped.
 */
function cardToWidgets(card: RichCard): Record<string, unknown>[] {
  const widgets: Record<string, unknown>[] = [];

  if (card.title !== undefined) {
    widgets.push({ textParagraph: { text: `<b>${escapeCardText(card.title)}</b>` } });
  }
  if (card.description !== undefined) {
    widgets.push({ textParagraph: { text: escapeCardText(card.description) } });
  }
  if (card.image_url !== undefined) {
    widgets.push({ image: { imageUrl: card.image_url, altText: card.title ?? "image" } });
  }
  if (card.fields !== undefined && card.fields.length > 0) {
    const text = card.fields
      .map((f) => `<b>${escapeCardText(f.name)}</b>: ${escapeCardText(f.value)}`)
      .join("<br>");
    widgets.push({ textParagraph: { text } });
  }

  return widgets;
}

/**
 * Map one domain button to its Cards v2 button by discriminant:
 *   - `callback_data` present → an interactive `onClick.action` stamping the
 *     shared approval function (so the rendered and validated function sets
 *     cannot drift) plus the opaque signed callback as a `cb` parameter;
 *   - `url` present → an `onClick.openLink`;
 *   - neither → a plain button with no `onClick`.
 *
 * An interactive button wins over a link when a button carries both, mirroring
 * the interactive-first precedence of the other card-based channels.
 */
function buttonToWidget(btn: RichButton): Record<string, unknown> {
  // The button label renders in the same Cards v2 HTML subset as textParagraph
  // content, so agent-supplied label text is escaped for parity with the card
  // widgets — a `<b>`/`<font>` in a label can never inject card markup. The
  // opaque signed `cb` callback and the `url` are NOT escaped (the callback is
  // an HMAC-bearing wire string; the url is a plain openLink target).
  const label = escapeCardText(btn.text);
  if (btn.callback_data !== undefined) {
    return {
      text: label,
      onClick: {
        action: {
          function: GOOGLECHAT_APPROVAL_FUNCTION,
          parameters: [{ key: "cb", value: btn.callback_data }],
        },
      },
    };
  }
  if (btn.url !== undefined) {
    return { text: label, onClick: { openLink: { url: btn.url } } };
  }
  return { text: label };
}

/** Wrap flattened button rows in one `buttonList` widget. */
function buttonListWidget(rows: RichButton[][]): Record<string, unknown> {
  return { buttonList: { buttons: rows.flat().map(buttonToWidget) } };
}

/**
 * Render `RichCard[]` into the `cardsV2` array for a Chat message body.
 *
 * Each card becomes one `cardsV2` entry with a unique `cardId` and a single
 * section of widgets. A card's own `buttons` rows fold into that section as a
 * trailing `buttonList` widget so they are never silently dropped.
 *
 * @param cards - Card bodies (title/description/image/fields/buttons)
 * @returns The `cardsV2` array (each entry `{ cardId, card: { sections } }`)
 */
export function renderGoogleChatCards(cards: RichCard[]): Record<string, unknown>[] {
  return cards.map((card) => {
    const widgets = cardToWidgets(card);
    if (card.buttons !== undefined && card.buttons.length > 0) {
      widgets.push(buttonListWidget(card.buttons));
    }
    return { cardId: randomUUID(), card: { sections: [{ widgets }] } };
  });
}

/**
 * Render top-level `RichButton[][]` into one `buttonList` widget.
 *
 * The rows are flattened into a single list; the adapter places the widget in
 * the outbound card body. Interactive buttons stamp the shared approval function
 * and ride their opaque callback as a parameter (see {@link renderGoogleChatCards}).
 *
 * @param buttons - Button rows
 * @returns One `buttonList` widget object
 */
export function renderGoogleChatButtons(buttons: RichButton[][]): Record<string, unknown> {
  return buttonListWidget(buttons);
}
