// SPDX-License-Identifier: Apache-2.0
/**
 * SearchProvider interface and registry for the web_search tool.
 *
 * Formalizes the implicit contract across 8 search providers into a typed
 * interface with registry-based dispatch. Each provider exports a
 * `SearchProvider` descriptor; the web-search-tool orchestrator dispatches
 * via the registry instead of individual imports.
 *
 * Two provider categories exist:
 * - **Result providers** (Brave, DuckDuckGo, SearXNG, Tavily, Exa, Jina):
 *   return structured `{ results, count }` with per-result title/url/description.
 * - **AI providers** (Perplexity, Grok): return synthesized `{ content, citations }`
 *   with optional inline citations.
 *
 * The `execute` function returns a generic `Record<string, unknown>` payload
 * that the orchestrator passes through unchanged, preserving provider-specific
 * fields (e.g. Brave's `published`/`siteName`, Grok's `inlineCitations`).
 *
 * @module
 */

import type { WrapExternalContentOptions } from "@comis/core";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Common configuration passed to every search provider's execute function.
 * Provider-specific params (e.g., Brave's `freshness`, Grok's `inlineCitations`)
 * are passed via the `providerConfig` escape hatch.
 */
export interface SearchProviderParams {
  /** The search query string. */
  query: string;
  /** Number of results to return. */
  count: number;
  /** API key for the provider (may be "no-key-needed" for keyless providers). */
  apiKey: string;
  /** Timeout for the HTTP request in seconds. */
  timeoutSeconds: number;
  /** Optional callback for suspicious content detection. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /**
   * Provider-specific configuration. Each provider reads only the keys it
   * needs and ignores the rest. Avoids polluting the common interface with
   * provider-specific fields.
   */
  providerConfig?: Record<string, unknown>;
}

/**
 * Descriptor for a single search provider.
 *
 * Each `web-search-xxx.ts` module exports a `SearchProvider` that the
 * `searchProviders` registry collects. The orchestrator looks up the provider
 * by name and calls `execute(params)`.
 */
export interface SearchProvider {
  /** Provider name matching the SearchProviderName union in web-search-tool. */
  readonly name: string;
  /** Whether this provider requires an API key to function. */
  readonly requiresApiKey: boolean;
  /**
   * Execute a search and return a payload. The shape varies by provider:
   * - Result providers return `{ results: [...], count: N }`.
   * - AI providers return `{ content: "...", citations: [...] }`.
   * The orchestrator passes the payload through unchanged.
   */
  execute(params: SearchProviderParams): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registry of all search providers, keyed by provider name.
 * Populated by importing provider modules at the bottom of this file.
 *
 * Use `getSearchProvider(name)` for safe lookup.
 */
export const searchProviders = new Map<string, SearchProvider>();

/**
 * Register a search provider in the global registry.
 * Called by each provider module to self-register.
 */
export function registerSearchProvider(provider: SearchProvider): void {
  searchProviders.set(provider.name, provider);
}

/**
 * Look up a search provider by name.
 * Returns undefined if the provider is not registered.
 */
export function getSearchProvider(name: string): SearchProvider | undefined {
  return searchProviders.get(name);
}
