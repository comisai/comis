/**
 * Brave Search provider implementation for the web_search tool.
 *
 * Extracts Brave-specific types, constants, helpers, and the `runBraveSearch()`
 * function from the monolithic web-search-tool.ts orchestrator.
 *
 * @module
 */

import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
export const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Normalize a freshness filter value for Brave Search.
 * Accepts shortcuts (pd, pw, pm, py) or ISO date ranges (YYYY-MM-DDtoYYYY-MM-DD).
 * Returns undefined for invalid/empty values.
 */
export function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }
  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }
  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }
  return `${start}to${end}`;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using the Brave Search API.
 * Returns structured results with content wrapping applied.
 */
export async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
  /** Optional callback for suspicious content detection. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<Record<string, unknown>> {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];

  return {
    results: results.map((entry) => {
      const description = entry.description ?? "";
      const title = entry.title ?? "";
      const entryUrl = entry.url ?? "";
      return {
        title: title ? wrapWebContent(title, "web_search", params.onSuspiciousContent, false) : "",
        url: entryUrl, // Keep raw for tool chaining
        description: description ? wrapWebContent(description, "web_search", params.onSuspiciousContent, false) : "",
        published: entry.age || undefined,
        siteName: resolveSiteName(entryUrl) || undefined,
      };
    }),
    count: results.length,
  };
}

// ---------------------------------------------------------------------------
// SearchProvider descriptor
// ---------------------------------------------------------------------------

/** Brave Search provider descriptor for registry-based dispatch. */
export const braveProvider: SearchProvider = {
  name: "brave",
  requiresApiKey: true,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    return runBraveSearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      country: pc.country as string | undefined,
      search_lang: pc.search_lang as string | undefined,
      freshness: pc.freshness as string | undefined,
      onSuspiciousContent: params.onSuspiciousContent,
    });
  },
};

registerSearchProvider(braveProvider);
