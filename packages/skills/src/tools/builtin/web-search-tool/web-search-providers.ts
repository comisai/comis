// SPDX-License-Identifier: Apache-2.0
/**
 * Web-search provider dispatch.
 *
 * Owns:
 *   - WebSearchConfig public type
 *   - SearchProviderName alias + FRESHNESS_PROVIDERS allow-set
 *   - Provider-name parsing and chain assembly (parseProvider, buildProviderChain, resolveProvider)
 *   - Per-provider key resolution (resolveApiKey); missingApiKeyPayload is
 *     declared locally and reserved for future use (carries forward the
 *     dead-code stash with its eslint-disable directive).
 *   - Provider config + orchestrator payload builders (buildProviderConfig, buildOrchestratorPayload)
 *   - Per-call count clamping (resolveSearchCount)
 *
 * No I/O. No module-level mutable state. Pure helpers consumed by
 * web-search-formatting.ts's executeProviderSearch / executeWebSearch.
 *
 * @module
 */

import { systemNowMs, type WrapExternalContentOptions, wrapWebContent } from "@comis/core";
import {
  mapFreshnessToProvider,
  type SearchProviderName,
} from "./web-search-normalization.js";

// Re-export so consumers (formatting.ts, index.ts) keep their canonical
// import site on web-search-providers.ts.
export type { SearchProviderName } from "./web-search-normalization.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SEARCH_COUNT = 5;
export const MAX_SEARCH_COUNT = 10;

/** Providers that support native time-range filtering. */
export const FRESHNESS_PROVIDERS = new Set<SearchProviderName>(["brave", "duckduckgo", "tavily", "exa", "searxng"]);

/**
 * Stable order for automatically discovered fallback providers. DuckDuckGo is
 * the keyless default primary; the remaining providers enter the automatic
 * chain only when their credential or endpoint is configured.
 */
const AUTOMATIC_FALLBACK_PROVIDER_ORDER: readonly SearchProviderName[] = [
  "brave",
  "perplexity",
  "tavily",
  "exa",
  "jina",
  "grok",
  "searxng",
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// @optional-field-count: (b) Cluster-split candidate. User-facing search-tool config — each `?` is either (i) a top-level setting (provider, apiKey, maxResults, timeoutSeconds, cacheTtlMinutes, fallbackProviders, deepFetch*, totalCharsBudget) or (ii) a per-provider sub-config (perplexity, grok, duckduckgo, searxng, tavily, exa, jina) that is undefined unless the user selected that provider. Future refactor: move per-provider configs into a discriminated-union providers field keyed by provider name.
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
  /** Fallback providers tried in order when primary fails. Undefined discovers
   *  configured providers automatically; an empty array disables fallback. */
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

export function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
}

export function resolveProvider(config?: WebSearchConfig): SearchProviderName {
  return parseProvider(config?.provider) ?? "duckduckgo";
}

/**
 * Parse a raw provider string into a valid SearchProvider or undefined.
 */
export function parseProvider(raw: string | undefined): SearchProviderName | undefined {
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
export function buildProviderChain(
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
 * Resolve the API key for a given provider from config.
 * Returns undefined if the provider has no key configured.
 * DuckDuckGo needs no key (returns a sentinel). SearXNG needs no key but needs baseUrl.
 */
export function resolveApiKey(provider: SearchProviderName, config: WebSearchConfig | undefined): string | undefined {
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

/**
 * Resolve the implicit fallback chain from configured provider authority.
 *
 * A provider with no API key (or no SearXNG endpoint) is omitted instead of
 * producing a guaranteed authentication failure. Runtime failures from the
 * remaining providers are handled sequentially by the search orchestrator.
 */
export function resolveConfiguredFallbackProviders(
  primary: SearchProviderName,
  config: WebSearchConfig | undefined,
): SearchProviderName[] {
  return AUTOMATIC_FALLBACK_PROVIDER_ORDER.filter((provider) => {
    if (provider === primary) return false;
    const authority = resolveApiKey(provider, config);
    return typeof authority === "string" && authority.trim().length > 0;
  });
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
export function buildProviderConfig(params: {
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
export function buildOrchestratorPayload(params: {
  provider: SearchProviderName;
  query: string;
  raw: Record<string, unknown>;
  start: number;
  perplexityModel: string;
  grokModel: string;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
}): Record<string, unknown> {
  const tookMs = systemNowMs() - params.start;

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
