// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for web-search tool: multi-provider search, caching, content wrapping,
 * freshness validation, and error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebSearchTool,
  __clearSearchCache,
  __testing,
} from "./web-search-tool.js";

// Mock @comis/core: keep real wrapWebContent
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual };
});

// Mock impit module — DDG search uses Impit instead of globalThis.fetch
const mockImpitFetch = vi.fn();
vi.mock("impit", () => ({
  Impit: class {
    fetch = mockImpitFetch;
  },
}));

// Mock fetchUrlContent from web-fetch-tool.js for deep fetch tests
const { mockFetchUrlContent } = vi.hoisted(() => ({
  mockFetchUrlContent: vi.fn(),
}));
vi.mock("./web-fetch-tool.js", () => ({
  fetchUrlContent: mockFetchUrlContent,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function parseResult(
  result: { content: { type: string; text: string }[] },
): Record<string, unknown> {
  const raw = textOf(result);
  // Strip SECURITY NOTICE prefix (single notice prepended to tool result)
  const jsonStart = raw.indexOf("{");
  return JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  __clearSearchCache();
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mockImpitFetch.mockReset();
  mockFetchUrlContent.mockReset();
});

// ---------------------------------------------------------------------------
// Missing API key tests
// ---------------------------------------------------------------------------

describe("web-search-tool: missing API key", () => {
  it("returns all_providers_failed when no API key (brave, no fallback)", async () => {
    const tool = createWebSearchTool({ provider: "brave" });
    const result = await tool.execute("call-1", { query: "test query" });
    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect(parsed.failures).toEqual(expect.arrayContaining([expect.stringContaining("brave")]));
  });

  it("returns all_providers_failed when no API key (perplexity, no fallback)", async () => {
    const tool = createWebSearchTool({ provider: "perplexity" });
    const result = await tool.execute("call-2", { query: "test query" });
    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect(parsed.failures).toEqual(expect.arrayContaining([expect.stringContaining("perplexity")]));
  });

  it("returns all_providers_failed when no API key (grok, no fallback)", async () => {
    const tool = createWebSearchTool({ provider: "grok" });
    const result = await tool.execute("call-3", { query: "test query" });
    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect(parsed.failures).toEqual(expect.arrayContaining([expect.stringContaining("grok")]));
  });
});

// ---------------------------------------------------------------------------
// Brave search tests
// ---------------------------------------------------------------------------

describe("web-search-tool: brave provider", () => {
  it("returns structured results with content wrapping", async () => {
    const mockResponse = {
      web: {
        results: [
          {
            title: "Example Result",
            url: "https://example.com",
            description: "An example search result.",
            age: "2 days ago",
          },
          {
            title: "Second Result",
            url: "https://second.com",
            description: "Another result.",
          },
        ],
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-brave-key" });
    const result = await tool.execute("call-brave-1", {
      query: "example search",
      count: 5,
    });

    const parsed = parseResult(result);
    expect(parsed.query).toBe("example search");
    expect(parsed.provider).toBe("brave");
    expect(parsed.count).toBe(2);
    expect(parsed).toHaveProperty("tookMs");

    // Results should have wrapped content
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0].title).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(results[0].title).toContain("Example Result");
    expect(results[0].url).toBe("https://example.com"); // URL raw, not wrapped
    expect(results[0].description).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(results[0].siteName).toBe("example.com");
    expect(results[0].published).toBe("2 days ago");
  });

  it("uses cache on second call", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [{ title: "Cached", url: "https://cached.com", description: "Cached." }] } }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });

    // First call
    await tool.execute("call-cache-1", { query: "cache test" });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const result2 = await tool.execute("call-cache-2", { query: "cache test" });
    expect(mockFetch).toHaveBeenCalledTimes(1); // still 1

    const parsed = parseResult(result2);
    expect(parsed.cached).toBe(true);
  });

  it("handles HTTP error gracefully (no throw)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "Rate limit exceeded",
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-error-1", { query: "rate limited" });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect(parsed.failures).toEqual(expect.arrayContaining([expect.stringContaining("429")]));
  });

  it("handles empty results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-empty-1", { query: "no results" });

    const parsed = parseResult(result);
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("handles missing web field in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-empty-2", { query: "no web field" });

    const parsed = parseResult(result);
    expect(parsed.count).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("passes country and search_lang to API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    await tool.execute("call-params-1", {
      query: "german search",
      country: "DE",
      search_lang: "de",
    });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("country=DE");
    expect(fetchUrl).toContain("search_lang=de");
  });
});

// ---------------------------------------------------------------------------
// Perplexity search tests
// ---------------------------------------------------------------------------

