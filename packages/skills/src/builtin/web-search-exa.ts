// SPDX-License-Identifier: Apache-2.0
/**
 * Exa Neural Search API provider for the web_search tool.
 *
 * Uses the Exa search endpoint with x-api-key header authentication.
 * Returns structured results with optional summary/text fields.
 *
 * @module
 */

import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExaResult = {
  title?: string;
  url?: string;
  summary?: string;
  text?: string;
};

type ExaResponse = {
  results?: ExaResult[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXA_ENDPOINT = "https://api.exa.ai/search";

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using the Exa Neural Search API.
 * Uses x-api-key header for authentication.
 */
export async function runExaSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  startPublishedDate?: string;
  endPublishedDate?: string;
}): Promise<{ results: Array<{ title: string; url: string; description: string }>; count: number }> {
  const requestBody: Record<string, unknown> = {
    query: params.query,
    numResults: params.count,
  };
  if (params.startPublishedDate) {
    requestBody.startPublishedDate = params.startPublishedDate;
  }
  if (params.endPublishedDate) {
    requestBody.endPublishedDate = params.endPublishedDate;
  }
  const res = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": params.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`Exa API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as ExaResponse;
  const rawResults = Array.isArray(data.results) ? data.results : [];

  const results = rawResults.slice(0, params.count).map((entry) => {
    const title = entry.title ?? "";
    const description = entry.summary ?? entry.text ?? "";
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

/** Exa Neural Search provider descriptor for registry-based dispatch. */
export const exaProvider: SearchProvider = {
  name: "exa",
  requiresApiKey: true,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    return runExaSearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      onSuspiciousContent: params.onSuspiciousContent,
      startPublishedDate: pc.startPublishedDate as string | undefined,
      endPublishedDate: pc.endPublishedDate as string | undefined,
    });
  },
};

registerSearchProvider(exaProvider);
