// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat message-text formatting: a conservative escaping boundary for the
 * outbound message `text` field.
 *
 * Google Chat message text is Slack-mrkdwn-shaped — bold `*text*`, italic
 * `_text_`, monospace `` `text` ``, strikethrough `~text~`, hyperlinks
 * `<url|display text>`, and user mentions `<users/{id}>` — and it ALSO
 * interprets a basic HTML subset (`<b>`, `<br>`, …) in the same field. So the
 * agent's markup is already in the shape Chat renders and is passed through
 * unchanged; the boundary's only job is to escape stray `&`, `<`, `>` so a
 * literal angle bracket in agent text cannot be read as an HTML tag, while the
 * genuine `<…>` link/mention tokens are preserved.
 *
 * Markup-free plain text is returned byte-identical — an existing plain-text
 * send is never altered by routing through this module.
 *
 * This module serves the MESSAGE body text only. Card `textParagraph` content is
 * a separate surface escaped inside the rich renderer, not here.
 *
 * @module
 */

const GCHAT_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

/**
 * Whether an angle-bracket token is a genuine Google Chat token that must be
 * preserved rather than escaped. Allowed: `<users/…>` mentions and `<http(s)://…>`
 * links, including the `<url|display text>` form (the inner still begins with the
 * scheme). Anything else is treated as literal text and escaped.
 */
function isAllowedGoogleChatAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) return false;
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("users/") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://")
  );
}

/**
 * Escape the HTML-significant characters `&`, `<`, `>` to their entities. `&` is
 * escaped first so an already escaped entity is never doubled. This is the raw
 * helper — it escapes unconditionally and preserves no tokens.
 */
export function escapeGoogleChatText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format outbound Google Chat message text.
 *
 * Escapes stray `&`, `<`, `>` (so agent text cannot open an HTML tag) while
 * preserving genuine `<url|text>` / `<url>` / `<users/{id}>` tokens and leaving
 * every Slack-mrkdwn-shaped marker (`*bold*`, `_italic_`, `` `code` ``,
 * `~strike~`) byte-identical. Markup-free text is returned unchanged.
 *
 * @param text - The raw outbound message text
 * @returns The text with stray HTML-significant characters escaped
 */
export function formatGoogleChatText(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  GCHAT_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = GCHAT_ANGLE_TOKEN_RE.exec(text);
    match;
    match = GCHAT_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeGoogleChatText(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedGoogleChatAngleToken(token) ? token : escapeGoogleChatText(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeGoogleChatText(text.slice(lastIndex)));
  return out.join("");
}
