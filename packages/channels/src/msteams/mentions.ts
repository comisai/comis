// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams @-mention helpers — pure and transport-free.
 *
 * Two directions:
 *
 * - INBOUND {@link detectBotMention}: is the bot itself @-mentioned? A mention
 *   entity whose `mentioned.id` equals the activity recipient id. (The inbound
 *   `<at>…</at>` strip lives in the message-mapper's plain-text pass — this file
 *   only decides whether the bot was addressed.)
 * - OUTBOUND {@link buildMentionEntities}: turn `@[Name](id)` markup into the
 *   Teams `<at>Name</at>` tag + the paired `entities[]` mention element — but
 *   ONLY when `id` matches an anchored AAD directory GUID or a `28:<guid>` bot
 *   id. An id that matches neither is left as plain text so a code/doc sample
 *   that merely looks like a mention can never become a real one.
 *
 * @module
 */

/** Anchored AAD directory object GUID: 8-4-4-4-12 hex groups. */
const AAD_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Anchored Bot Framework bot id: the `28:` prefix followed by a hex/dash guid. */
const BOT_ID_RE = /^28:[0-9a-fA-F-]+$/;

/** `@[Display Name](id)` mention markup — name excludes `]`, id excludes `)`. */
const MENTION_MARKUP_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

/** A Teams `entities[]` mention element paired with an `<at>…</at>` tag in the body. */
export interface TeamsMentionEntity {
  type: "mention";
  /** Must match the `<at>Name</at>` tag verbatim in the activity text. */
  text: string;
  mentioned: { id: string; name: string };
}

/** The outbound-mention build result: rewritten text + the entities to attach. */
export interface BuiltMention {
  text: string;
  entities: TeamsMentionEntity[];
}

/**
 * True when an inbound activity @-mentions the bot itself — a `mention` entity
 * whose target equals the recipient id.
 *
 * An absent recipient id yields false so a mention entity carrying no target
 * (`mentioned` undefined) can never be misread as addressing the bot.
 */
export function detectBotMention(
  entities: ReadonlyArray<{ type: string; mentioned?: { id: string } }> | undefined,
  recipientId: string | undefined,
): boolean {
  if (!recipientId) return false;
  return entities?.some((e) => e.type === "mention" && e.mentioned?.id === recipientId) ?? false;
}

/** True when an id is a shape a real outbound mention may reference. */
function isMentionableId(id: string): boolean {
  return AAD_GUID_RE.test(id) || BOT_ID_RE.test(id);
}

/**
 * Rewrite `@[Name](id)` markup into Teams `<at>Name</at>` tags and collect the
 * paired mention entities — gated on {@link isMentionableId}. Markup whose id
 * matches neither shape is returned unchanged with no entity (the false-mention
 * control): a `@`-looking code or documentation sample stays literal text.
 */
export function buildMentionEntities(markup: string): BuiltMention {
  const entities: TeamsMentionEntity[] = [];
  const text = markup.replace(MENTION_MARKUP_RE, (whole, name: string, id: string) => {
    if (!isMentionableId(id)) return whole;
    const tag = `<at>${name}</at>`;
    entities.push({ type: "mention", text: tag, mentioned: { id, name } });
    return tag;
  });
  return { text, entities };
}
