/**
 * SearXNG self-hosted metasearch provider for the web_search tool.
 *
 * Connects to a self-hosted SearXNG instance. No API key needed,
 * but requires a base URL configuration.
 *
 * @module
 */

import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
};

type SearxngResponse = {
  results?: SearxngResult[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a SearXNG base URL.
 * Must start with http:// or https://, must not contain ? or #.
 * Strips trailing slashes and appends /search if not already present.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error("SearXNG baseUrl must start with https:// or http://");
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("SearXNG baseUrl must not contain query string or fragment");
  }
  let normalized = trimmed.replace(/\/+$/, "");
  if (!normalized.endsWith("/search")) {
    normalized += "/search";
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using a SearXNG instance.
 * No API key required, but needs a configured base URL.
 */
export async function runSearxngSearch(params: {
  query: string;
  count: number;
  baseUrl: string;
  timeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  time_range?: string;
}): Promise<{ results: Array<{ title: string; url: string; description: string }>; count: number }> {
  const endpoint = normalizeBaseUrl(params.baseUrl);
  const url = new URL(endpoint);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "all");
  url.searchParams.set("safesearch", "0");
  url.searchParams.set("categories", "general");
  url.searchParams.set("count", String(params.count));
  if (params.time_range) {
    url.searchParams.set("time_range", params.time_range);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "comis/1.0 (web_search)",
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`SearXNG API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as SearxngResponse;
  const rawResults = Array.isArray(data.results) ? data.results : [];

  const results = rawResults.slice(0, params.count).map((entry) => {
    const title = entry.title ?? "";
    const description = entry.content ?? "";
    return {
      title: title ? wrapWebContent(title, "web_search", params.onSuspiciousContent, false) : "",
      url: entry.url ?? "",
      description: description
        ? wrapWebContent(description, "web_search", params.onSuspiciousContent, false)
        : "",
    };
  });

  return { results, count: results.length };
}

// ---------------------------------------------------------------------------
// SearchProvider descriptor
// ---------------------------------------------------------------------------

/** SearXNG self-hosted metasearch provider descriptor for registry-based dispatch. */
export const searxngProvider: SearchProvider = {
  name: "searxng",
  requiresApiKey: false,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    return runSearxngSearch({
      query: params.query,
      count: params.count,
      baseUrl: (pc.baseUrl as string) || "",
      timeoutSeconds: params.timeoutSeconds,
      onSuspiciousContent: params.onSuspiciousContent,
      time_range: pc.time_range as string | undefined,
    });
  },
};

registerSearchProvider(searxngProvider);
