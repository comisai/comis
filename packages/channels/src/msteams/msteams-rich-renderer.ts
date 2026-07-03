// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams rich renderer: pure functions mapping domain rich types to
 * Adaptive Card v1.4 JSON.
 *
 * Converts `RichCard[]` + `RichButton[][]` into a single Adaptive Card
 * attachment for the Teams connector. Interactive buttons (`callback_data`)
 * become `Action.Execute` carrying the shared approval verb + the signed
 * callback; `url` buttons become `Action.OpenUrl`; the rest become
 * `Action.Submit`. `RichEffect` ("spoiler"/"silent") has no Adaptive Card
 * equivalent and is not an input here — it is dropped upstream.
 *
 * Pure functions, no side effects, no I/O — fully testable without network.
 * The card is a hand-built typed object (no Adaptive Cards SDK dependency).
 *
 * Adaptive Card enums are case-SENSITIVE: a lowercase value (e.g. "bolder")
 * silently renders unstyled in the host and the bug is invisible in CI. Every
 * enum this module emits is therefore a PascalCase literal, and any unmapped
 * style falls back to "Default" — never a lowercase passthrough.
 *
 * @module
 */

import type { RichButton, RichCard } from "@comis/core";
import { MSTEAMS_APPROVAL_VERB } from "./msteams-actions.js";

/** Adaptive Card TextBlock color enum (PascalCase — the host is case-sensitive). */
type AdaptiveTextColor = "Default" | "Good" | "Attention" | "Warning" | "Accent";

/**
 * Map a domain button style to a PascalCase Adaptive Card TextBlock color.
 *
 * `Action.Execute` carries no color in the 1.4 core schema, so a styled
 * button's emphasis rides on a companion TextBlock color. Closed lookup: any
 * style outside the mapped set (including "secondary"/"link" and `undefined`)
 * falls back to "Default" — a lowercase literal must never reach the wire.
 */
function styleToColor(style: RichButton["style"]): AdaptiveTextColor {
  switch (style) {
    case "primary":
      return "Good";
    case "danger":
      return "Attention";
    default:
      return "Default";
  }
}

/**
 * The glyph a styled button's companion TextBlock carries. `Action.Execute` has
 * no color in the AC 1.4 core schema, so a styled button's emphasis rides on a
 * companion colored TextBlock — but that companion carries only this marker, not
 * the button's label, so the label is never rendered twice (once in the body and
 * again as the action title).
 */
const EMPHASIS_MARKER = "●"; // ● BLACK CIRCLE

/**
 * Map one domain button to its Adaptive Card action by discriminant:
 *   - `callback_data` present → `Action.Execute` (interactive; stamps the shared
 *     verb the inbound normalizer validates, so the rendered and validated verb
 *     sets cannot drift, plus the opaque signed callback as `data.cb`)
 *   - `url` present → `Action.OpenUrl`
 *   - otherwise → `Action.Submit`
 */
function buttonToAction(btn: RichButton): Record<string, unknown> {
  if (btn.callback_data !== undefined) {
    return {
      type: "Action.Execute",
      title: btn.text,
      verb: MSTEAMS_APPROVAL_VERB,
      data: { cb: btn.callback_data },
    };
  }
  if (btn.url !== undefined) {
    return { type: "Action.OpenUrl", title: btn.text, url: btn.url };
  }
  return { type: "Action.Submit", title: btn.text };
}

/**
 * Build the Adaptive Card body elements for one card: a Bolder/Medium title
 * TextBlock, a plain description TextBlock, an Image, and a FactSet of fields —
 * each emitted only when the corresponding field is present. The domain
 * `color` integer accent has no Adaptive Card enum equivalent and is dropped.
 */
function cardToBody(card: RichCard): Record<string, unknown>[] {
  const body: Record<string, unknown>[] = [];

  if (card.title !== undefined) {
    body.push({
      type: "TextBlock",
      text: card.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    });
  }
  if (card.description !== undefined) {
    body.push({ type: "TextBlock", text: card.description, wrap: true });
  }
  if (card.image_url !== undefined) {
    body.push({ type: "Image", url: card.image_url });
  }
  if (card.fields !== undefined && card.fields.length > 0) {
    body.push({
      type: "FactSet",
      facts: card.fields.map((f) => ({ title: f.name, value: f.value })),
    });
  }

  return body;
}

/**
 * Render `RichCard[]` + `RichButton[][]` into one Adaptive Card v1.4 attachment.
 *
 * The button rows are flattened into `content.actions`. A styled button also
 * contributes a companion colored marker TextBlock (a glyph, not its label) to
 * `content.body`, since `Action.Execute` has no color in the 1.4 core schema.
 *
 * @param cards - Card bodies (title/description/image/fields)
 * @param buttons - Button rows; flattened into the card actions
 * @returns One Adaptive Card attachment object (hand-built typed JSON)
 */
export function renderMSTeamsCardAttachment(
  cards: RichCard[],
  buttons: RichButton[][],
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [];
  for (const card of cards) {
    body.push(...cardToBody(card));
  }

  const flat = buttons.flat();

  // A styled button's emphasis is carried by a companion colored TextBlock
  // because Action.Execute has no color in the 1.4 core schema. The companion
  // carries a colored marker glyph, NOT the button's label — echoing the label
  // would render it twice (here and again as the action title). The spacing enum
  // here is a PascalCase literal for the same case-sensitivity reason.
  for (const btn of flat) {
    if (btn.style !== undefined) {
      body.push({
        type: "TextBlock",
        text: EMPHASIS_MARKER,
        color: styleToColor(btn.style),
        spacing: "Small",
        wrap: true,
      });
    }
  }

  const actions = flat.map(buttonToAction);

  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body,
      actions,
    },
  };
}