describe("web-search-tool: perplexity provider", () => {
  it("calls chat completions API and returns wrapped content with citations", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "AI synthesized answer about TypeScript." } }],
        citations: ["https://typescript.org", "https://docs.ts.dev"],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "perplexity",
      perplexity: { apiKey: "pplx-test-key" },
    });
    const result = await tool.execute("call-pplx-1", { query: "what is TypeScript" });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("perplexity");
    expect(parsed.query).toBe("what is TypeScript");
    expect(parsed.model).toBe("perplexity/sonar-pro");
    expect(parsed.content).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(parsed.content).toContain("AI synthesized answer");
    expect(parsed.citations).toEqual(["https://typescript.org", "https://docs.ts.dev"]);

    // Verify endpoint
    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("api.perplexity.ai");
    expect(fetchUrl).toContain("chat/completions");
  });

  it("uses OpenRouter base URL for sk-or- prefixed keys", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Answer" } }],
        citations: [],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "perplexity",
      perplexity: { apiKey: "sk-or-test-key" },
    });
    await tool.execute("call-pplx-2", { query: "test" });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("openrouter.ai");
  });
});

// ---------------------------------------------------------------------------
// Grok search tests
// ---------------------------------------------------------------------------

describe("web-search-tool: grok provider", () => {
  it("calls xAI Responses API and returns wrapped content", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Grok answer about AI." }],
          },
        ],
        citations: ["https://xai.com"],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "grok",
      grok: { apiKey: "xai-test-key" },
    });
    const result = await tool.execute("call-grok-1", { query: "what is AI" });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("grok");
    expect(parsed.query).toBe("what is AI");
    expect(parsed.content).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(parsed.content).toContain("Grok answer about AI");
    expect(parsed.citations).toEqual(["https://xai.com"]);

    // Verify endpoint
    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("api.x.ai");
  });

  it("handles Grok output_text fallback field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: "Fallback answer from output_text.",
        citations: [],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "grok",
      grok: { apiKey: "xai-test-key" },
    });
    const result = await tool.execute("call-grok-2", { query: "fallback test" });

    const parsed = parseResult(result);
    expect(parsed.content).toContain("Fallback answer from output_text");
  });
});

// ---------------------------------------------------------------------------
// Freshness validation tests
// ---------------------------------------------------------------------------

describe("web-search-tool: freshness validation", () => {
  it("accepts valid freshness shortcuts (pd, pw, pm, py)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    await tool.execute("call-fresh-1", { query: "fresh", freshness: "pw" });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("freshness=pw");
  });

  it("rejects invalid freshness values", async () => {
    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-fresh-2", {
      query: "fresh",
      freshness: "invalid",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("invalid_freshness");
  });

  it("rejects 'ph' (common LLM hallucination for 'past hour')", async () => {
    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-fresh-ph", {
      query: "fresh",
      freshness: "ph",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("invalid_freshness");
  });

  it("ignores freshness for non-Brave providers and proceeds with search", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: { content: "Perplexity result" },
        }],
        citations: ["https://example.com"],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "perplexity",
      perplexity: { apiKey: "pplx-test" },
    });
    const result = await tool.execute("call-fresh-3", {
      query: "fresh",
      freshness: "pd",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeUndefined();
    expect(parsed.freshnessIgnored).toBe(true);
    expect(parsed.freshnessNote).toContain("not supported by this provider");
    expect(mockFetch).toHaveBeenCalled();
  });

  it("accepts valid date range freshness", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    await tool.execute("call-fresh-4", {
      query: "fresh",
      freshness: "2024-01-01to2024-12-31",
    });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("freshness=2024-01-01to2024-12-31");
  });
});

// ---------------------------------------------------------------------------
// Internal utility tests
// ---------------------------------------------------------------------------

