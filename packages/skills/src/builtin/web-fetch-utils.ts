/**
 * HTML readability extraction and markdown conversion utilities.
 *
 * Used by web_fetch (and potentially browser tool) to convert raw HTML
 * into clean readable text or markdown. Uses @mozilla/readability + linkedom
 * via dynamic import with a fallback to regex-based HTML-to-markdown conversion.
 *
 * Visibility sanitization runs before Readability to strip
 * invisible elements (aria-hidden, display:none, sr-only) and zero-width Unicode.
 *
 * @module
 */

import { sanitizeHtmlVisibility, stripInvisibleUnicode } from "./web-fetch-visibility.js";

export type ExtractMode = "markdown" | "text";

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Convert HTML to markdown-ish text.
 * Strips scripts/styles/noscript, converts links/headings/lists to markdown syntax,
 * and decodes HTML entities.
 */
export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    if (!label) {
      return href;
    }
    return `[${label}](${href})`;
  });
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return `\n${prefix} ${label}\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

/**
 * Strip markdown formatting to produce plain text.
 * Removes images, links (keeping label), code blocks/spans, headings, and list markers.
 */
export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

// ---------------------------------------------------------------------------
// Error page pattern detection
// ---------------------------------------------------------------------------

/**
 * Known error page patterns checked in priority order.
 * Each entry maps a set of case-insensitive indicators to a human-readable description.
 */
const ERROR_PAGE_PATTERNS: { patterns: RegExp[]; message: string }[] = [
  {
    patterns: [
      /checking your browser/i,
      /cf-browser-verification/i,
      /cloudflare/i,
      /ray id/i,
      /ddos protection by/i,
      /attention required!/i,
      /cf-error-details/i,
    ],
    message: "Blocked by Cloudflare DDoS protection (Ray ID present)",
  },
  {
    patterns: [
      /captcha/i,
      /recaptcha/i,
      /hcaptcha/i,
      /g-recaptcha/i,
      /h-captcha/i,
      /challenge-form/i,
      /verify you are human/i,
      /are you a robot/i,
      /bot detection/i,
    ],
    message: "Blocked by CAPTCHA challenge",
  },
  {
    patterns: [
      /access denied/i,
      /403 forbidden/i,
      /you don't have permission/i,
      /not authorized/i,
      /request blocked/i,
      /web application firewall/i,
    ],
    message: "Access denied by server",
  },
  {
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /429/i,
      /throttled/i,
      /slow down/i,
      /retry after/i,
      /request limit exceeded/i,
    ],
    message: "Rate limited by server",
  },
  {
    patterns: [
      /bot detected/i,
      /automated access/i,
      /please enable javascript/i,
      /browser not supported/i,
      /enable cookies/i,
      /pardon our interruption/i,
    ],
    message: "Blocked by bot detection",
  },
];

/**
 * Examine raw HTML/text from an error response and return a concise human-readable
 * description if it matches a known error page pattern, or `null` if no pattern matches.
 *
 * Checks only the first 10,000 characters for performance -- error page indicators
 * appear early in the document.
 */
export function detectErrorPagePattern(body: string): string | null {
  const slice = body.slice(0, 10_000);
  for (const { patterns, message } of ERROR_PAGE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(slice)) {
        return message;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

/**
 * Truncate text to a maximum character length.
 * Returns the truncated text and whether truncation occurred.
 */
export function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

/**
 * Extract readable content from HTML using @mozilla/readability + linkedom.
 * Falls back to regex-based htmlToMarkdown if readability extraction fails or
 * the libraries are not available.
 *
 * Runs visibility sanitization (strip aria-hidden, display:none, sr-only, etc.)
 * before Readability extraction by default. Disable via `stripHidden: false`.
 *
 * @param params.html - Raw HTML string
 * @param params.url - The page URL (used for resolving relative links)
 * @param params.extractMode - "markdown" or "text" output format
 * @param params.stripHidden - Strip hidden elements before extraction (default true)
 */
export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: ExtractMode;
  stripHidden?: boolean;
}): Promise<{
  text: string;
  title?: string;
  sanitized?: boolean;
  elementsRemoved?: number;
} | null> {
  // --- Visibility sanitization ---
  let processedHtml = params.html;
  let sanitizeMetadata: { elementsRemoved: number } | undefined;

  if (params.stripHidden !== false) {
    const sanitized = sanitizeHtmlVisibility(processedHtml);
    processedHtml = sanitized.html;
    if (sanitized.elementsRemoved > 0) {
      sanitizeMetadata = { elementsRemoved: sanitized.elementsRemoved };
    }
  }

  const fallback = (): { text: string; title?: string } => {
    const rendered = htmlToMarkdown(processedHtml);
    if (params.extractMode === "text") {
      const text = markdownToText(rendered.text) || normalizeWhitespace(stripTags(processedHtml));
      return { text, title: rendered.title };
    }
    return rendered;
  };

  const addMetadata = (
    result: { text: string; title?: string },
  ): { text: string; title?: string; sanitized?: boolean; elementsRemoved?: number } => {
    if (!sanitizeMetadata) {
      return result;
    }
    return {
      ...result,
      sanitized: true,
      elementsRemoved: sanitizeMetadata.elementsRemoved,
    };
  };

  try {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]);
    const { document } = parseHTML(processedHtml);
    try {
      (document as { baseURI?: string }).baseURI = params.url;
    } catch {
      // Best-effort base URI for relative links.
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) {
      const fb = fallback();
      fb.text = stripInvisibleUnicode(fb.text);
      return addMetadata(fb);
    }
    const title = parsed.title || undefined;
    if (params.extractMode === "text") {
      let text = normalizeWhitespace(parsed.textContent ?? "");
      if (!text) {
        const fb = fallback();
        fb.text = stripInvisibleUnicode(fb.text);
        return addMetadata(fb);
      }
      text = stripInvisibleUnicode(text);
      return addMetadata({ text, title });
    }
    const rendered = htmlToMarkdown(parsed.content);
    const text = stripInvisibleUnicode(rendered.text);
    return addMetadata({ text, title: title ?? rendered.title });
  } catch {
    const fb = fallback();
    fb.text = stripInvisibleUnicode(fb.text);
    return addMetadata(fb);
  }
}
