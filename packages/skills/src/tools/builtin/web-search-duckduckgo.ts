// SPDX-License-Identifier: Apache-2.0
// @allow-throw: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.
/**
 * DuckDuckGo HTML search provider for the web_search tool.
 *
 * Free provider requiring no API key. Uses DuckDuckGo's HTML search endpoint
 * (html.duckduckgo.com/html/) to return real web search results for all query types,
 * including news and current events.
 *
 * The endpoint only serves results for GET requests carrying the query as a
 * URL parameter; a form POST is answered with the anomaly challenge page. It
 * also rate-limits per source IP, and once tripped it keeps serving that
 * challenge for roughly a minute regardless of client identity — a fresh
 * connection does not clear it, so a challenge is reported to the caller
 * rather than retried inside the call's timeout budget.
 *
 * impit supplies Chrome TLS and HTTP parity so the request is not rejected for
 * looking like a bare scripted client.
 *
 * @module
 */

import { Impit } from "impit";
import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";
import { detectErrorPagePattern } from "./web-fetch-utils.js";

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
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Strip all HTML tags from a string. */
function stripHtmlTags(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    parts.push(text.slice(cursor, start));
    const end = text.indexOf(">", start + 1);
    if (end === -1) break;
    cursor = end + 1;
  }
  return parts.join("");
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
 *
 * Each result's snippet is taken from the markup between that result's link and
 * the next one. Pairing links and snippets by ordinal instead would shift every
 * snippet after a snippetless result onto the wrong URL.
 */
export function parseDdgHtml(
  html: string,
): Array<{ title: string; url: string; description: string }> {
  const results: Array<{ title: string; url: string; description: string }> = [];

  // Match result link elements: <a class="result__a" href="...">Title</a>
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  // Match snippet elements: <a class="result__snippet"...>Description</a>
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

  // linkStart/linkEnd bound each result's own anchor, so the snippet search
  // window for a result is exactly the markup up to the next result's anchor.
  const links: Array<{ href: string; title: string; linkStart: number; linkEnd: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    links.push({
      href: match[1],
      title: cleanText(match[2]),
      linkStart: match.index,
      linkEnd: match.index + match[0].length,
    });
  }

  for (let i = 0; i < links.length; i++) {
    const realUrl = extractRealUrl(links[i].href);
    if (!realUrl) continue;

    const blockEnd = links[i + 1]?.linkStart ?? html.length;
    const block = html.slice(links[i].linkEnd, blockEnd);
    const snippet = snippetRegex.exec(block)?.[1];

    results.push({
      title: links[i].title,
      url: realUrl,
      description: snippet === undefined ? "" : cleanText(snippet),
    });
  }

  return results;
}

/**
 * DuckDuckGo represents a genuine empty result set with a dedicated result
 * row. A plain page with no parsed links is not sufficient evidence: it may be
 * a challenge page, upstream outage, or parser drift.
 *
 * Both markers are structural class names. The heading text inside the message
 * block names the query and is localized, so it cannot be matched literally.
 */
function isDdgEmptyResultsPage(html: string): boolean {
  return /\bresult--no-result\b/i.test(html) && /\bno-results__message\b/i.test(html);
}

/**
 * DuckDuckGo serves its anomaly challenge page when the source IP trips the
 * endpoint's rate limit. It arrives with a 2xx status — commonly 202 — so the
 * status alone cannot distinguish it from results.
 *
 * Matches only the challenge page's own structural markers (its modal class and
 * the verifier endpoint its form posts to) so that result prose mentioning a
 * challenge or an anomaly cannot be mistaken for one.
 */
function isDdgAnomalyChallenge(html: string): boolean {
  return /\banomaly-modal\b/i.test(html) || /\/anomaly\.js\b/i.test(html);
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
  // The query travels in the URL: the endpoint answers a form POST with its
  // anomaly challenge page instead of results.
  const url = new URL(DDG_ENDPOINT);
  url.searchParams.set("q", params.query);
  if (params.df) {
    url.searchParams.set("df", params.df);
  }
  const client = getClient();

  const res = await client.fetch(url.toString(), {
    method: "GET",
    timeout: params.timeoutSeconds * 1000,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`DuckDuckGo search error (${res.status}): ${detail || res.statusText}`);
  }

  const html = await res.text();
  const rawResults = parseDdgHtml(html);
  if (rawResults.length === 0) {
    // Classified only when nothing parsed, so that result text quoting any of
    // these patterns cannot be read as a failure page.
    if (isDdgAnomalyChallenge(html)) {
      throw new Error(
        `DuckDuckGo served its anomaly challenge (HTTP ${res.status}) instead of results. `
          + "The endpoint rate-limits per source IP and clears after about a minute. "
          + "Space searches further apart, or configure a keyed web_search provider "
          + "(tools.web.search.provider: brave, tavily, or exa) for sustained use.",
      );
    }
    const errorPage = detectErrorPagePattern(html);
    if (errorPage !== null) {
      const providerReason = `${errorPage.charAt(0).toLowerCase()}${errorPage.slice(1)}`;
      throw new Error(`DuckDuckGo search ${providerReason}`);
    }
    if (!isDdgEmptyResultsPage(html)) {
      throw new Error("DuckDuckGo search returned an unrecognized empty response");
    }
  }
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
