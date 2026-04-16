/**
 * HTML sanitizer for plain-text channel surfaces.
 *
 * Strips HTML tags from LLM output and converts them to lightweight markup
 * for plain-text channel surfaces (WhatsApp, Signal, IRC, iMessage, LINE).
 *
 * Only needed after IR render because the IR pipeline handles markdown
 * conversion but not raw HTML that LLMs sometimes produce directly.
 *
 * @module
 */

/**
 * Channel surfaces that receive plain text (no native HTML/rich formatting).
 */
export const PLAIN_TEXT_SURFACES = new Set<string>([
  "whatsapp",
  "signal",
  "irc",
  "imessage",
  "line",
]);

/**
 * Check whether the given channel type is a plain-text surface.
 */
export function isPlainTextSurface(channelType: string): boolean {
  return PLAIN_TEXT_SURFACES.has(channelType);
}

/**
 * Sanitize HTML tags from text intended for plain-text channel surfaces.
 *
 * Converts common HTML formatting tags to lightweight markup equivalents
 * and decodes HTML entities. Processing order matters: tags are stripped
 * before entities are decoded, so encoded angle brackets (`&lt;`, `&gt;`)
 * in the original text are preserved as literal characters, not
 * re-interpreted as HTML.
 *
 * @param text - Text potentially containing HTML tags
 * @returns Clean text with HTML converted to lightweight markup
 */
export function sanitizeForPlainText(text: string): string {
  let result = text;

  // a. Preserve autolinks: <https://...> or <mailto:...>
  result = result.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1");

  // b. Extract URLs from <a> tags — if label differs from URL, show both
  result = result.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
    (_match, url: string, label: string) => {
      if (label === url) return url;
      return `${label} (${url})`;
    },
  );

  // c. Line breaks
  result = result.replace(/<br\s*\/?>/gi, "\n");

  // d. Block elements — add newlines
  result = result.replace(/<\/?(p|div)>/gi, "\n");

  // e. Bold
  result = result.replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*");

  // f. Italic
  result = result.replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_");

  // g. Strikethrough
  result = result.replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~");

  // h. Inline code
  result = result.replace(/<code>(.*?)<\/code>/gi, "`$1`");

  // i. Headings
  result = result.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n");

  // j. List items
  result = result.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");

  // k. Strip remaining HTML tags
  result = result.replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "");

  // l. Decode HTML entities (AFTER tag stripping)
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&nbsp;/g, " ");
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&quot;/g, '"');

  // m. Collapse excessive newlines
  result = result.replace(/\n{3,}/g, "\n\n");

  // n. Trim
  return result.trim();
}
