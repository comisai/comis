// SPDX-License-Identifier: Apache-2.0
// @allow-throw: web-search SDK boundary wrapper; throws caught by web-search-tool dispatcher AgentTool wrapper.
/**
 * Web-search execution + output formatting.
 *
 * Owns:
 *   - Parameter schema (WebSearchParams + WebSearchParamsType)
 *   - Module-level cache state (searchCache) + initialization helper + reset
 *   - Per-provider execution wrapper (executeProviderSearch — runs against
 *     the SearchProvider registry, applies cap + deep-fetch + second cap pass)
 *   - Multi-provider orchestrator (executeWebSearch — fallback chain,
 *     freshness validation, content compaction for the LLM-facing payload)
 *
 * @module
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { systemNowMs, type WrapExternalContentOptions } from "@comis/core";
import type { TTLCache } from "@comis/shared";
import {
  normalizeCacheKey,
  createWebCache,
} from "../web-shared.js";
import { getSearchProvider } from "../search-provider.js";
import { normalizeFreshness } from "../web-search-brave.js";
import {
  capSearchResults,
  deepFetchResults,
  DEFAULT_DEEP_FETCH_MAX_CHARS_PER_PAGE,
  DEFAULT_DEEP_FETCH_TIMEOUT_SECONDS,
  MAX_DEEP_FETCH,
  type SearchResultItem,
} from "./web-search-normalization.js";
import {
  buildOrchestratorPayload,
  buildProviderChain,
  buildProviderConfig,
  FRESHNESS_PROVIDERS,
  MAX_SEARCH_COUNT,
  parseProvider,
  resolveApiKey,
  resolveConfiguredFallbackProviders,
  resolveSearchCount,
  type SearchProviderName,
  type WebSearchConfig,
} from "./web-search-providers.js";

// ---------------------------------------------------------------------------
// Module-level search cache — lazily initialized by factory with resolved TTL.
// ---------------------------------------------------------------------------

let searchCache: TTLCache<Record<string, unknown>> | undefined;

/** Initialize the module-level cache once. Subsequent calls are no-ops. */
export function ensureSearchCache(cacheTtlMs: number): void {
  if (!searchCache) {
    searchCache = createWebCache<Record<string, unknown>>(cacheTtlMs);
  }
}

/**
 * Exported for testing: clears the internal search cache.
 */
