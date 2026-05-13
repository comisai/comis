// SPDX-License-Identifier: Apache-2.0
/**
 * Perplexity Search provider implementation for the web_search tool.
 *
 * Supports both direct Perplexity API (pplx- keys) and OpenRouter proxy
 * (sk-or- keys). Extracts Perplexity-specific types, constants, helpers,
 * and the `runPerplexitySearch()` function from web-search-tool.ts.
 *
 * @module
 */

import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Perplexity-relevant subset of WebSearchConfig (avoids circular import). */
export type PerplexityConfig = {
  perplexity?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
export const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the base URL for Perplexity API calls.
 * Infers from API key prefix when no explicit baseUrl is configured.
 */
export function resolvePerplexityBaseUrl(config?: PerplexityConfig): string {
  const fromConfig = config?.perplexity?.baseUrl?.trim();
  if (fromConfig) {
    return fromConfig;
  }
  // Infer from API key prefix
  const apiKey = config?.perplexity?.apiKey;
  if (apiKey) {
    const lower = apiKey.toLowerCase();
    if (PERPLEXITY_KEY_PREFIXES.some((p) => lower.startsWith(p))) {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (OPENROUTER_KEY_PREFIXES.some((p) => lower.startsWith(p))) {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

/**
 * Resolve the model name for a Perplexity API request.
 * Strips the "perplexity/" prefix when calling the direct Perplexity API.
 */
export function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  try {
    if (new URL(baseUrl).hostname.toLowerCase() === "api.perplexity.ai") {
      return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
    }
  } catch {
    // Invalid URL, use model as-is
  }
  return model;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using the Perplexity chat completions API.
 * Returns AI-synthesized content with citations.
 */
export async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://comis.dev",
      "X-Title": "Comis Web Search",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: params.query }],
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];
  return { content, citations };
}

// ---------------------------------------------------------------------------
// SearchProvider descriptor
// ---------------------------------------------------------------------------

/** Perplexity search provider descriptor for registry-based dispatch. */
export const perplexityProvider: SearchProvider = {
  name: "perplexity",
  requiresApiKey: true,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    const baseUrl = (pc.baseUrl as string) || DEFAULT_PERPLEXITY_BASE_URL;
    const model = (pc.model as string) || DEFAULT_PERPLEXITY_MODEL;
    return runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl,
      model,
      timeoutSeconds: params.timeoutSeconds,
    });
  },
};

registerSearchProvider(perplexityProvider);
