// SPDX-License-Identifier: Apache-2.0
/**
 * buildWebSearchConfig / buildLinkConfig / buildDocExtractionConfig — shared helpers
 * for the WEB scenario tests.
 *
 * These return REAL @comis product config OBJECTS (not temp YAML files, unlike
 * media-config.ts) because the WEB scenarios drive product FUNCTIONS
 * directly (createWebSearchTool / createLinkRunner / createFileExtractor) rather
 * than a booted daemon.
 *
 * CRITICAL — export-surface fidelity:
 *   - `WebSearchConfig` is NOT exported by `@comis/core` or the `@comis/skills`
 *     barrel (skills/index.ts uses a NAMED `export { createWebSearchTool, … }`,
 *     not `export *`). So it is derived here from the PUBLIC tool signature:
 *     `NonNullable<Parameters<typeof createWebSearchTool>[0]>` — the exact real
 *     shape with zero invented import. (createWebSearchTool is imported ONLY to
 *     derive the type; buildWebSearchConfig never calls it.)
 *   - `LinkUnderstandingConfig` + `FileExtractionConfig` + `FileExtractionConfigSchema`
 *     ARE exported by `@comis/core` (via exports/config.js) — imported normally.
 *   - The per-provider API-key field differs by provider (verified against the
 *     web-search-providers.ts key-resolution helper): brave→`apiKey`; tavily/exa/
 *     perplexity/grok/jina→`<provider>.apiKey`; searxng→`searxng.baseUrl`; duckduckgo→`{}`.
 *
 * Mirrors the file layout / JSDoc of test/live/harness/media-config.ts.
 *
 * @module
 */

import { FileExtractionConfigSchema } from "@comis/core";
import type { LinkUnderstandingConfig, FileExtractionConfig } from "@comis/core";
import { createWebSearchTool } from "@comis/skills";

/**
 * The real public WebSearchConfig type, derived from createWebSearchTool's
 * signature (it is not exported by any barrel). createWebSearchTool is
 * `(config?: WebSearchConfig) => AgentTool`, so its first parameter IS the config.
 */
export type WebSearchConfig = NonNullable<Parameters<typeof createWebSearchTool>[0]>;

/** The 8 supported web-search providers (matches SearchProviderName + the WebSearchConfig.provider union). */
export type WebSearchProvider =
  | "brave"
  | "tavily"
  | "duckduckgo"
  | "searxng"
  | "exa"
  | "grok"
  | "perplexity"
  | "jina";

/** The 8 providers, in a stable order. Single source of truth for the WEB-01 scenario loop. */
export const WEB_SEARCH_PROVIDERS = [
  "brave",
  "tavily",
  "duckduckgo",
  "searxng",
  "exa",
  "grok",
  "perplexity",
  "jina",
] as const satisfies readonly WebSearchProvider[];

/** Providers that need NO API key (duckduckgo, searxng — both in credentials.ts KEYLESS_CATEGORIES). */
export const SEARCH_KEYLESS = ["duckduckgo", "searxng"] as const satisfies readonly WebSearchProvider[];

/**
 * Maps each KEYED provider to its credential-registry category string
 * (matches test/live/credentials.ts KEY_TO_CATEGORIES `search(...)` values).
 * No entry for the keyless providers.
 */
export const SEARCH_KEY_CATEGORY: Record<
  Exclude<WebSearchProvider, "duckduckgo" | "searxng">,
  string
> = {
  brave: "search(brave)",
  tavily: "search(tavily)",
  exa: "search(exa)",
  perplexity: "search(perplexity)",
  grok: "search(grok)",
  jina: "search(jina)",
};

/**
 * Build a real WebSearchConfig for the given provider, placing any supplied
 * key/baseUrl into the correct per-provider field.
 */
export function buildWebSearchConfig(
  provider: WebSearchProvider,
  opts?: { apiKey?: string; baseUrl?: string },
): WebSearchConfig {
  switch (provider) {
    case "brave":
      return { provider, ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) };
    case "tavily":
      return { provider, tavily: { ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) } };
    case "exa":
      return { provider, exa: { ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) } };
    case "perplexity":
      return { provider, perplexity: { ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) } };
    case "grok":
      return { provider, grok: { ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) } };
    case "jina":
      return { provider, jina: { ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}) } };
    case "searxng":
      return { provider, searxng: { baseUrl: opts?.baseUrl ?? "http://127.0.0.1:8888" } };
    case "duckduckgo":
      return { provider, duckduckgo: {} };
    default: {
      // Exhaustiveness guard — a new provider must be handled above.
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

/** Build a real LinkUnderstandingConfig (schema defaults) with optional overrides (e.g. enabled:false). */
export function buildLinkConfig(
  overrides?: Partial<LinkUnderstandingConfig>,
): LinkUnderstandingConfig {
  const base: LinkUnderstandingConfig = {
    enabled: true,
    maxLinks: 3,
    fetchTimeoutMs: 10_000,
    maxContentChars: 5000,
    userAgentString: "Comis/1.0 (Link Understanding)",
  };
  return { ...base, ...overrides };
}

/** Build a real FileExtractionConfig (schema defaults) with optional overrides (e.g. maxChars, pdfImageFallback). */
export function buildDocExtractionConfig(
  overrides?: Partial<FileExtractionConfig>,
): FileExtractionConfig {
  return { ...FileExtractionConfigSchema.parse({}), ...overrides };
}
