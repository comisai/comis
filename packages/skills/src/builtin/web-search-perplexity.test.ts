/**
 * Tests for the Perplexity Search provider module (web-search-perplexity.ts).
 *
 * Covers: resolvePerplexityBaseUrl(), resolvePerplexityRequestModel(),
 * runPerplexitySearch() with mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolvePerplexityBaseUrl,
  resolvePerplexityRequestModel,
  runPerplexitySearch,
} from "./web-search-perplexity.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// resolvePerplexityBaseUrl
// ---------------------------------------------------------------------------

describe("resolvePerplexityBaseUrl", () => {
  it("returns direct URL for pplx- prefixed keys", () => {
    const url = resolvePerplexityBaseUrl({ perplexity: { apiKey: "pplx-abc123" } });
    expect(url).toContain("api.perplexity.ai");
  });

  it("returns OpenRouter URL for sk-or- prefixed keys", () => {
    const url = resolvePerplexityBaseUrl({ perplexity: { apiKey: "sk-or-abc123" } });
    expect(url).toContain("openrouter.ai");
  });

  it("uses explicit baseUrl when provided", () => {
    const url = resolvePerplexityBaseUrl({
      perplexity: { apiKey: "pplx-abc", baseUrl: "https://custom.api.com" },
    });
    expect(url).toBe("https://custom.api.com");
  });

  it("defaults to OpenRouter when no config", () => {
    const url = resolvePerplexityBaseUrl();
    expect(url).toContain("openrouter.ai");
  });

  it("defaults to OpenRouter for unknown key prefix", () => {
    const url = resolvePerplexityBaseUrl({ perplexity: { apiKey: "unknown-key" } });
    expect(url).toContain("openrouter.ai");
  });
});

// ---------------------------------------------------------------------------
// resolvePerplexityRequestModel
// ---------------------------------------------------------------------------

describe("resolvePerplexityRequestModel", () => {
  it("strips perplexity/ prefix for direct API", () => {
    expect(
      resolvePerplexityRequestModel("https://api.perplexity.ai", "perplexity/sonar-pro"),
    ).toBe("sonar-pro");
  });

  it("keeps perplexity/ prefix for OpenRouter", () => {
    expect(
      resolvePerplexityRequestModel("https://openrouter.ai/api/v1", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });

  it("keeps model as-is when no perplexity/ prefix on direct API", () => {
    expect(
      resolvePerplexityRequestModel("https://api.perplexity.ai", "sonar-pro"),
    ).toBe("sonar-pro");
  });

  it("handles invalid URL gracefully", () => {
    expect(
      resolvePerplexityRequestModel("not-a-url", "perplexity/sonar-pro"),
    ).toBe("perplexity/sonar-pro");
  });
});

// ---------------------------------------------------------------------------
// runPerplexitySearch
// ---------------------------------------------------------------------------

describe("runPerplexitySearch", () => {
  it("returns content and citations on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "AI answer about TypeScript." } }],
        citations: ["https://ts.dev", "https://docs.ts.dev"],
      }),
    });

    const result = await runPerplexitySearch({
      query: "what is TypeScript",
      apiKey: "pplx-test",
      baseUrl: "https://api.perplexity.ai",
      model: "sonar-pro",
      timeoutSeconds: 10,
    });

    expect(result.content).toBe("AI answer about TypeScript.");
    expect(result.citations).toEqual(["https://ts.dev", "https://docs.ts.dev"]);
  });

  it("returns 'No response' when choices are empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [], citations: [] }),
    });

    const result = await runPerplexitySearch({
      query: "test",
      apiKey: "pplx-test",
      baseUrl: "https://api.perplexity.ai",
      model: "sonar-pro",
      timeoutSeconds: 10,
    });

    expect(result.content).toBe("No response");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    await expect(
      runPerplexitySearch({
        query: "fail",
        apiKey: "bad-key",
        baseUrl: "https://api.perplexity.ai",
        model: "sonar-pro",
        timeoutSeconds: 10,
      }),
    ).rejects.toThrow("Perplexity API error (401)");
  });

  it("constructs correct endpoint from baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        citations: [],
      }),
    });
    globalThis.fetch = mockFetch;

    await runPerplexitySearch({
      query: "test",
      apiKey: "sk-or-test",
      baseUrl: "https://openrouter.ai/api/v1/",
      model: "perplexity/sonar-pro",
      timeoutSeconds: 10,
    });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});
