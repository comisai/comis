// SPDX-License-Identifier: Apache-2.0
/**
 * URL detection and extraction from messages.
 *
 * Extracts URLs from plain text, handling markdown link syntax,
 * trailing punctuation, and deduplication. Network eligibility is decided by
 * the authoritative SSRF validator immediately before fetch.
 *
 * @module
 */

/** Regex to capture URLs inside markdown links: [text](url) */
const MARKDOWN_LINK_RE = /\[[^\]]*\]\((https?:\/\/\S+?)\)/g;

/** Regex to find bare URLs in text */
const BARE_URL_RE = /https?:\/\/\S+/g;

/** Characters that commonly trail URLs in natural text — including the quote
 *  family: a URL pasted inside a JSON/YAML/code snippet carries its closing
 *  quote into the `\S+` match (live: a config snippet yielded a fetch of
 *  `…/api/v2%22` — the encoded trailing `"` — which 404'd). */
const TRAILING_PUNCTUATION = new Set([".", ",", ")", "]", ">", ";", "!", '"', "'", "`", "}"]);

/** Content-free detection census consumed by the link runner. */
export interface LinkDetectionResult {
  urls: string[];
  detected: number;
  invalid: number;
  duplicates: number;
  capped: number;
}

/**
 * Trim trailing punctuation characters from a URL string.
 * Handles common cases where URLs appear at the end of sentences.
 */
function trimTrailingPunctuation(url: string): string {
  let result = url;
  while (result.length > 0 && TRAILING_PUNCTUATION.has(result[result.length - 1])) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Detect URLs in a message, handling markdown links, normalization, and
 * deduplication.
 *
 * Steps:
 * 1. Extract URLs from markdown link syntax [text](url)
 * 2. Strip markdown links from message to avoid double extraction
 * 3. Extract bare URLs from remaining text
 * 4. Trim trailing punctuation, validate with URL constructor
 * 5. Deduplicate
 * 6. Limit fetch candidates to maxLinks
 *
 * @param message - The message text to extract URLs from
 * @param maxLinks - Maximum number of URLs to return (default: 3)
 * @returns Unique URL candidates plus a counts-only detection census
 */
export function detectLinksInMessage(
  message: string,
  maxLinks = 3,
): LinkDetectionResult {
  const urls: string[] = [];

  // Step 1: Extract URLs from markdown links
  const markdownMatches = message.matchAll(MARKDOWN_LINK_RE);
  for (const match of markdownMatches) {
    urls.push(match[1]);
  }

  // Step 2: Strip markdown links from message to avoid duplicate extraction
  const stripped = message.replace(MARKDOWN_LINK_RE, " ");

  // Step 3: Extract bare URLs from remaining text
  const bareMatches = stripped.matchAll(BARE_URL_RE);
  for (const match of bareMatches) {
    urls.push(match[0]);
  }

  // Step 4-6: Validate, deduplicate, and cap fetch candidates.
  const seen = new Set<string>();
  const eligible: string[] = [];
  let invalid = 0;
  let duplicates = 0;

  for (const raw of urls) {
    const trimmed = trimTrailingPunctuation(raw);

    // Validate with URL constructor
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      invalid += 1;
      continue;
    }

    // Deduplicate
    const normalized = parsed.href;
    if (seen.has(normalized)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized);
    eligible.push(normalized);
  }

  const limit = Math.max(0, maxLinks);
  return {
    urls: eligible.slice(0, limit),
    detected: urls.length,
    invalid,
    duplicates,
    capped: Math.max(0, eligible.length - limit),
  };
}