describe("web-search-tool: internal utilities", () => {
  it("normalizeFreshness returns undefined for empty/null values", () => {
    expect(__testing.normalizeFreshness(undefined)).toBeUndefined();
    expect(__testing.normalizeFreshness("")).toBeUndefined();
    expect(__testing.normalizeFreshness("  ")).toBeUndefined();
  });

  it("normalizeFreshness handles shortcuts case-insensitively", () => {
    expect(__testing.normalizeFreshness("PD")).toBe("pd");
    expect(__testing.normalizeFreshness("Pw")).toBe("pw");
    expect(__testing.normalizeFreshness("PM")).toBe("pm");
    expect(__testing.normalizeFreshness("py")).toBe("py");
  });

  it("resolvePerplexityBaseUrl infers from key prefix", () => {
    expect(__testing.resolvePerplexityBaseUrl({ perplexity: { apiKey: "pplx-123" } }))
      .toContain("api.perplexity.ai");
    expect(__testing.resolvePerplexityBaseUrl({ perplexity: { apiKey: "sk-or-123" } }))
      .toContain("openrouter.ai");
  });

  it("resolvePerplexityRequestModel strips prefix for direct API", () => {
    expect(__testing.resolvePerplexityRequestModel(
      "https://api.perplexity.ai",
      "perplexity/sonar-pro",
    )).toBe("sonar-pro");
    expect(__testing.resolvePerplexityRequestModel(
      "https://openrouter.ai/api/v1",
      "perplexity/sonar-pro",
    )).toBe("perplexity/sonar-pro");
  });

  it("extractGrokContent reads from output[0].content[0].text", () => {
    expect(__testing.extractGrokContent({
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello" }],
      }],
    })).toBe("Hello");
  });

  it("extractGrokContent falls back to output_text", () => {
    expect(__testing.extractGrokContent({
      output_text: "Fallback",
    })).toBe("Fallback");
  });

  it("resolveProvider defaults to duckduckgo", () => {
    expect(__testing.resolveProvider()).toBe("duckduckgo");
    expect(__testing.resolveProvider({})).toBe("duckduckgo");
    expect(__testing.resolveProvider({ provider: "perplexity" })).toBe("perplexity");
    expect(__testing.resolveProvider({ provider: "grok" })).toBe("grok");
  });
});

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe("web-search-tool: metadata", () => {
  it("has correct tool metadata", () => {
    const tool = createWebSearchTool({ provider: "brave", apiKey: "test" });
    expect(tool.name).toBe("web_search");
    expect(tool.label).toBe("Web Search");
    expect(tool.description).toContain("multi-provider");
    expect(tool.description).toContain("fallback");
    expect(tool.parameters).toBeDefined();
  });

  it("has lean description with deepFetch mention", () => {
    const tool = createWebSearchTool();
    expect(tool.description).toContain("deepFetch");
    expect(tool.description.length).toBeLessThanOrEqual(150);
  });

  it("description mentions deepFetch", () => {
    const tool = createWebSearchTool();
    expect(tool.description).toContain("deepFetch");
  });
});

// ---------------------------------------------------------------------------
// Fallback chain tests
// ---------------------------------------------------------------------------

describe("web-search-tool: fallback chain", () => {
  it("falls back to second provider when first fails with HTTP error", async () => {
    const ddgHtml = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">DDG Answer</a><a class="result__snippet">DDG answer description</a></div>`;
    // Brave uses globalThis.fetch — fails with 500
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server error",
    });
    globalThis.fetch = mockFetch;

    // DDG uses impit — succeeds
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ddgHtml,
    });

    const tool = createWebSearchTool({
      provider: "brave",
      apiKey: "brave-key",
      fallbackProviders: ["duckduckgo"],
    });
    const result = await tool.execute("call-fb-1", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("duckduckgo");
    // Brave called via fetch, DDG called via impit
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
    const [firstUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toContain("api.search.brave.com");
  });

  it("falls back to duckduckgo when brave key is missing", async () => {
    const ddgHtml = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example.com">DDG Result</a><a class="result__snippet">From DDG</a></div>`;
    // DDG uses impit
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ddgHtml,
    });

    const tool = createWebSearchTool({
      provider: "brave",
      // No brave apiKey — skips brave, falls back to duckduckgo
      fallbackProviders: ["duckduckgo"],
    });
    const result = await tool.execute("call-fb-2", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("duckduckgo");
    // Brave was skipped due to missing key, DDG called via impit
    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
  });

  it("reports all failures when entire chain fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const tool = createWebSearchTool({
      provider: "brave",
      apiKey: "brave-key",
      fallbackProviders: ["tavily"],
      tavily: { apiKey: "tvly-test" },
    });
    const result = await tool.execute("call-fb-3", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    const failures = parsed.failures as string[];
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("brave");
    expect(failures[1]).toContain("tavily");
  });

  it("single provider with no fallback returns error on failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

    const tool = createWebSearchTool({ provider: "brave", apiKey: "brave-key" });
    const result = await tool.execute("call-fb-4", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    const failures = parsed.failures as string[];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("brave");
  });
});

// ---------------------------------------------------------------------------
// Runtime provider override tests
// ---------------------------------------------------------------------------

describe("web-search-tool: runtime provider override", () => {
  it("runtime provider parameter overrides config provider", async () => {
    const ddgHtml = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Foverride.com">DDG Override</a><a class="result__snippet">Override result</a></div>`;
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ddgHtml,
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "brave-key" });
    const result = await tool.execute("call-override-1", {
      query: "test",
      provider: "duckduckgo",
    });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("duckduckgo");
    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
  });

  it("runtime override skips fallback chain", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("tavily down"));

    const tool = createWebSearchTool({
      provider: "brave",
      apiKey: "brave-key",
      fallbackProviders: ["duckduckgo"],
      tavily: { apiKey: "tvly-test" },
    });
    const result = await tool.execute("call-override-2", {
      query: "test",
      provider: "tavily",
    });

    // Should NOT fall back to brave or duckduckgo
    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    const failures = parsed.failures as string[];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("tavily");
  });

  it("invalid runtime provider returns error", async () => {
    const tool = createWebSearchTool({ provider: "brave", apiKey: "brave-key" });
    const result = await tool.execute("call-override-3", {
      query: "test",
      provider: "nonexistent",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("invalid_provider");
    expect(parsed.message).toContain("nonexistent");
  });

  it("ddg alias works as runtime override", async () => {
    const ddgHtml = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.example.com">DDG</a><a class="result__snippet">From DDG</a></div>`;
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ddgHtml,
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "brave-key" });
    await tool.execute("call-override-4", { query: "test", provider: "ddg" });

    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
    const [url] = mockImpitFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain("html.duckduckgo.com");
  });
});

