// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix @-mention helpers — pure and transport-free. No I/O, no SDK: both
 * functions are total functions of their arguments, so they unit-test in
 * isolation and keep the adapter and mapper within their size budgets.
 *
 * Two directions:
 *
 * - OUTBOUND {@link extractMentions}: rewrite `@[Name](@mxid:server)` markup into
 *   a `matrix.to` markdown link the shared renderer turns into an HTML pill, and
 *   collect the referenced MXIDs (deduped) for the event's `m.mentions.user_ids`.
 *   A markup whose target is not an anchored MXID (`@localpart:server`) is left
 *   literal — an @-looking code or documentation sample can never become a real
 *   mention. Rewriting to a markdown link (rather than emitting HTML here) means
 *   the single, separately-tested `renderMarkdownToMatrixHtml` escaper produces
 *   the pill; there is no second escaper to keep in sync.
 * - INBOUND {@link detectBotMention}: was the bot itself addressed? True iff the
 *   event's `m.mentions.user_ids` names the bot MXID, or its `formatted_body`
 *   carries a `matrix.to` pill linking to it. It keys on the bot's OWN MXID —
 *   never a display name — so a spoofed name in the content cannot trigger the
 *   bot, and an empty bot MXID never matches.
 *
 * @module
 */

/**
 * An anchored Matrix user id: `@localpart:server`. The server may carry a
 * `:port`, so only the localpart is constrained to be colon-free; the whole
 * string is anchored (`^…$`) so a target that merely contains an MXID-looking
 * run is not accepted.
 */
const MXID_RE = /^@[^\s:]+:[^\s]+$/;

/** `@[Display Name](target)` mention markup — name excludes `]`, target excludes `)`. */
const MENTION_MARKUP_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

/** The `matrix.to` base a user pill links through. */
const MATRIX_TO_BASE = "https://matrix.to/#/";

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The outbound-mention extraction result: the collected MXIDs + the rewritten text. */
export interface ExtractedMentions {
  /** The deduped MXIDs to advertise in the event's `m.mentions.user_ids`. */
  userIds: string[];
  /** The markdown with each valid mention rewritten to a `matrix.to` pill link. */
  rewrittenMarkdown: string;
}

/**
 * Rewrite `@[Name](@mxid:server)` markup into `[Name](https://matrix.to/#/@mxid:server)`
 * markdown links and collect the referenced MXIDs (deduped, insertion-ordered).
 *
 * Markup whose target is not an anchored MXID is returned unchanged with no
 * collected id (the false-mention control). Every valid occurrence is rewritten,
 * even a repeated MXID, but the same MXID is collected only once.
 *
 * @param markdown - The agent's markdown text.
 * @returns The collected `userIds` and the `rewrittenMarkdown`.
 */
export function extractMentions(markdown: string): ExtractedMentions {
  const userIds: string[] = [];
  const seen = new Set<string>();
  const rewrittenMarkdown = markdown.replace(
    MENTION_MARKUP_RE,
    (whole, name: string, target: string) => {
      if (!MXID_RE.test(target)) return whole; // not a real MXID — leave literal
      if (!seen.has(target)) {
        seen.add(target);
        userIds.push(target);
      }
      return `[${name}](${MATRIX_TO_BASE}${target})`;
    },
  );
  return { userIds, rewrittenMarkdown };
}

/**
 * Whether an inbound event content addresses the bot itself.
 *
 * True iff `content["m.mentions"].user_ids` includes `botUserId` (the
 * authoritative signal), or `content.formatted_body` carries a `matrix.to` pill
 * (a real anchor `href`) linking to `botUserId` (the fallback for a client that
 * pills without the `m.mentions` list). The fallback requires an actual `href` —
 * NOT a bare substring — so a member cannot paste the bot's matrix.to URL as
 * plain text to force a reply. Keys on the bot's OWN MXID — a display name never
 * counts — and returns false when `botUserId` is empty (no identity to key on).
 *
 * @param content - The untrusted inbound event content (or undefined).
 * @param botUserId - The bot's own MXID (`""` when unknown).
 * @returns Whether the bot was addressed.
 */
export function detectBotMention(content: Record<string, unknown> | undefined, botUserId: string): boolean {
  if (botUserId.length === 0 || content === undefined) return false;

  // Authoritative: the m.mentions user_ids list names the bot MXID.
  const mentions = content["m.mentions"];
  if (typeof mentions === "object" && mentions !== null) {
    const userIds = (mentions as { user_ids?: unknown }).user_ids;
    if (Array.isArray(userIds) && userIds.includes(botUserId)) return true;
  }

  // Fallback: a matrix.to pill in the formatted body links to the bot MXID. The
  // link must be a real anchor href (a rendered pill), not a bare substring — a
  // plain-text matrix.to URL in the body must never trigger the bot.
  const formatted = content.formatted_body;
  if (typeof formatted === "string") {
    const pillHref = new RegExp(`href=["']${escapeRegExp(`${MATRIX_TO_BASE}${botUserId}`)}`);
    if (pillHref.test(formatted)) return true;
  }

  return false;
}
