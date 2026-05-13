// SPDX-License-Identifier: Apache-2.0
/**
 * DuckDuckGo HTML search provider for the web_search tool.
 *
 * Free provider requiring no API key. Uses DuckDuckGo's HTML search endpoint
 * (html.duckduckgo.com/html/) to return real web search results for all query types,
 * including news and current events.
 *
 * Uses impit for Chrome TLS fingerprinting to bypass bot detection.
 *
 * @module
 */

import { Impit } from "impit";
import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * Chrome browser headers for impit TLS fingerprinting.
 * impit impersonates Chrome 125 at the TLS layer; these headers
 * supplement the impersonation at the HTTP layer.
 */
const CHROME_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
};

// Lazy singleton — created on first use so the module import stays side-effect-free.
let impitClient: Impit | undefined;

function getClient(): Impit {
  if (!impitClient) {
    impitClient = new Impit({
      browser: "chrome",
      followRedirects: true,
      headers: CHROME_HEADERS,
    });
  }
  return impitClient;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/** Decode common HTML entities in extracted text. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

/** Strip all HTML tags from a string. */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}

/** Clean extracted text: strip tags, decode entities, normalize whitespace. */
function cleanText(text: string): string {
  return decodeHtmlEntities(stripHtmlTags(text)).replace(/\s+/g, " ").trim();
}

/**
 * Extract the actual URL from a DuckDuckGo redirect link.
 * DDG wraps external URLs as `//duckduckgo.com/l/?uddg=ENCODED_URL&rut=...`.
 * Returns the decoded URL or undefined if extraction fails.
 */
function extractRealUrl(href: string): string | undefined {
  try {
    // Some hrefs are protocol-relative
    const fullHref = href.startsWith("//") ? `https:${href}` : href;

    // Only process DDG redirect links
    if (!fullHref.includes("duckduckgo.com/l/")) {
      // Direct URL (not a redirect) — use as-is if it looks valid
      if (fullHref.startsWith("http://") || fullHref.startsWith("https://")) {
        return fullHref;
      }
      return undefined;
    }

    const url = new URL(fullHref);
    const uddg = url.searchParams.get("uddg");
    if (!uddg) return undefined;
    const decoded = decodeURIComponent(uddg);
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse DuckDuckGo HTML search results page.
 * Extracts title, URL, and description from result elements.
 */
export function parseDdgHtml(
  html: string,
): Array<{ title: string; url: string; description: string }> {
  const results: Array<{ title: string; url: string; description: string }> = [];

  // Match result link elements: <a class="result__a" href="...">Title</a>
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  // Match snippet elements: <a class="result__snippet"...>Description</a>
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const links: Array<{ href: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    links.push({ href: match[1], title: cleanText(match[2]) });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(cleanText(match[1]));
  }

  for (let i = 0; i < links.length; i++) {
    const realUrl = extractRealUrl(links[i].href);
    if (!realUrl) continue;

    results.push({
      title: links[i].title,
      url: realUrl,
      description: snippets[i] ?? "",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using DuckDuckGo's HTML search endpoint.
 * No API key required. Returns real web search results for all query types.
 * Uses impit Chrome TLS fingerprinting to avoid bot detection.
 */
export async function runDuckDuckGoSearch(params: {
  query: string;
  count: number;
  timeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  df?: string;
}): Promise<{ results: Array<{ title: string; url: string; description: string }>; count: number }> {
  const body = new URLSearchParams({ q: params.query });
  if (params.df) {
    body.set("df", params.df);
  }
  const client = getClient();

  const res = await client.fetch(DDG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    timeout: params.timeoutSeconds * 1000,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`DuckDuckGo search error (${res.status}): ${detail || res.statusText}`);
  }

  const html = await res.text();
  const rawResults = parseDdgHtml(html);
  const limit = Math.max(1, params.count);
  const limited = rawResults.slice(0, limit);

  const results = limited.map((r) => ({
    title: r.title ? wrapWebContent(r.title, "web_search", params.onSuspiciousContent, false) : "",
    url: r.url,
    description: r.description
      ? wrapWebContent(r.description, "web_search", params.onSuspiciousContent, false)
      : "",
  }));

  return { results, count: results.length };
}

// ---------------------------------------------------------------------------
// SearchProvider descriptor
// ---------------------------------------------------------------------------

/** DuckDuckGo search provider descriptor for registry-based dispatch. */
export const duckduckgoProvider: SearchProvider = {
  name: "duckduckgo",
  requiresApiKey: false,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    return runDuckDuckGoSearch({
      query: params.query,
      count: params.count,
      timeoutSeconds: params.timeoutSeconds,
      onSuspiciousContent: params.onSuspiciousContent,
      df: pc.df as string | undefined,
    });
  },
};

registerSearchProvider(duckduckgoProvider);