export function __clearSearchCache(): void {
  searchCache?.clear();
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  deepFetch: Type.Optional(
    Type.Number({
      description: "Number of top results to auto-fetch full content for (0-5). When > 0, fetches the top N result pages and includes their full content inline. Saves a separate web_fetch call. Default: 0 (snippets only).",
      minimum: 0,
      maximum: 5,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  freshness: Type.Optional(
    Type.Union([
      Type.Literal("pd"),
      Type.Literal("pw"),
      Type.Literal("pm"),
      Type.Literal("py"),
      Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}to\\d{4}-\\d{2}-\\d{2}$" }),
    ], {
      description:
        "Filter results by discovery time. Supported by: Brave, DuckDuckGo, Tavily, Exa, SearXNG. Shortcuts: 'pd' (past day/24h), 'pw' (past week), 'pm' (past month), 'py' (past year). Date range 'YYYY-MM-DDtoYYYY-MM-DD' supported by Brave, Tavily, and Exa. Ignored by grok, perplexity, jina.",
    }),
  ),
  provider: Type.Optional(
    Type.String({
      description:
        "Select the first search provider for this call. Options: brave, perplexity, grok, duckduckgo, searxng, tavily, exa, jina. Eligible configured fallbacks remain active.",
    }),
  ),
});

export type WebSearchParamsType = Static<typeof WebSearchParams>;

// ---------------------------------------------------------------------------
// Per-provider execution
// ---------------------------------------------------------------------------

/**
 * Execute a search against a single provider. Throws on any failure
 * (HTTP errors, missing keys, etc.) so the fallback loop can catch and continue.
 */
export async function executeProviderSearch(params: {
  provider: SearchProviderName;
  config: WebSearchConfig | undefined;
  query: string;
  count: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
  perplexityBaseUrl: string;
  perplexityModel: string;
  grokModel: string;
  grokInlineCitations: boolean;
  totalCharsBudget: number;
  deepFetchCount?: number;
  deepFetchMaxCharsPerPage?: number;
  deepFetchTimeoutSeconds?: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<Record<string, unknown>> {
  const apiKey = resolveApiKey(params.provider, params.config);
  if (!apiKey) {
    throw new Error("missing_api_key");
  }

  const cacheKey = normalizeCacheKey(
    `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.freshness || "default"}`,
  );
  const cached = searchCache?.get(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const start = systemNowMs();

  // Build provider-specific config for the providerConfig escape hatch
  const providerConfig = buildProviderConfig(params);

  // Look up provider in the registry
  const searchProvider = getSearchProvider(params.provider);
  if (!searchProvider) {
    throw new Error(`Unknown search provider: ${params.provider}`);
  }

  // Execute via the SearchProvider interface
  const raw = await searchProvider.execute({
    query: params.query,
    count: params.count,
    apiKey,
    timeoutSeconds: params.timeoutSeconds,
    onSuspiciousContent: params.onSuspiciousContent,
    providerConfig,
  });

  // Build the orchestrator payload with common fields + provider-specific result
  const payload = buildOrchestratorPayload({
    provider: params.provider,
    query: params.query,
    raw,
    start,
    perplexityModel: params.perplexityModel,
    grokModel: params.grokModel,
    onSuspiciousContent: params.onSuspiciousContent,
  });

  // Cap search results by total chars budget — first pass (snippets only)
  if (Array.isArray(payload.results)) {
    const capInfo = capSearchResults(
      payload.results as SearchResultItem[],
      params.totalCharsBudget,
    );
    if (capInfo.droppedCount > 0) {
      payload.results = capInfo.results;
      payload.count = capInfo.results.length;
      payload.resultsCapped = true;
      payload.resultsCappedMessage = `Showing ${capInfo.results.length} of ${capInfo.totalResults} results (${capInfo.droppedCount} dropped, budget: ${capInfo.totalCharsBudget} chars)`;
    }
  }

  // Deep fetch: fetch full content for top N results (if requested)
  const deepFetchCount = params.deepFetchCount ?? 0;
  if (deepFetchCount > 0 && Array.isArray(payload.results)) {
    payload.results = await deepFetchResults({
      results: payload.results as SearchResultItem[],
      count: deepFetchCount,
      maxCharsPerPage: params.deepFetchMaxCharsPerPage ?? DEFAULT_DEEP_FETCH_MAX_CHARS_PER_PAGE,
      timeoutSeconds: params.deepFetchTimeoutSeconds ?? DEFAULT_DEEP_FETCH_TIMEOUT_SECONDS,
      onSuspiciousContent: params.onSuspiciousContent,
    });
    payload.deepFetched = Math.min(
      deepFetchCount,
      (payload.results as SearchResultItem[]).filter(r => r.fullContent != null).length,
    );

    // Second cap pass — fullContent adds significant chars, re-enforce budget
    const capInfo2 = capSearchResults(
      payload.results as SearchResultItem[],
      params.totalCharsBudget,
    );
    if (capInfo2.droppedCount > 0) {
      payload.results = capInfo2.results;
      payload.count = capInfo2.results.length;
      payload.resultsCapped = true;
      payload.resultsCappedMessage = `Showing ${capInfo2.results.length} of ${capInfo2.totalResults} results (${capInfo2.droppedCount} dropped after deep fetch, budget: ${capInfo2.totalCharsBudget} chars)`;
    }
  }

  searchCache?.set(cacheKey, payload);
  return payload;
}

// ---------------------------------------------------------------------------
// Main execution with fallback chain
// ---------------------------------------------------------------------------

/**
 * Execute a web search with fallback chain support.
 * Tries each provider in the chain until one succeeds, collecting failures.
 */
export async function executeWebSearch(params: {
  provider: SearchProviderName;
  config: WebSearchConfig | undefined;
  query: string;
  rawParams: WebSearchParamsType;
  timeoutSeconds: number;
  cacheTtlMs: number;
  perplexityBaseUrl: string;
  perplexityModel: string;
  grokModel: string;
  grokInlineCitations: boolean;
  totalCharsBudget: number;
  deepFetchDefault: number;
  deepFetchMaxCharsPerPage: number;
  deepFetchTimeoutSeconds: number;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Promise<AgentToolResult<unknown>> {
  // Parse runtime provider override
  const runtimeProvider = parseProvider(params.rawParams.provider);
  if (params.rawParams.provider && !runtimeProvider) {
    const errorPayload = {
      error: "invalid_provider",
      message: `Invalid provider "${params.rawParams.provider}". Valid options: brave, perplexity, grok, duckduckgo, searxng, tavily, exa, jina.`,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }],
      details: errorPayload,
    };
  }

  // A per-call provider selects the primary without weakening the fallback
  // contract. Only an explicit empty fallbackProviders list disables failover.
  const primaryProvider = runtimeProvider ?? params.provider;
  const configuredFallbacks = params.config?.fallbackProviders
    ?? resolveConfiguredFallbackProviders(primaryProvider, params.config);
  const eligibleFallbacks = configuredFallbacks.filter((provider) => {
    const authority = resolveApiKey(provider, params.config);
    return typeof authority === "string" && authority.trim().length > 0;
  });
  const chain = buildProviderChain(primaryProvider, eligibleFallbacks);

  const count = resolveSearchCount(
    params.rawParams.count ?? params.config?.maxResults,
    params.config?.maxResults ?? 5,
  );
  const deepFetchCount = Math.max(0, Math.min(MAX_DEEP_FETCH,
    Math.floor(typeof params.rawParams.deepFetch === "number" ? params.rawParams.deepFetch : params.deepFetchDefault)
  ));
  const country = params.rawParams.country;
  const search_lang = params.rawParams.search_lang;
  const rawFreshness = params.rawParams.freshness;

  // Freshness validation: ignored (not error) for providers without time-range support
  let freshnessIgnored = false;
  if (rawFreshness && !chain.some(p => FRESHNESS_PROVIDERS.has(p))) {
    freshnessIgnored = true;
  }

  const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
  if (rawFreshness && !freshness) {
    const errorPayload = {
      error: "invalid_freshness",
      message:
        "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }],
      details: errorPayload,
    };
  }

  // Execute fallback chain
  const failures: string[] = [];
  for (const p of chain) {
    try {
      const result = await executeProviderSearch({
        provider: p,
        config: params.config,
        query: params.query,
        count,
        timeoutSeconds: params.timeoutSeconds,
        cacheTtlMs: params.cacheTtlMs,
        country,
        search_lang,
        freshness: FRESHNESS_PROVIDERS.has(p) ? freshness : undefined,
        perplexityBaseUrl: params.perplexityBaseUrl,
        perplexityModel: params.perplexityModel,
        grokModel: params.grokModel,
        grokInlineCitations: params.grokInlineCitations,
        totalCharsBudget: params.totalCharsBudget,
        deepFetchCount,
        deepFetchMaxCharsPerPage: params.deepFetchMaxCharsPerPage,
        deepFetchTimeoutSeconds: params.deepFetchTimeoutSeconds,
        onSuspiciousContent: params.onSuspiciousContent,
      });

      if (freshnessIgnored) {
        result.freshnessIgnored = true;
        result.freshnessNote = "freshness filter was requested but ignored — not supported by this provider. Supported providers: brave, duckduckgo, tavily, exa, searxng.";
      }

      // Strip fullContent from LLM-facing content to prevent microcompaction
      // offloading. Deep-fetched article text inflates results to 24K+ chars;
      // the model can web_fetch individual URLs if it needs full article text.
      // Full content remains available in `details` for programmatic consumers.
      const compact = Array.isArray(result.results)
        ? {
            ...result,
            results: (result.results as Record<string, unknown>[]).map(
              ({ fullContent: _fc, ...rest }) => rest,
            ),
          }
        : result;

      return {
        content: [{ type: "text", text: JSON.stringify(compact, null, 2) }],
        details: result,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${p}: ${msg}`);
      continue;
    }
  }

  // All providers failed
  const errorPayload = {
    error: "all_providers_failed",
    message: `All web_search providers failed: ${failures.join(" | ")}`,
    failures,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(errorPayload, null, 2) }],
    details: errorPayload,
  };
}
