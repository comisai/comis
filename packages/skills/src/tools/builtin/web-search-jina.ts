// SPDX-License-Identifier: Apache-2.0
/**
 * Jina Reader Search API provider for the web_search tool.
 *
 * Uses the Jina search endpoint with Bearer auth and JSON response format.
 * The query is URL-path-encoded (not query-string encoded).
 *
 * @module
 */

import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JinaDataItem = {
  title?: string;
  url?: string;
  description?: string;
  content?: string;
};

type JinaResponse = {
  data?: JinaDataItem[];
  code?: number;
  message?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JINA_ENDPOINT = "https://s.jina.ai/";

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using the Jina Reader Search API.
 * Uses Bearer auth with JSON response format.
 */
export async function runJinaSearch(params: {
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<{ results: Array<{ title: string; url: string; description: string }>; count: number }> {
  const encodedQuery = encodeURIComponent(params.query);
  const url = `${JINA_ENDPOINT}${encodedQuery}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "X-Return-Format": "json",
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`Jina API error (${res.status}): ${detail || res.statusText}`);
  }

  const text = await res.text();
  let data: JinaResponse;
  try {
    data = JSON.parse(text) as JinaResponse;
  } catch {
    // Jina sometimes returns plain text -- return as single result
    return {
      results: [
        {
          title: wrapWebContent("Search Result", "web_search", params.onSuspiciousContent, false),
          url: url,
          description: text
            ? wrapWebContent(text.slice(0, 2000), "web_search", params.onSuspiciousContent, false)
            : "",
        },
      ],
      count: 1,
    };
  }

  // Detect API error payloads
  if (data.code && data.code >= 400 && data.message) {
    throw new Error(`Jina API error (${data.code}): ${data.message}`);
  }

  const rawResults = Array.isArray(data.data) ? data.data : [];

  const results = rawResults.map((entry) => {
    const title = entry.title ?? "";
    const description = entry.description ?? entry.content ?? "";
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

/** Jina Reader Search provider descriptor for registry-based dispatch. */
export const jinaProvider: SearchProvider = {
  name: "jina",
  requiresApiKey: true,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    return runJinaSearch({
      query: params.query,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      onSuspiciousContent: params.onSuspiciousContent,
    });
  },
};

registerSearchProvider(jinaProvider);
