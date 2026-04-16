/**
 * Tavily AI Search API provider for the web_search tool.
 *
 * Uses the Tavily search endpoint with API key authentication
 * in the POST body (per Tavily's documented API pattern).
 *
 * @module
 */

import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

type TavilyResponse = {
  results?: TavilyResult[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using the Tavily AI Search API.
 * API key is sent in the POST body per Tavily's documented pattern.
 */
export async function runTavilySearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  days?: number;
}): Promise<{ results: Array<{ title: string; url: string; description: string }>; count: number }> {
  const requestBody: Record<string, unknown> = {
    api_key: params.apiKey,
    query: params.query,
    max_results: params.count,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };
  if (params.days !== undefined) {
    requestBody.days = params.days;
  }
  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`Tavily API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as TavilyResponse;

  if (data.error) {
    throw new Error(`Tavily API error: ${data.error}`);
  }

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

/** Tavily AI Search provider descriptor for registry-based dispatch. */
export const tavilyProvider: SearchProvider = {
  name: "tavily",
  requiresApiKey: true,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    return runTavilySearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      onSuspiciousContent: params.onSuspiciousContent,
      days: typeof pc.days === "number" ? pc.days : undefined,
    });
  },
};

registerSearchProvider(tavilyProvider);