// ---------------------------------------------------------------------------
// DuckDuckGo provider tests
// ---------------------------------------------------------------------------

describe("web-search-tool: duckduckgo provider", () => {
  it("returns structured results from HTML search endpoint", async () => {
    const ddgHtml = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftypescriptlang.org">TypeScript</a><a class="result__snippet">TypeScript is a programming language.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org">Zig Language</a><a class="result__snippet">A programming language for systems.</a></div>`;
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ddgHtml,
    });

    const tool = createWebSearchTool({ provider: "duckduckgo" });
    const result = await tool.execute("call-ddg-1", { query: "TypeScript" });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("duckduckgo");
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain("TypeScript");
    expect(results[0].title).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(results[0].url).toBe("https://typescriptlang.org");
    expect(results[0].description).toContain("programming language");
  });

  it("handles empty DDG response", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => `<html><body><div id="links"></div></body></html>`,
    });

    const tool = createWebSearchTool({ provider: "duckduckgo" });
    const result = await tool.execute("call-ddg-2", { query: "unknown" });

    const parsed = parseResult(result);
    expect(parsed.count).toBe(0);
  });

  it("sends POST request to html.duckduckgo.com via impit", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => `<html><body></body></html>`,
    });

    const tool = createWebSearchTool({ provider: "duckduckgo" });
    await tool.execute("call-ddg-3", { query: "zig" });

    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchOpts] = mockImpitFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(fetchUrl).toContain("html.duckduckgo.com/html/");
    expect(fetchOpts.method).toBe("POST");
    const headers = fetchOpts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("limits results to requested count", async () => {
    const ddgHtml = Array.from({ length: 10 }, (_, i) =>
      `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample${i}.com">Result ${i}</a><a class="result__snippet">Snippet ${i}</a></div>`,
    ).join("\n");
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ddgHtml,
    });

    const tool = createWebSearchTool({ provider: "duckduckgo" });
    const result = await tool.execute("call-ddg-4", { query: "many", count: 3 });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(parsed.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SearXNG provider tests
// ---------------------------------------------------------------------------

describe("web-search-tool: searxng provider", () => {
  it("returns results from SearXNG instance", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "SearX Result", url: "https://searx.example.com/result", content: "A search result from SearXNG." },
        ],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "searxng",
      searxng: { baseUrl: "https://searx.example.com" },
    });
    const result = await tool.execute("call-searx-1", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("searxng");
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("SearX Result");
    expect(results[0].description).toContain("SearXNG");
  });

  it("validates base URL format", async () => {
    const tool = createWebSearchTool({
      provider: "searxng",
      searxng: { baseUrl: "https://searx.example.com?invalid" },
    });
    const result = await tool.execute("call-searx-2", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect((parsed.failures as string[])[0]).toContain("query string");
  });

  it("normalizes base URL (strips trailing slash, appends /search)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "searxng",
      searxng: { baseUrl: "https://searx.example.com/" },
    });
    await tool.execute("call-searx-3", { query: "test" });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("https://searx.example.com/search?");
  });

  it("returns error when baseUrl is missing", async () => {
    const tool = createWebSearchTool({ provider: "searxng" });
    const result = await tool.execute("call-searx-4", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect((parsed.failures as string[])[0]).toContain("searxng");
  });
});

// ---------------------------------------------------------------------------
// Tavily provider tests
// ---------------------------------------------------------------------------

describe("web-search-tool: tavily provider", () => {
  it("posts to Tavily API with correct body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "Tavily Result", url: "https://tavily.example.com", content: "AI search result." },
        ],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "tavily",
      tavily: { apiKey: "tvly-test" },
    });
    const result = await tool.execute("call-tavily-1", { query: "ai search", count: 3 });

    const parsed = parseResult(result);
    expect(parsed.provider).toBe("tavily");

    // Verify POST body
    const [, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(fetchInit.body as string);
    expect(body.api_key).toBe("tvly-test");
    expect(body.query).toBe("ai search");
    expect(body.max_results).toBe(3);
    expect(body.search_depth).toBe("basic");
  });

  it("returns structured results", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "Result One", url: "https://one.com", content: "First result." },
          { title: "Result Two", url: "https://two.com", content: "Second result." },
        ],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "tavily",
      tavily: { apiKey: "tvly-test" },
    });
    const result = await tool.execute("call-tavily-2", { query: "test" });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0].title).toContain("Result One");
    expect(results[0].description).toContain("First result");
  });
});

