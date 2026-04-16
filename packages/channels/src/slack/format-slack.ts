/**
 * Slack mrkdwn utilities: escaping for pre-existing mrkdwn content.
 *
 * Markdown-to-mrkdwn conversion is handled by the IR pipeline
 * (format-for-channel.ts -> ir-renderer.ts -> renderForSlack).
 * This module provides only `escapeSlackMrkdwn` for escaping special
 * characters (&, <, >) in text that is already in mrkdwn format,
 * while preserving Slack's angle-bracket tokens (mentions, channels, links).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Slack mrkdwn escaping
// ---------------------------------------------------------------------------

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

/**
 * Check whether an angle-bracket token is an allowed Slack token.
 * Allowed: <@U123>, <#C123>, <!here>, <http://...>, <https://...>,
 * <mailto:...>, <tel:...>, <slack://...>, and <url|label> patterns.
 */
function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) return false;
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

/**
 * Escape a segment of text for Slack mrkdwn (& < > characters).
 */
function escapeSegment(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape special characters (&, <, >) for Slack mrkdwn while preserving
 * Slack's angle-bracket tokens (mentions, channels, links).
 *
 * Splits text around `<...>` tokens. For segments outside tokens, escapes
 * &, <, >. For allowed Slack tokens, preserves as-is. For unrecognized
 * angle-bracket tokens, escapes them.
 */
export function escapeSlackMrkdwn(text: string): string {
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSegment(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSegment(text.slice(lastIndex)));
  return out.join("");
}

// ---------------------------------------------------------------------------
// markdownToSlackMrkdwn: DELETED
//
// Slack markdown-to-mrkdwn conversion is now handled by the IR pipeline
// (format-for-channel.ts -> ir-renderer.ts -> renderForSlack). The adapter
// is a passthrough. Only escapeSlackMrkdwn remains for escaping pre-existing
// mrkdwn content.
// ---------------------------------------------------------------------------
