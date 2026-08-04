// SPDX-License-Identifier: Apache-2.0
/**
 * Locale projection for activity cards.
 *
 * `ActivityEvent.defaultLabel` is, by its own schema contract, the **English** advisory label:
 * plain-text surfaces may print it as-is, and themable renderers are told to "ignore it and
 * project from the canonical fields". It is composed in `@comis/observability`, which has no
 * locale knowledge and should not acquire any — so a card had no path to an operator's
 * `localePacks` no matter what `language` was configured, and the approval prompt a user has to
 * act on rendered in English inside an otherwise non-English conversation.
 *
 * This module IS that projection, done where a locale is actually knowable. It composes the
 * label from the event's canonical fields (`toolName`, `action`, redacted `params`) against the
 * same catalog every other runtime notice uses. It ships no language: with no operator pack the
 * output is byte-identical to the English label it replaces.
 *
 * Values inside a card — server names, credential keys, commands, the operation itself — are
 * identifiers and are always emitted verbatim. Only the surrounding words are translatable, so a
 * pack can never rename the tool call a user is authorizing.
 *
 * @module
 */

import type { ActivityEvent } from "@comis/core";
import type { LocaleCatalog, LocaleMessageId } from "./degraded-reply-i18n.js";

/** Hard cap mirroring `ActivityEventSchema.defaultLabel` (max 120) — renderers must not extend. */
const CARD_LABEL_MAX = 120;

/**
 * Redacted param keys that carry a card detail, paired with the catalog id naming them.
 *
 * Kept in the same order the English composition used, so an operator who supplies no pack sees
 * an unchanged card. `credential_keys` is the array case and is handled separately.
 */
const DETAIL_FIELDS: readonly (readonly [string, LocaleMessageId])[] = [
  ["server_name", "activity_card_detail_server"],
  ["env_key", "activity_card_detail_credential"],
  ["command", "activity_card_detail_command"],
];

/** Collapse control characters and runs of whitespace; drop anything that empties out. */
function cardText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\p{C}\s]+/gu, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Substitute `{operation}` and `{details}`.
 *
 * When there are no details, the token is removed **together with any separator punctuation
 * immediately before it** — a pack author writes one template, and a dangling "—" on every
 * detail-free card would be a visible defect. A template that omits a token simply does not
 * receive that value; nothing is appended behind the author's back.
 */
function fillTemplate(template: string, operation: string, details: string): string {
  const withDetails = details.length > 0
    ? template.replace("{details}", details)
    : template.replace(/[\s]*[—:;-]?[\s]*\{details\}/u, "");
  return withDetails.replace("{operation}", operation);
}

/**
 * Project a `kind: "approval"` event's card label through the locale catalog.
 *
 * @param event - the canonical activity event; non-approval events yield `undefined` so every
 *   other card keeps its existing label untouched.
 * @param locale - the resolved response locale, or `undefined` to take the English pack.
 * @param catalog - the operator-pack catalog (`catalogFromLocalePacks`).
 * @returns the localized label, or `undefined` when this event is not an approval card.
 */
export function localizeApprovalCardLabel(
  event: ActivityEvent,
  locale: string | undefined,
  catalog: LocaleCatalog,
): string | undefined {
  if (event.kind !== "approval") return undefined;

  const action = cardText(event.action);
  const toolName = cardText(event.toolName);
  // Both absent would leave nothing identifying the call being approved; a card that says only
  // "approval required" is worse than the English one, so decline to project it.
  if (toolName === undefined && action === undefined) return undefined;
  const operation = [toolName, action].filter((part) => part !== undefined).join(" ");

  const params: Record<string, unknown> = (event.params ?? {}) as Record<string, unknown>;
  const details: string[] = [];
  for (const [key, messageId] of DETAIL_FIELDS) {
    const value = cardText(params[key]);
    if (value !== undefined) details.push(`${catalog.resolve(locale, messageId)} ${value}`);
  }
  // Transport is a bare identifier (stdio/http/sse) with no prefix word to translate.
  const transport = cardText(params.transport);
  if (transport !== undefined) details.push(transport);
  const credentialKeys = Array.isArray(params.credential_keys)
    ? params.credential_keys.map(cardText).filter((v): v is string => v !== undefined)
    : [];
  if (credentialKeys.length > 0) {
    details.push(`${catalog.resolve(locale, "activity_card_detail_secret")} ${credentialKeys.join(",")}`);
  }

  const template = catalog.resolve(locale, "activity_card_approval_required");
  const label = fillTemplate(template, operation, details.join("; ")).trim();
  return label.length > CARD_LABEL_MAX ? label.slice(0, CARD_LABEL_MAX) : label;
}
