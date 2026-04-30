// SPDX-License-Identifier: Apache-2.0
/**
 * Web Search Tool: Multi-provider web search orchestrator with fallback chain.
 *
 * Thin orchestrator that delegates to per-provider modules:
 * - web-search-brave.ts (Brave Search API)
 * - web-search-perplexity.ts (Perplexity / OpenRouter)
 * - web-search-grok.ts (xAI Responses API)
 * - web-search-duckduckgo.ts (DuckDuckGo HTML search)
 * - web-search-searxng.ts (SearXNG self-hosted metasearch)
 * - web-search-tavily.ts (Tavily AI Search API)
 * - web-search-exa.ts (Exa Neural Search API)
 * - web-search-jina.ts (Jina Reader Search API)
 *
 * Handles: parameter validation, cache, provider dispatch, fallback chain, factory.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import { wrapWebContent, type WrapExternalContentOptions } from "@comis/core";
import { fetchUrlContent } from "./web-fetch-tool.js";
import type { TTLCache } from "@comis/shared";
import {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  createWebCache,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
} from "./web-shared.js";
import { resolveSourceProfile } from "./tool-source-profiles.js";
import { getSearchProvider } from "./search-provider.js";
import { normalizeFreshness } from "./web-search-brave.js";
import {
  resolvePerplexityBaseUrl,
  resolvePerplexityRequestModel,
  DEFAULT_PERPLEXITY_MODEL,
} from "./web-search-perplexity.js";
import {
  extractGrokContent,
  DEFAULT_GROK_MODEL,
} from "./web-search-grok.js";

// Side-effect imports: each provider module self-registers into the searchProviders registry
import "./web-search-brave.js";
import "./web-search-duckduckgo.js";
import "./web-search-exa.js";
import "./web-search-grok.js";
import "./web-search-jina.js";
import "./web-search-perplexity.js";
import "./web-search-searxng.js";
import "./web-search-tavily.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type SearchProviderName = "brave" | "perplexity" | "grok" | "duckduckgo" | "searxng" | "tavily" | "exa" | "jina";

const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

/** Providers that support native time-range filtering. */
const FRESHNESS_PROVIDERS = new Set<SearchProviderName>(["brave", "duckduckgo", "tavily", "exa", "searxng"]);

/** Module-level search cache — lazily initialized by factory with resolved TTL. */
let searchCache: TTLCache<Record<string, unknown>> | undefined;

// ---------------------------------------------------------------------------
// Search result capping
// ---------------------------------------------------------------------------

interface SearchResultItem {
  title?: string;
  url?: string;
  description?: string;
  [key: string]: unknown;
}

interface CapResult {
  results: SearchResultItem[];
  totalResults: number;
  droppedCount: number;
  totalCharsBudget: number;
}

/**
 * Cap search results by total chars budget, dropping excess results by rank.
 *
 * Never truncates mid-result: either a result is included in full or dropped.
 * The first result is always included even if it exceeds the budget alone.
 */
function capSearchResults(
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
// Deep fetch constants
// ---------------------------------------------------------------------------

const MAX_DEEP_FETCH = 5;
const DEFAULT_DEEP_FETCH_MAX_CHARS_PER_PAGE = 10_000;
const DEFAULT_DEEP_FETCH_TIMEOUT_SECONDS = 15;

/**
 * Deep-fetch full content for top N search results in parallel.
 * Attaches `fullContent` (string | null) and `fetchError` (string | undefined) to each result.
 * Respects a per-page char limit. Only fetches results that have a `url` field.
 */
async function deepFetchResults(params: {
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
// Parameter schema
// ---------------------------------------------------------------------------

const WebSearchParams = Type.Object({
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
        "Override search provider for this call. Options: brave, perplexity, grok, duckduckgo, searxng, tavily, exa, jina. Default: use configured provider with fallback chain.",
    }),
  ),
});