// ---------------------------------------------------------------------------
// Exa provider tests
// ---------------------------------------------------------------------------

describe("web-search-tool: exa provider", () => {
  it("posts to Exa API with x-api-key header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "Exa Result", url: "https://exa.example.com", summary: "Neural search result." },
        ],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "exa",
      exa: { apiKey: "exa-test" },
    });
    await tool.execute("call-exa-1", { query: "neural search" });

    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("api.exa.ai");
    expect((fetchInit.headers as Record<string, string>)["x-api-key"]).toBe("exa-test");
  });

  it("uses summary field for description, falls back to text", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: "With Summary", url: "https://a.com", summary: "Summary text", text: "Full text" },
          { title: "No Summary", url: "https://b.com", text: "Only text field" },
          { title: "Neither", url: "https://c.com" },
        ],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "exa",
      exa: { apiKey: "exa-test" },
    });
    const result = await tool.execute("call-exa-2", { query: "test" });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results[0].description).toContain("Summary text");
    expect(results[1].description).toContain("Only text field");
    expect(results[2].description).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Jina provider tests
// ---------------------------------------------------------------------------

describe("web-search-tool: jina provider", () => {
  it("calls Jina search API with Bearer auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [
          { title: "Jina Result", url: "https://jina.example.com", description: "Jina search." },
        ],
      }),
    });
    globalThis.fetch = mockFetch;

    const tool = createWebSearchTool({
      provider: "jina",
      jina: { apiKey: "jina-test" },
    });
    await tool.execute("call-jina-1", { query: "test search" });

    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("s.jina.ai/");
    expect((fetchInit.headers as Record<string, string>).Authorization).toBe("Bearer jina-test");
    expect((fetchInit.headers as Record<string, string>)["X-Return-Format"]).toBe("json");
  });

  it("detects API error payloads", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 401,
        name: "AuthError",
        message: "Invalid API key",
      }),
    });

    const tool = createWebSearchTool({
      provider: "jina",
      jina: { apiKey: "jina-bad" },
    });
    const result = await tool.execute("call-jina-2", { query: "test" });

    const parsed = parseResult(result);
    expect(parsed.error).toBe("all_providers_failed");
    expect((parsed.failures as string[])[0]).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// Search result capping tests
// ---------------------------------------------------------------------------

describe("web-search-tool: capSearchResults", () => {
  it("caps 20 results at 5K each with 40K budget: keeps ~8, drops ~12", () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example${i}.com`,
      description: "x".repeat(5000 - `Result ${i}`.length - `https://example${i}.com`.length),
    }));
    const capInfo = __testing.capSearchResults(results, 40_000);
    expect(capInfo.results.length).toBe(8);
    expect(capInfo.droppedCount).toBe(12);
    expect(capInfo.totalResults).toBe(20);
    expect(capInfo.totalCharsBudget).toBe(40_000);
  });

  it("keeps all results when they fit within budget", () => {
    const results = [
      { title: "Short", url: "https://a.com", description: "Brief." },
      { title: "Also Short", url: "https://b.com", description: "Also brief." },
    ];
    const capInfo = __testing.capSearchResults(results, 40_000);
    expect(capInfo.results).toHaveLength(2);
    expect(capInfo.droppedCount).toBe(0);
  });

  it("returns empty results with droppedCount 0 for empty input", () => {
    const capInfo = __testing.capSearchResults([], 40_000);
    expect(capInfo.results).toHaveLength(0);
    expect(capInfo.droppedCount).toBe(0);
    expect(capInfo.totalResults).toBe(0);
  });

  it("never truncates mid-result: first result always included even if over budget", () => {
    const results = [
      { title: "Very Large", url: "https://big.com", description: "x".repeat(50_000) },
      { title: "Small", url: "https://small.com", description: "tiny" },
    ];
    const capInfo = __testing.capSearchResults(results, 40_000);
    expect(capInfo.results).toHaveLength(1);
    expect(capInfo.results[0].title).toBe("Very Large");
    expect(capInfo.droppedCount).toBe(1);
  });
});

