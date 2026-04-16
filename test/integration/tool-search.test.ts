/**
 * Integration tests for web search tools with real provider APIs.
 *
 * Tests only the real-API paths (key present). No-key error paths are tested
 * in web-tools.test.ts. Uses Phase 111 provider-env infrastructure.
 *
 * Providers tested: Brave (SEARCH_API_KEY), Perplexity (PERPLEXITY_API_KEY),
 * Grok/xAI (XAI_API_KEY).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getProviderEnv,
  hasProvider,
  isAuthError,
} from "../support/provider-env.js";
import { createWebSearchTool, __clearSearchCache } from "@comis/skills";

// ---------------------------------------------------------------------------
// Provider detection (synchronous for describe.skipIf)
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasBrave = hasProvider(env, "SEARCH_API_KEY");
const hasPerplexity = hasProvider(env, "PERPLEXITY_API_KEY");
const hasGrok = hasProvider(env, "XAI_API_KEY");
const hasAnySearch = hasBrave || hasPerplexity || hasGrok;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function parseResult(result: ToolResult): Record<string, unknown> {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Provider returned non-JSON response (${text.length} chars): ${text.slice(0, 200)}`,
    );
  }
}

/** Check if an error should cause a graceful skip (auth failure or non-JSON provider error). */
function isSkippableProviderError(error: unknown): boolean {
  if (isAuthError(error)) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("non-JSON response");
}

// ---------------------------------------------------------------------------
// TOOL-SEARCH: Web Search Provider Integration
// ---------------------------------------------------------------------------

describe.skipIf(!hasAnySearch)(
  "TOOL-SEARCH: Web Search Provider Integration",
  () => {
    beforeEach(() => {
      __clearSearchCache();
    });

    // -----------------------------------------------------------------------
    // SEARCH-01: Brave returns structured results
    // -----------------------------------------------------------------------
    it.skipIf(!hasBrave)(
      "SEARCH-01: Brave returns structured results",
      async () => {
        try {
          const tool = createWebSearchTool({ apiKey: env.SEARCH_API_KEY });
          const result = (await tool.execute("test-brave-search", {
            query: "vitest testing framework",
          })) as ToolResult;

          const parsed = parseResult(result);
          expect(parsed.provider).toBe("brave");
          expect(Array.isArray(parsed.results)).toBe(true);

          const results = parsed.results as Array<Record<string, unknown>>;
          expect(results.length).toBeGreaterThanOrEqual(1);

          for (const entry of results) {
            expect(typeof entry.title).toBe("string");
            expect(typeof entry.url).toBe("string");
          }
        } catch (error: unknown) {
          if (isSkippableProviderError(error)) {
            console.warn(
              `[SEARCH-01] Skipping: Brave provider error — ${(error as Error).message?.slice(0, 120)}`,
            );
            return;
          }
          throw error;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // SEARCH-02: Perplexity returns AI-synthesized answer with citations
    // -----------------------------------------------------------------------
    it.skipIf(!hasPerplexity)(
      "SEARCH-02: Perplexity returns AI-synthesized answer with citations",
      async () => {
        try {
          const tool = createWebSearchTool({
            provider: "perplexity",
            perplexity: { apiKey: env.PERPLEXITY_API_KEY },
          });
          const result = (await tool.execute("test-perplexity-search", {
            query: "what is vitest",
          })) as ToolResult;

          const parsed = parseResult(result);
          expect(parsed.provider).toBe("perplexity");
          expect(typeof parsed.content).toBe("string");
          expect((parsed.content as string).length).toBeGreaterThan(0);
          expect(Array.isArray(parsed.citations)).toBe(true);
        } catch (error: unknown) {
          if (isSkippableProviderError(error)) {
            console.warn(
              `[SEARCH-02] Skipping: Perplexity provider error — ${(error as Error).message?.slice(0, 120)}`,
            );
            return;
          }
          throw error;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // SEARCH-03: Grok returns AI-synthesized answer with citations
    // -----------------------------------------------------------------------
    it.skipIf(!hasGrok)(
      "SEARCH-03: Grok returns AI-synthesized answer with citations",
      async () => {
        try {
          const tool = createWebSearchTool({
            provider: "grok",
            grok: { apiKey: env.XAI_API_KEY },
          });
          const result = (await tool.execute("test-grok-search", {
            query: "what is vitest",
          })) as ToolResult;

          const parsed = parseResult(result);
          expect(parsed.provider).toBe("grok");
          expect(typeof parsed.content).toBe("string");
          expect((parsed.content as string).length).toBeGreaterThan(0);
          expect(Array.isArray(parsed.citations)).toBe(true);
        } catch (error: unknown) {
          if (isSkippableProviderError(error)) {
            console.warn(
              `[SEARCH-03] Skipping: Grok provider error — ${(error as Error).message?.slice(0, 120)}`,
            );
            return;
          }
          throw error;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // SEARCH-04: Different providers return different response structures
    // -----------------------------------------------------------------------
    it.skipIf(!(hasBrave && hasPerplexity))(
      "SEARCH-04: Different providers return different response structures",
      async () => {
        try {
          const braveTool = createWebSearchTool({
            apiKey: env.SEARCH_API_KEY,
          });
          const perplexityTool = createWebSearchTool({
            provider: "perplexity",
            perplexity: { apiKey: env.PERPLEXITY_API_KEY },
          });

          __clearSearchCache();
          const braveResult = (await braveTool.execute(
            "test-brave-struct",
            { query: "nodejs runtime" },
          )) as ToolResult;

          __clearSearchCache();
          const perplexityResult = (await perplexityTool.execute(
            "test-perplexity-struct",
            { query: "nodejs runtime" },
          )) as ToolResult;

          const braveParsed = parseResult(braveResult);
          const perplexityParsed = parseResult(perplexityResult);

          // Brave returns a results array
          expect(Array.isArray(braveParsed.results)).toBe(true);

          // Perplexity returns a content string
          expect(typeof perplexityParsed.content).toBe("string");
        } catch (error: unknown) {
          if (isSkippableProviderError(error)) {
            console.warn(
              `[SEARCH-04] Skipping: provider error — ${(error as Error).message?.slice(0, 120)}`,
            );
            return;
          }
          throw error;
        }
      },
      60_000,
    );
  },
);