type WebSearchParamsType = Static<typeof WebSearchParams>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WebSearchConfig {
  /** Search provider: "duckduckgo" (default), "brave", "perplexity", "grok", "searxng", "tavily", "exa", or "jina". */
  provider?: SearchProviderName;
  /** Primary API key (Brave Search subscription token). */
  apiKey?: string;
  /** Max results for Brave search (1-10, default 5). */
  maxResults?: number;
  /** Cache TTL in minutes (default 15). */
  cacheTtlMinutes?: number;
  /** Timeout for API calls in seconds (default 30). */
  timeoutSeconds?: number;
  /** Fallback providers tried in order when primary fails. Empty = no fallback. */
  fallbackProviders?: SearchProviderName[];
  /** Perplexity provider configuration. */
  perplexity?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  /** Grok (xAI) provider configuration. */
  grok?: {
    apiKey?: string;
    model?: string;
    inlineCitations?: boolean;
  };
  /** DuckDuckGo provider configuration (no API key needed). */
  duckduckgo?: Record<string, never>;
  /** SearXNG provider configuration. */
  searxng?: {
    baseUrl?: string;
  };
  /** Tavily provider configuration. */
  tavily?: {
    apiKey?: string;
  };
  /** Exa provider configuration. */
  exa?: {
    apiKey?: string;
  };
  /** Jina provider configuration. */
  jina?: {
    apiKey?: string;
  };
  /** Total chars budget for search result capping (default from web_search source profile). */
  totalCharsBudget?: number;
  /** Default deepFetch count when not specified by agent (default 0). */
  deepFetchDefault?: number;
  /** Per-page char limit for deep-fetched content (default 10000). */
  deepFetchMaxCharsPerPage?: number;
  /** Timeout in seconds for each deep fetch request (default 15). */
  deepFetchTimeoutSeconds?: number;
  /** Optional callback for suspicious content detection in external content. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
}

function resolveProvider(config?: WebSearchConfig): SearchProviderName {
  return parseProvider(config?.provider) ?? "duckduckgo";
}

/**
 * Parse a raw provider string into a valid SearchProvider or undefined.
 */
function parseProvider(raw: string | undefined): SearchProviderName | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  switch (trimmed) {
    case "brave": return "brave";
    case "perplexity": return "perplexity";
    case "grok": return "grok";
    case "duckduckgo":
    case "ddg": return "duckduckgo";
    case "searxng": return "searxng";
    case "tavily": return "tavily";
    case "exa": return "exa";
    case "jina": return "jina";
    default: return undefined;
  }
}

/**
 * Build the provider chain: primary first, then fallbacks (deduped).
 */
