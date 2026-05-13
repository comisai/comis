// SPDX-License-Identifier: Apache-2.0
/**
 * Grok (xAI) Search provider implementation for the web_search tool.
 *
 * Uses the xAI Responses API with web_search tool and inline citations.
 * Extracts Grok-specific types, constants, helpers, and the `runGrokSearch()`
 * function from web-search-tool.ts.
 *
 * @module
 */

import { readResponseText, withTimeout } from "./web-shared.js";
import { registerSearchProvider, type SearchProvider, type SearchProviderParams } from "./search-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
export const DEFAULT_GROK_MODEL = "grok-4-1-fast";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from a Grok Responses API response.
 * Tries `output[0].content[0].text` first, falls back to `output_text`.
 */
export function extractGrokContent(data: GrokSearchResponse): string | undefined {
  // xAI Responses API format: output[0].content[0].text
  const fromResponses = data.output?.[0]?.content?.[0]?.text;
  if (typeof fromResponses === "string" && fromResponses) {
    return fromResponses;
  }
  return typeof data.output_text === "string" ? data.output_text : undefined;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * Execute a web search using the xAI Grok Responses API.
 * Returns AI-synthesized content with citations and optional inline citations.
 */
export async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [{ role: "user", content: params.query }],
    tools: [{ type: "web_search" }],
  };
  if (params.inlineCitations) {
    body.include = ["inline_citations"];
  }

  const res = await fetch(XAI_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const { text: detail } = await readResponseText(res);
    throw new Error(`xAI API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as GrokSearchResponse;
  const content = extractGrokContent(data) ?? "No response";
  const citations = data.citations ?? [];
  return { content, citations, inlineCitations: data.inline_citations };
}

// ---------------------------------------------------------------------------
// SearchProvider descriptor
// ---------------------------------------------------------------------------

/** Grok (xAI) search provider descriptor for registry-based dispatch. */
export const grokProvider: SearchProvider = {
  name: "grok",
  requiresApiKey: true,
  async execute(params: SearchProviderParams): Promise<Record<string, unknown>> {
    const pc = params.providerConfig ?? {};
    const model = (pc.model as string) || DEFAULT_GROK_MODEL;
    const inlineCitations = (pc.inlineCitations as boolean) ?? false;
    return runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations,
    });
  },
};

registerSearchProvider(grokProvider);