describe("web-search-tool: search result capping integration", () => {
  it("capped results include resultsCapped and resultsCappedMessage", async () => {
    // 15 results with ~4K chars each = 60K total, budget 40K -> capped
    const braveResults = Array.from({ length: 15 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example${i}.com`,
      description: "x".repeat(4000),
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: braveResults } }),
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key", totalCharsBudget: 40_000 });
    const result = await tool.execute("call-cap-1", { query: "capping test", count: 10 });

    const parsed = parseResult(result);
    expect(parsed.resultsCapped).toBe(true);
    expect(parsed.resultsCappedMessage).toMatch(/^Showing \d+ of 15 results \(\d+ dropped, budget: 40000 chars\)$/);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results.length).toBeLessThan(15);
  });

  it("resultsCappedMessage format matches spec", async () => {
    const braveResults = Array.from({ length: 10 }, (_, i) => ({
      title: `R${i}`,
      url: `https://r${i}.com`,
      description: "d".repeat(6000),
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: braveResults } }),
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key", totalCharsBudget: 40_000 });
    const result = await tool.execute("call-cap-2", { query: "format test", count: 10 });

    const parsed = parseResult(result);
    if (parsed.resultsCapped) {
      const msg = parsed.resultsCappedMessage as string;
      expect(msg).toContain("Showing");
      expect(msg).toContain("dropped");
      expect(msg).toContain("budget: 40000 chars");
    }
  });

  it("does not cap when results fit within budget", async () => {
    const braveResults = [
      { title: "A", url: "https://a.com", description: "Short." },
      { title: "B", url: "https://b.com", description: "Also short." },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: braveResults } }),
    });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-cap-3", { query: "no cap" });

    const parsed = parseResult(result);
    expect(parsed.resultsCapped).toBeUndefined();
    expect(parsed.resultsCappedMessage).toBeUndefined();
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Updated utility tests (new providers)
// ---------------------------------------------------------------------------

describe("web-search-tool: parseProvider and buildProviderChain", () => {
  it("parseProvider handles all provider names", () => {
    expect(__testing.parseProvider("duckduckgo")).toBe("duckduckgo");
    expect(__testing.parseProvider("ddg")).toBe("duckduckgo");
    expect(__testing.parseProvider("searxng")).toBe("searxng");
    expect(__testing.parseProvider("tavily")).toBe("tavily");
    expect(__testing.parseProvider("exa")).toBe("exa");
    expect(__testing.parseProvider("jina")).toBe("jina");
    expect(__testing.parseProvider("brave")).toBe("brave");
    expect(__testing.parseProvider("perplexity")).toBe("perplexity");
    expect(__testing.parseProvider("grok")).toBe("grok");
    expect(__testing.parseProvider("invalid")).toBeUndefined();
    expect(__testing.parseProvider(undefined)).toBeUndefined();
    expect(__testing.parseProvider("")).toBeUndefined();
  });

  it("resolveProvider handles new providers", () => {
    expect(__testing.resolveProvider({ provider: "duckduckgo" })).toBe("duckduckgo");
    expect(__testing.resolveProvider({ provider: "searxng" })).toBe("searxng");
    expect(__testing.resolveProvider({ provider: "tavily" })).toBe("tavily");
    expect(__testing.resolveProvider({ provider: "exa" })).toBe("exa");
    expect(__testing.resolveProvider({ provider: "jina" })).toBe("jina");
  });

  it("buildProviderChain deduplicates", () => {
    const chain = __testing.buildProviderChain("brave", ["duckduckgo", "brave", "tavily"]);
    expect(chain).toEqual(["brave", "duckduckgo", "tavily"]);
  });

  it("buildProviderChain with no fallbacks returns single provider", () => {
    const chain = __testing.buildProviderChain("brave", undefined);
    expect(chain).toEqual(["brave"]);
  });
});

// ---------------------------------------------------------------------------
// Deep fetch tests
// ---------------------------------------------------------------------------