function buildProviderChain(
  primary: SearchProviderName,
  fallbacks: SearchProviderName[] | undefined,
): SearchProviderName[] {
  const chain: SearchProviderName[] = [primary];
  if (fallbacks) {
    for (const fb of fallbacks) {
      if (!chain.includes(fb)) chain.push(fb);
    }
  }
  return chain;
}

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
function mapFreshnessToProvider(
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
        const startDate = new Date(rangeMatch[1]);
        const now = new Date();
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
        const start = new Date();
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

/**
 * Resolve the API key for a given provider from config.
 * Returns undefined if the provider has no key configured.
 * DuckDuckGo needs no key (returns a sentinel). SearXNG needs no key but needs baseUrl.
 */
function resolveApiKey(provider: SearchProviderName, config: WebSearchConfig | undefined): string | undefined {
  switch (provider) {
    case "brave": return config?.apiKey;
    case "perplexity": return config?.perplexity?.apiKey;
    case "grok": return config?.grok?.apiKey;
    case "duckduckgo": return "no-key-needed";
    case "searxng": return config?.searxng?.baseUrl ? "no-key-needed" : undefined;
    case "tavily": return config?.tavily?.apiKey;
    case "exa": return config?.exa?.apiKey;
    case "jina": return config?.jina?.apiKey;
    default: return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future provider-specific error payloads
function missingApiKeyPayload(provider: SearchProviderName): Record<string, unknown> {
  const messages: Record<SearchProviderName, { error: string; message: string }> = {
    brave: {
      error: "missing_brave_api_key",
      message: "web_search needs a Brave Search API key. Configure tools.web.search.apiKey in your config.",
    },
    perplexity: {
      error: "missing_perplexity_api_key",
      message: "web_search (perplexity) needs an API key. Configure tools.web.search.perplexity.apiKey in your config.",
    },
    grok: {
      error: "missing_xai_api_key",
      message: "web_search (grok) needs an xAI API key. Configure tools.web.search.grok.apiKey in your config.",
    },
    duckduckgo: {
      error: "missing_duckduckgo_config",
      message: "web_search (duckduckgo) failed unexpectedly.",
    },
    searxng: {
      error: "missing_searxng_base_url",
      message: "web_search (searxng) needs a base URL. Configure tools.web.search.searxng.baseUrl in your config.",
    },
    tavily: {
      error: "missing_tavily_api_key",
      message: "web_search (tavily) needs an API key. Configure tools.web.search.tavily.apiKey in your config.",
    },
    exa: {
      error: "missing_exa_api_key",
      message: "web_search (exa) needs an API key. Configure tools.web.search.exa.apiKey in your config.",
    },
    jina: {
      error: "missing_jina_api_key",
      message: "web_search (jina) needs an API key. Configure tools.web.search.jina.apiKey in your config.",
    },
  };
  return messages[provider];
}

// ---------------------------------------------------------------------------
// Provider config + payload builders
// ---------------------------------------------------------------------------

/**
 * Build provider-specific configuration from the orchestrator params.
 * Passed to SearchProvider.execute() via the providerConfig escape hatch.
 */
function buildProviderConfig(params: {
  provider: SearchProviderName;
  config: WebSearchConfig | undefined;
  country?: string;
  search_lang?: string;
  freshness?: string;
  perplexityBaseUrl: string;
  perplexityModel: string;
  grokModel: string;
  grokInlineCitations: boolean;
}): Record<string, unknown> {
  const freshnessMapped = params.freshness
    ? mapFreshnessToProvider(params.provider, params.freshness)
    : {};

  switch (params.provider) {
    case "brave":
      return {
        country: params.country,
        search_lang: params.search_lang,
        ...freshnessMapped,
      };
    case "duckduckgo":
      return { ...freshnessMapped };
    case "tavily":
      return { ...freshnessMapped };
    case "exa":
      return { ...freshnessMapped };
    case "searxng":
      return {
        baseUrl: params.config?.searxng?.baseUrl ?? "",
        ...freshnessMapped,
      };
    case "perplexity":
      return {
        baseUrl: params.perplexityBaseUrl,
        model: params.perplexityModel,
      };
    case "grok":
      return {
        model: params.grokModel,
        inlineCitations: params.grokInlineCitations,
      };
    default:
      return {};
  }
}

/**
 * Build the orchestrator-level payload from raw provider results.
 * AI providers (perplexity, grok) get content wrapping; result providers
 * pass through with count metadata.
 */
function buildOrchestratorPayload(params: {
  provider: SearchProviderName;
  query: string;
  raw: Record<string, unknown>;
  start: number;
  perplexityModel: string;
  grokModel: string;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Record<string, unknown> {
  const tookMs = Date.now() - params.start;

  switch (params.provider) {
    case "perplexity":
      return {
        query: params.query,
        provider: params.provider,
        model: params.perplexityModel,
        tookMs,
        content: wrapWebContent(
          params.raw.content as string,
          undefined,
          params.onSuspiciousContent,
          false,
        ),
        citations: params.raw.citations,
      };
    case "grok":
      return {
        query: params.query,
        provider: params.provider,
        model: params.grokModel,
        tookMs,
        content: wrapWebContent(
          params.raw.content as string,
          undefined,
          params.onSuspiciousContent,
          false,
        ),
        citations: params.raw.citations,
        inlineCitations: params.raw.inlineCitations,
      };
    default:
      return {
        query: params.query,
        provider: params.provider,
        count: params.raw.count,
        tookMs,
        results: params.raw.results,
      };
  }
}

// ---------------------------------------------------------------------------
// Per-provider execution
// ---------------------------------------------------------------------------

/**
 * Execute a search against a single provider. Throws on any failure
 * (HTTP errors, missing keys, etc.) so the fallback loop can catch and continue.
 */
async function executeProviderSearch(params: {
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

  const start = Date.now();

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
async function executeWebSearch(params: {
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

  // Build provider chain: runtime override = single provider (no fallback)
  let chain: SearchProviderName[];
  if (runtimeProvider) {
    chain = [runtimeProvider];
  } else {
    chain = buildProviderChain(params.provider, params.config?.fallbackProviders);
  }

  const count = resolveSearchCount(
    params.rawParams.count ?? params.config?.maxResults,
    DEFAULT_SEARCH_COUNT,
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a web search tool with multi-provider support and fallback chain.
 *
 * @param config - Optional configuration for the search tool
 * @returns AgentTool implementing the web search interface
 */
export function createWebSearchTool(
  config?: WebSearchConfig,
): AgentTool<typeof WebSearchParams> {
  const onSuspiciousContent = config?.onSuspiciousContent;
  const searchProfile = resolveSourceProfile("web_search");
  const totalCharsBudget = config?.totalCharsBudget ?? searchProfile.maxChars;
  const provider = resolveProvider(config);
  const timeoutSeconds = resolveTimeoutSeconds(
    config?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const cacheTtlMs = resolveCacheTtlMs(
    config?.cacheTtlMinutes,
    DEFAULT_CACHE_TTL_MINUTES,
  );

  // Initialize module-level cache with resolved TTL (shared across factory calls)
  if (!searchCache) {
    searchCache = createWebCache<Record<string, unknown>>(cacheTtlMs);
  }

  const perplexityBaseUrl = resolvePerplexityBaseUrl(config);
  const perplexityModel = config?.perplexity?.model?.trim() || DEFAULT_PERPLEXITY_MODEL;
  const grokModel = config?.grok?.model?.trim() || DEFAULT_GROK_MODEL;
  const grokInlineCitations = config?.grok?.inlineCitations === true;
  const deepFetchDefault = config?.deepFetchDefault ?? 0;
  const deepFetchMaxCharsPerPage = config?.deepFetchMaxCharsPerPage ?? DEFAULT_DEEP_FETCH_MAX_CHARS_PER_PAGE;
  const deepFetchTimeoutSeconds = config?.deepFetchTimeoutSeconds ?? DEFAULT_DEEP_FETCH_TIMEOUT_SECONDS;

  const description =
    "Search the web with multi-provider fallback. deepFetch retrieves full page content inline.";

  return {
    name: "web_search",
    label: "Web Search",
    description,
    parameters: WebSearchParams,

    async execute(
      _toolCallId: string,
      params: WebSearchParamsType,
    ): Promise<AgentToolResult<unknown>> {
      return executeWebSearch({
        provider,
        config,
        query: params.query,
        rawParams: params,
        timeoutSeconds,
        cacheTtlMs,
        perplexityBaseUrl,
        perplexityModel,
        grokModel,
        grokInlineCitations,
        totalCharsBudget,
        deepFetchDefault,
        deepFetchMaxCharsPerPage,
        deepFetchTimeoutSeconds,
        onSuspiciousContent,
      });
    },
  };
}

/**
 * Exported for testing: clears the internal search cache.
 */
export function __clearSearchCache(): void {
  searchCache?.clear();
}

/**
 * Exported for testing internal utilities.
 * Re-exports provider helpers from their new module locations.
 */
export const __testing = {
  normalizeFreshness,
  resolvePerplexityBaseUrl: (config?: WebSearchConfig) => resolvePerplexityBaseUrl(config),
  resolvePerplexityRequestModel,
  extractGrokContent,
  resolveProvider: (config?: WebSearchConfig) => resolveProvider(config),
  parseProvider,
  buildProviderChain,
  capSearchResults,
  deepFetchResults,
  mapFreshnessToProvider,
} as const;
