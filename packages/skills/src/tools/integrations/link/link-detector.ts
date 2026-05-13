// SPDX-License-Identifier: Apache-2.0
/**
 * URL detection and extraction from messages.
 *
 * Extracts URLs from plain text, handling markdown link syntax,
 * trailing punctuation, and deduplication. Filters out private
 * and localhost addresses for security.
 *
 * @module
 */

/** Regex to capture URLs inside markdown links: [text](url) */
const MARKDOWN_LINK_RE = /\[[^\]]*\]\((https?:\/\/\S+?)\)/g;

/** Regex to find bare URLs in text */
const BARE_URL_RE = /https?:\/\/\S+/g;

/** Characters that commonly trail URLs in natural text */
const TRAILING_PUNCTUATION = new Set([".", ",", ")", "]", ">", ";", "!"]);

/** Hostnames considered localhost / loopback */
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Check if a hostname resolves to a private or loopback address.
 * Simple heuristic check on hostname only (SSRF guard handles full DNS resolution later).
 */
function isPrivateHost(hostname: string): boolean {
  if (LOCALHOST_NAMES.has(hostname)) {
    return true;
  }
  // Check RFC 1918 private ranges by hostname pattern
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  // Link-local
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) {
    return true;
  }
  return false;
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
 * Extract URLs from a message, handling markdown links, deduplication,
 * and private IP filtering.
 *
 * Steps:
 * 1. Extract URLs from markdown link syntax [text](url)
 * 2. Strip markdown links from message to avoid double extraction
 * 3. Extract bare URLs from remaining text
 * 4. Trim trailing punctuation, validate with URL constructor
 * 5. Filter out localhost and private IPs
 * 6. Deduplicate and limit to maxLinks
 *
 * @param message - The message text to extract URLs from
 * @param maxLinks - Maximum number of URLs to return (default: 3)
 * @returns Array of unique, validated URL strings
 */
export function extractLinksFromMessage(message: string, maxLinks = 3): string[] {
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

  // Step 4-6: Validate, filter, deduplicate
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of urls) {
    const trimmed = trimTrailingPunctuation(raw);

    // Validate with URL constructor
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }

    // Skip private and localhost addresses
    if (isPrivateHost(parsed.hostname)) {
      continue;
    }

    // Deduplicate
    const normalized = parsed.href;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);

    // Limit to maxLinks
    if (result.length >= maxLinks) {
      break;
    }
  }

  return result;
}