describe("web-search-tool: deep fetch", () => {
  /** Helper: mock Brave API to return N results. */
  function mockBraveResults(results: Array<{ title: string; url: string; description: string }>) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: results.map(r => ({
            title: r.title,
            url: r.url,
            description: r.description,
          })),
        },
      }),
    });
  }

  const threeResults = [
    { title: "Result 1", url: "https://example.com/1", description: "First result" },
    { title: "Result 2", url: "https://example.com/2", description: "Second result" },
    { title: "Result 3", url: "https://example.com/3", description: "Third result" },
  ];

  it("deepFetch=0 (default) does not fetch any URLs", async () => {
    mockBraveResults(threeResults);
    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-df-0", { query: "test" });
    const parsed = parseResult(result);

    expect(mockFetchUrlContent).not.toHaveBeenCalled();
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).not.toHaveProperty("fullContent");
    }
  });

  it("deepFetch=2 fetches top 2 result URLs in parallel", async () => {
    mockBraveResults(threeResults);
    mockFetchUrlContent.mockImplementation(async (params: { url: string }) => ({
      url: params.url,
      text: `Full content of ${params.url}`,
      title: `Page Title for ${params.url}`,
      tookMs: 100,
      status: 200,
      extractor: "readability",
      truncated: false,
    }));

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-df-2", { query: "test", deepFetch: 2 });
    const parsed = parseResult(result);

    expect(mockFetchUrlContent).toHaveBeenCalledTimes(2);
    const results = parsed.results as Array<Record<string, unknown>>;
    // LLM-facing content should NOT contain fullContent (stripped for compactness)
    expect(results[0]).not.toHaveProperty("fullContent");
    expect(results[0].fetchTitle).toBe("Page Title for https://example.com/1");
    expect(results[1]).not.toHaveProperty("fullContent");
    expect(results[1].fetchTitle).toBe("Page Title for https://example.com/2");
    // Third result should not have fullContent
    expect(results[2]).not.toHaveProperty("fullContent");
    expect(parsed.deepFetched).toBe(2);

    // details field preserves full result including fullContent
    const details = (result as Record<string, unknown>).details as Record<string, unknown>;
    const detailResults = details.results as Array<Record<string, unknown>>;
    expect(detailResults[0].fullContent).toBe("Full content of https://example.com/1");
    expect(detailResults[1].fullContent).toBe("Full content of https://example.com/2");
  });

  it("deepFetch handles fetch failures gracefully", async () => {
    mockBraveResults(threeResults);
    mockFetchUrlContent
      .mockResolvedValueOnce({
        url: "https://example.com/1",
        error: "Timeout",
        tookMs: 15000,
      })
      .mockResolvedValueOnce({
        url: "https://example.com/2",
        text: "Content of page 2",
        title: "Page 2",
        tookMs: 200,
        status: 200,
        extractor: "readability",
        truncated: false,
      });

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-df-fail", { query: "test", deepFetch: 2 });
    const parsed = parseResult(result);

    const results = parsed.results as Array<Record<string, unknown>>;
    // LLM-facing content should NOT contain fullContent (stripped for compactness)
    expect(results[0]).not.toHaveProperty("fullContent");
    expect(results[0].fetchError).toBe("Timeout");
    expect(results[1]).not.toHaveProperty("fullContent");

    // details field preserves full result including fullContent
    const details = (result as Record<string, unknown>).details as Record<string, unknown>;
    const detailResults = details.results as Array<Record<string, unknown>>;
    expect(detailResults[0].fullContent).toBeNull();
    expect(detailResults[1].fullContent).toBe("Content of page 2");
  });

  it("deepFetch handles Promise rejection gracefully", async () => {
    mockBraveResults(threeResults);
    mockFetchUrlContent.mockRejectedValueOnce(new Error("Network error"));

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-df-reject", { query: "test", deepFetch: 1 });
    const parsed = parseResult(result);

    const results = parsed.results as Array<Record<string, unknown>>;
    // LLM-facing content should NOT contain fullContent (stripped for compactness)
    expect(results[0]).not.toHaveProperty("fullContent");
    expect(results[0].fetchError).toContain("Network error");

    // details field preserves full result including fullContent
    const details = (result as Record<string, unknown>).details as Record<string, unknown>;
    const detailResults = details.results as Array<Record<string, unknown>>;
    expect(detailResults[0].fullContent).toBeNull();
  });

  it("deepFetch respects budget cap — drops results whose fullContent exceeds budget", async () => {
    mockBraveResults(threeResults);
    // Return 800 chars for each page
    mockFetchUrlContent.mockImplementation(async (params: { url: string }) => ({
      url: params.url,
      text: "x".repeat(800),
      title: "Page",
      tookMs: 50,
      status: 200,
      extractor: "readability",
      truncated: false,
    }));

    const tool = createWebSearchTool({
      provider: "brave",
      apiKey: "test-key",
      totalCharsBudget: 1000,
    });
    const result = await tool.execute("call-df-budget", { query: "test", deepFetch: 3 });
    const parsed = parseResult(result);

    // With 1000 char budget and 800 chars per fullContent, second result should be dropped
    const results = parsed.results as Array<Record<string, unknown>>;
    // First result fits: ~50 chars (title+desc+url) + 800 chars fullContent = ~850 < 1000
    // Second result would add ~850 more, exceeding 1000 budget — should be dropped
    expect(results.length).toBeLessThan(3);
  });

  it("deepFetch=5 caps at available results", async () => {
    // Only 2 results returned by search
    mockBraveResults(threeResults.slice(0, 2));
    mockFetchUrlContent.mockImplementation(async (params: { url: string }) => ({
      url: params.url,
      text: `Content of ${params.url}`,
      title: "Page",
      tookMs: 100,
      status: 200,
      extractor: "readability",
      truncated: false,
    }));

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-df-cap", { query: "test", deepFetch: 5 });

    expect(mockFetchUrlContent).toHaveBeenCalledTimes(2); // Only 2 available, not 5
    const parsed = parseResult(result);
    expect(parsed.deepFetched).toBe(2);
  });

  it("deepFetch skips results without URLs", async () => {
    // Override fetch to return results where one has no URL
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            { title: "No URL", description: "Has no url field" },
            { title: "Has URL", url: "https://example.com/valid", description: "Valid" },
            { title: "Also Has URL", url: "https://example.com/valid2", description: "Also valid" },
          ],
        },
      }),
    });
    mockFetchUrlContent.mockImplementation(async (params: { url: string }) => ({
      url: params.url,
      text: `Content of ${params.url}`,
      title: "Page",
      tookMs: 100,
      status: 200,
      extractor: "readability",
      truncated: false,
    }));

    const tool = createWebSearchTool({ provider: "brave", apiKey: "test-key" });
    const result = await tool.execute("call-df-nourl", { query: "test", deepFetch: 3 });

    // Only 2 results have URLs, so only 2 fetches
    expect(mockFetchUrlContent).toHaveBeenCalledTimes(2);
    expect(mockFetchUrlContent).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/valid" }),
    );
    expect(mockFetchUrlContent).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/valid2" }),
    );

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    // First result (no URL) should not have fullContent
    expect(results[0]).not.toHaveProperty("fullContent");
  });
});

