// SPDX-License-Identifier: Apache-2.0
/**
 * Web search tool module.
 *
 * Barrel + thin createWebSearchTool factory. The factory body delegates to:
 *   - `executeWebSearch` (web-search-formatting.ts) — orchestrator
 *   - `executeProviderSearch` (web-search-formatting.ts) — per-provider call
 *   - Provider helpers (web-search-providers.ts) — config / chain / parsing
 *   - Result normalization (web-search-normalization.ts) — cap / deep-fetch / freshness
 *
 * No aliases — every export keeps its canonical name.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { registerActivityLabelSpec } from "@comis/core";
import {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CACHE_TTL_MINUTES,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
} from "../web-shared.js";
import { resolveSourceProfile } from "../tool-source-profiles.js";
import { normalizeFreshness } from "../web-search-brave.js";
import {
  resolvePerplexityBaseUrl,
  resolvePerplexityRequestModel,
  DEFAULT_PERPLEXITY_MODEL,
} from "../web-search-perplexity.js";
import {
  extractGrokContent,
  DEFAULT_GROK_MODEL,
} from "../web-search-grok.js";

// Side-effect imports: each provider module self-registers into the searchProviders registry
import "../web-search-brave.js";
import "../web-search-duckduckgo.js";
import "../web-search-exa.js";
import "../web-search-grok.js";
import "../web-search-jina.js";
import "../web-search-perplexity.js";
import "../web-search-searxng.js";
import "../web-search-tavily.js";

import {
  buildProviderChain,
  parseProvider,
  resolveProvider,
  type WebSearchConfig,
} from "./web-search-providers.js";
import {
  capSearchResults,
  deepFetchResults,
  DEFAULT_DEEP_FETCH_MAX_CHARS_PER_PAGE,
  DEFAULT_DEEP_FETCH_TIMEOUT_SECONDS,
  mapFreshnessToProvider,
} from "./web-search-normalization.js";
import {
  __clearSearchCache,
  ensureSearchCache,
  executeWebSearch,
  WebSearchParams,
  type WebSearchParamsType,
} from "./web-search-formatting.js";

// Activity label spec. The EMITTED name
// uses an UNDERSCORE — `name: "web_search"` —
// while the file basename is hyphenated. The `{query}`
// placeholder is allowlisted via detailKeys; LLM-supplied search queries
// pass through redactValue (a query containing a secret-shape token renders
// as `<redacted>`).
registerActivityLabelSpec("web_search", {
  semanticPhase: "tool",
  label: "searching the web for {query}",
  detailKeys: ["query"],
});

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export type { WebSearchConfig } from "./web-search-providers.js";
export { __clearSearchCache } from "./web-search-formatting.js";

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
  ensureSearchCache(cacheTtlMs);

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
