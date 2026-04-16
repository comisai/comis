/**
 * HTML visibility sanitizer for pre-Readability stripping of invisible elements.
 *
 * Removes elements hidden via aria-hidden, display:none, visibility:hidden,
 * opacity:0, sr-only classes, and always-remove tags (meta, template, svg,
 * canvas, iframe, object, embed). Also strips zero-width Unicode characters.
 *
 * Per user decision: script, noscript, hidden inputs, and data attributes
 * are NOT removed (Readability and htmlToMarkdown handle those).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  html: string;
  elementsRemoved: number;
}

// ---------------------------------------------------------------------------
// Always-remove tags (security/noise reduction)
// ---------------------------------------------------------------------------

/**
 * Tags stripped regardless of attributes. These never produce useful readable
 * content and may carry invisible payloads (SVG, canvas, iframes, embeds).
 *
 * NOT included per user decision: script, noscript, style (handled elsewhere).
 */
const ALWAYS_REMOVE_TAGS = new Set([
  "meta",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
]);

// ---------------------------------------------------------------------------
// Hidden-class patterns (word-boundary match, not substring)
// ---------------------------------------------------------------------------

const HIDDEN_CLASSES = ["sr-only", "visually-hidden", "screen-reader-only"];

// ---------------------------------------------------------------------------
// Zero-width / invisible Unicode
// ---------------------------------------------------------------------------

/**
 * Zero-width and invisible formatting characters.
 * Includes ZWS, ZWNJ, ZWJ, LRM, RLM, BiDi overrides, word joiners,
 * invisible separators, and BOM/ZWSP (FEFF).
 *
 * Per user decision: strip ALL zero-width chars -- no exceptions for emoji joiners.
 *
 * Uses Unicode property escapes and explicit codepoint ranges to avoid
 * `no-misleading-character-class` lint errors from joined sequences.
 */
const INVISIBLE_UNICODE_RE =
  /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]|\u200D/gu;

/**
 * Unicode tag characters (U+E0001, U+E0020-U+E007F) used in flag emoji sequences
 * and deprecated language tagging. Can be abused for invisible text injection.
 */
const UNICODE_TAGS_RE = /\u{E0001}|[\u{E0020}-\u{E007F}]/gu;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Remove matching open+close tag pairs (including content) and self-closing tags
 * for a given tag name. Uses non-greedy matching. Returns updated HTML and removal count.
 */
function removeTagPairs(
  html: string,
  tagName: string,
): { html: string; removed: number } {
  let removed = 0;

  // Remove open+close pairs: <tag ...>...</tag> (non-greedy, case-insensitive)
  // Process innermost first by repeating until stable
  let prev = "";
  let current = html;
  while (prev !== current) {
    prev = current;
    current = current.replace(
      new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi"),
      () => {
        removed++;
        return "";
      },
    );
  }

  // Remove self-closing: <tag ... />
  current = current.replace(
    new RegExp(`<${tagName}\\b[^>]*/\\s*>`, "gi"),
    () => {
      removed++;
      return "";
    },
  );

  // Remove unclosed tags: <tag ...> (no closing tag, no self-close slash)
  // Only for void-ish elements like meta, embed — not block elements
  if (tagName === "meta" || tagName === "embed") {
    current = current.replace(
      new RegExp(`<${tagName}\\b[^>]*>`, "gi"),
      () => {
        removed++;
        return "";
      },
    );
  }

  return { html: current, removed };
}

/**
 * Remove elements matching an attribute pattern. Handles both paired tags
 * (open+close) and self-closing tags.
 *
 * @param html - Input HTML
 * @param attrPattern - Regex pattern matching the attribute (must not contain capture groups
 *   that would interfere with the tag name capture group)
 */
function removeByAttribute(
  html: string,
  attrPattern: string,
): { html: string; removed: number } {
  let removed = 0;

  // Self-closing tags first: <tag ... pattern ... />
  let current = html.replace(
    new RegExp(`<(\\w+)\\s[^>]*?${attrPattern}[^>]*/\\s*>`, "gi"),
    () => {
      removed++;
      return "";
    },
  );

  // Paired tags: <tag ... pattern ...>...</tag>
  // Process innermost first by repeating until stable
  let prev = "";
  while (prev !== current) {
    prev = current;
    current = current.replace(
      new RegExp(
        `<(\\w+)(\\s[^>]*?)${attrPattern}([^>]*)>[\\s\\S]*?<\\/\\1>`,
        "gi",
      ),
      () => {
        removed++;
        return "";
      },
    );
  }

  return { html: current, removed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip all zero-width and invisible Unicode characters from text.
 *
 * Per user decision: strips ALL zero-width chars including emoji joiners (ZWJ U+200D).
 */
export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, "").replace(UNICODE_TAGS_RE, "");
}

/**
 * Sanitize HTML by removing invisible elements and always-remove tags.
 *
 * Processing order:
 * 1. Always-remove tags (meta, template, svg, canvas, iframe, object, embed)
 * 2. aria-hidden="true" elements
 * 3. display:none / visibility:hidden / opacity:0 inline-style elements
 * 4. sr-only / visually-hidden / screen-reader-only class elements
 * 5. Zero-width Unicode characters
 *
 * Returns sanitized HTML and total count of elements removed.
 */
export function sanitizeHtmlVisibility(html: string): SanitizeResult {
  if (!html || !html.trim()) {
    return { html: "", elementsRemoved: 0 };
  }

  let current = html;
  let totalRemoved = 0;

  // 1. Always-remove tags
  for (const tag of ALWAYS_REMOVE_TAGS) {
    const result = removeTagPairs(current, tag);
    current = result.html;
    totalRemoved += result.removed;
  }

  // 2. aria-hidden="true" elements
  {
    const result = removeByAttribute(
      current,
      `aria-hidden\\s*=\\s*["']true["']`,
    );
    current = result.html;
    totalRemoved += result.removed;
  }

  // 3. Inline style: display:none, visibility:hidden, opacity:0
  {
    const result = removeByAttribute(
      current,
      `style\\s*=\\s*["'][^"']*display\\s*:\\s*none[^"']*["']`,
    );
    current = result.html;
    totalRemoved += result.removed;
  }
  {
    const result = removeByAttribute(
      current,
      `style\\s*=\\s*["'][^"']*visibility\\s*:\\s*hidden[^"']*["']`,
    );
    current = result.html;
    totalRemoved += result.removed;
  }
  {
    const result = removeByAttribute(
      current,
      `style\\s*=\\s*["'][^"']*opacity\\s*:\\s*0[^"']*["']`,
    );
    current = result.html;
    totalRemoved += result.removed;
  }

  // 4. Hidden CSS classes: sr-only, visually-hidden, screen-reader-only
  for (const className of HIDDEN_CLASSES) {
    // Match class attribute containing the class name as a whole word.
    // Cannot use \b because it treats hyphens as word boundaries (e.g. "sr-only"
    // would match inside "sr-only-text"). Instead use (?<![\\w-]) and (?![\\w-])
    // to ensure the class name is not part of a larger hyphenated token.
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = removeByAttribute(
      current,
      `class\\s*=\\s*["'][^"']*(?<![\\w-])${escaped}(?![\\w-])[^"']*["']`,
    );
    current = result.html;
    totalRemoved += result.removed;
  }

  // 5. Strip zero-width Unicode characters from the HTML
  const _beforeLen = current.length;
  current = stripInvisibleUnicode(current);
  // Don't count Unicode stripping as "elements removed" — it's character-level

  return { html: current, elementsRemoved: totalRemoved };
}
