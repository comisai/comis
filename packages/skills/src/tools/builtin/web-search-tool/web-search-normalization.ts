// SPDX-License-Identifier: Apache-2.0
/**
 * Web-search result normalization helpers (Phase 43 split per FILE-SPLIT-11).
 *
 * Extracted from the pre-split web-search-tool.ts monolith. Owns:
 *   - Result-shape interfaces (SearchResultItem, CapResult)
 *   - Result capping by char budget (capSearchResults)
 *   - Deep-fetch helper (deepFetchResults — fetches top N pages' full content)
 *   - Freshness → provider-native parameter mapping (mapFreshnessToProvider)
 *
 * No I/O state lives here — the module is pure transformations + a single
 * Promise-returning deepFetch helper that defers I/O to `fetchUrlContent`.
 *
 * @module
 */

import { systemDateFrom, systemNowDate, type WrapExternalContentOptions } from "@comis/core";
import { fetchUrlContent } from "../web-fetch-tool.js";

// ---------------------------------------------------------------------------
// Provider name (canonical union shared with web-search-providers.ts).
// Lives here because mapFreshnessToProvider is keyed by it; moving it to the
// "lower" layer breaks the would-be cycle (normalization → providers →
// normalization) flagged by no-cycles.test.ts.
// ---------------------------------------------------------------------------

export type SearchProviderName = "brave" | "perplexity" | "grok" | "duckduckgo" | "searxng" | "tavily" | "exa" | "jina";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SearchResultItem {
  title?: string;
  url?: string;
  description?: string;
  [key: string]: unknown;
}

export interface CapResult {
  results: SearchResultItem[];
  totalResults: number;
  droppedCount: number;
  totalCharsBudget: number;
}

// ---------------------------------------------------------------------------
// Result capping
// ---------------------------------------------------------------------------

/**
 * Cap search results by total chars budget, dropping excess results by rank.
 *
 * Never truncates mid-result: either a result is included in full or dropped.
 * The first result is always included even if it exceeds the budget alone.
 */
export function capSearchResults(
  results: SearchResultItem[],
  totalCharsBudget: number,
): CapResult {
  let totalChars = 0;
  const capped: SearchResultItem[] = [];
  const totalResults = results.length;

  for (const result of results) {
    const resultChars = (result.title?.length ?? 0)
      + (result.description?.length ?? 0)
      + (result.url?.length ?? 0)
      + (typeof result.fullContent === "string" ? result.fullContent.length : 0);

    if (totalChars + resultChars > totalCharsBudget && capped.length > 0) {
      break; // Drop remaining by rank, never truncate mid-result
    }

    capped.push(result);
    totalChars += resultChars;
  }

  return {
    results: capped,
    totalResults,
    droppedCount: totalResults - capped.length,
    totalCharsBudget,
  };
}

// ---------------------------------------------------------------------------
// Deep-fetch
// ---------------------------------------------------------------------------

export const MAX_DEEP_FETCH = 5;
export const DEFAULT_DEEP_FETCH_MAX_CHARS_PER_PAGE = 10_000;
export const DEFAULT_DEEP_FETCH_TIMEOUT_SECONDS = 15;

/**
 * Deep-fetch full content for top N search results in parallel.
 * Attaches `fullContent` (string | null) and `fetchError` (string | undefined) to each result.
 * Respects a per-page char limit. Only fetches results that have a `url` field.
 */
export async function deepFetchResults(params: {
  results: SearchResultItem[];
  count: number;
  maxCharsPerPage: number;
  timeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<SearchResultItem[]> {
  // Clone results to avoid mutation
  const output = params.results.map(r => ({ ...r }));

  // Pick top N results that have URLs
  const fetchTargets: { index: number; url: string }[] = [];
  for (let i = 0; i < output.length && fetchTargets.length < params.count; i++) {
    const url = output[i].url;
    if (typeof url === "string" && url.startsWith("http")) {
      fetchTargets.push({ index: i, url });
    }
  }

  if (fetchTargets.length === 0) return output;

  // Fetch all in parallel
  const settled = await Promise.allSettled(
    fetchTargets.map(t =>
      fetchUrlContent({
        url: t.url,
        extractMode: "markdown",
        maxChars: params.maxCharsPerPage,
        timeoutSeconds: params.timeoutSeconds,
        readabilityEnabled: true,
        onSuspiciousContent: params.onSuspiciousContent,
      })
    )
  );

  // Attach results
  for (let i = 0; i < fetchTargets.length; i++) {
    const target = fetchTargets[i];
    const result = settled[i];
    if (result.status === "fulfilled") {
      const fetched = result.value;
      if (fetched.error) {
        output[target.index].fullContent = null;
        output[target.index].fetchError = fetched.error;
      } else {
        output[target.index].fullContent = fetched.text ?? null;
        output[target.index].fetchTitle = fetched.title;
      }
    } else {
      output[target.index].fullContent = null;
      output[target.index].fetchError = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Freshness mapping
// ---------------------------------------------------------------------------

/**
 * Map a normalized Brave-format freshness value to provider-native parameters.
 * Returns a Record that gets merged into providerConfig for each provider.
 *
 * Mapping:
 * - brave: { freshness: "pd"|"pw"|"pm"|"py"|"YYYY-MM-DDtoYYYY-MM-DD" }
 * - duckduckgo: { df: "d"|"w"|"m"|"y" } (no custom range support)
 * - tavily: { days: 1|7|30|365 } (custom range approximated as day diff)
 * - exa: { startPublishedDate: ISO8601, endPublishedDate?: ISO8601 }
 * - searxng: { time_range: "day"|"week"|"month"|"year" } (no custom range support)
 * - others: {} (unsupported)
 */
export function mapFreshnessToProvider(
  provider: SearchProviderName,
  freshness: string,
): Record<string, unknown> {
  switch (provider) {
    case "brave":
      return { freshness };

    case "duckduckgo": {
      const ddgMap: Record<string, string> = { pd: "d", pw: "w", pm: "m", py: "y" };
      const df = ddgMap[freshness];
      return df ? { df } : {}; // Custom date ranges not supported by DDG
    }

    case "tavily": {
      const tavilyMap: Record<string, number> = { pd: 1, pw: 7, pm: 30, py: 365 };
      const days = tavilyMap[freshness];
      if (days !== undefined) return { days };
      // Custom range: compute days between start and today
      const rangeMatch = freshness.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
      if (rangeMatch) {
        const startDate = systemDateFrom(rangeMatch[1]);
        const now = systemNowDate();
        const diffMs = now.getTime() - startDate.getTime();
        const diffDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
        return { days: diffDays };
      }
      return {};
    }

    case "exa": {
      const exaShortcutMap: Record<string, number> = { pd: 1, pw: 7, pm: 30, py: 365 };
      const daysBack = exaShortcutMap[freshness];
      if (daysBack !== undefined) {
        const start = systemNowDate();
        start.setUTCDate(start.getUTCDate() - daysBack);
        return { startPublishedDate: start.toISOString().split("T")[0] + "T00:00:00.000Z" };
      }
      // Custom range: map directly
      const rangeMatch = freshness.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
      if (rangeMatch) {
        return {
          startPublishedDate: rangeMatch[1] + "T00:00:00.000Z",
          endPublishedDate: rangeMatch[2] + "T23:59:59.999Z",
        };
      }
      return {};
    }

    case "searxng": {
      const searxMap: Record<string, string> = { pd: "day", pw: "week", pm: "month", py: "year" };
      const time_range = searxMap[freshness];
      return time_range ? { time_range } : {}; // Custom date ranges not supported by SearXNG
    }

    default:
      return {};
  }
}