// ---------------------------------------------------------------------------
// Freshness multi-provider mapping tests
// ---------------------------------------------------------------------------

describe("web-search-tool: freshness multi-provider mapping", () => {
  const { mapFreshnessToProvider } = __testing;

  describe("mapFreshnessToProvider", () => {
    it("maps shortcuts to DuckDuckGo df param", () => {
      expect(mapFreshnessToProvider("duckduckgo", "pd")).toEqual({ df: "d" });
      expect(mapFreshnessToProvider("duckduckgo", "pw")).toEqual({ df: "w" });
      expect(mapFreshnessToProvider("duckduckgo", "pm")).toEqual({ df: "m" });
      expect(mapFreshnessToProvider("duckduckgo", "py")).toEqual({ df: "y" });
    });

    it("returns empty for DDG custom date range (not supported)", () => {
      expect(mapFreshnessToProvider("duckduckgo", "2024-01-01to2024-12-31")).toEqual({});
    });

    it("maps shortcuts to Tavily days param", () => {
      expect(mapFreshnessToProvider("tavily", "pd")).toEqual({ days: 1 });
      expect(mapFreshnessToProvider("tavily", "pw")).toEqual({ days: 7 });
      expect(mapFreshnessToProvider("tavily", "pm")).toEqual({ days: 30 });
      expect(mapFreshnessToProvider("tavily", "py")).toEqual({ days: 365 });
    });

    it("maps custom date range to Tavily days (approximate)", () => {
      const result = mapFreshnessToProvider("tavily", "2024-01-01to2024-12-31");
      expect(result).toHaveProperty("days");
      expect(typeof result.days).toBe("number");
      expect(result.days as number).toBeGreaterThan(0);
    });

    it("maps shortcuts to Exa startPublishedDate", () => {
      const result = mapFreshnessToProvider("exa", "pd");
      expect(result).toHaveProperty("startPublishedDate");
      expect(typeof result.startPublishedDate).toBe("string");
      expect((result.startPublishedDate as string)).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    });

    it("maps custom date range to Exa startPublishedDate and endPublishedDate", () => {
      const result = mapFreshnessToProvider("exa", "2024-01-01to2024-06-30");
      expect(result).toEqual({
        startPublishedDate: "2024-01-01T00:00:00.000Z",
        endPublishedDate: "2024-06-30T23:59:59.999Z",
      });
    });

    it("maps shortcuts to SearXNG time_range param", () => {
      expect(mapFreshnessToProvider("searxng", "pd")).toEqual({ time_range: "day" });
      expect(mapFreshnessToProvider("searxng", "pw")).toEqual({ time_range: "week" });
      expect(mapFreshnessToProvider("searxng", "pm")).toEqual({ time_range: "month" });
      expect(mapFreshnessToProvider("searxng", "py")).toEqual({ time_range: "year" });
    });

    it("returns empty for SearXNG custom date range (not supported)", () => {
      expect(mapFreshnessToProvider("searxng", "2024-01-01to2024-12-31")).toEqual({});
    });

    it("maps shortcuts to Brave freshness (passthrough)", () => {
      expect(mapFreshnessToProvider("brave", "pd")).toEqual({ freshness: "pd" });
      expect(mapFreshnessToProvider("brave", "2024-01-01to2024-12-31")).toEqual({ freshness: "2024-01-01to2024-12-31" });
    });

    it("returns empty for unsupported providers", () => {
      expect(mapFreshnessToProvider("grok", "pd")).toEqual({});
      expect(mapFreshnessToProvider("perplexity", "pw")).toEqual({});
      expect(mapFreshnessToProvider("jina", "pm")).toEqual({});
    });
  });
});
