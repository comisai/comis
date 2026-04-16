/**
 * Tests for SearchProvider interface and registry.
 *
 * Verifies that all 8 providers register correctly, export valid
 * SearchProvider descriptors, and that the registry lookup works.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SearchProvider } from "./search-provider.js";

// Mock @comis/core: keep real wrapWebContent
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual };
});

// Mock impit module -- DDG search uses Impit instead of globalThis.fetch
const mockImpitFetch = vi.fn();
vi.mock("impit", () => ({
  Impit: class {
    fetch = mockImpitFetch;
  },
}));

// Mock fetchUrlContent from web-fetch-tool.js (transitive dependency)
vi.mock("./web-fetch-tool.js", () => ({
  fetchUrlContent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// All 8 provider names
// ---------------------------------------------------------------------------

const ALL_PROVIDER_NAMES = [
  "brave",
  "duckduckgo",
  "exa",
  "grok",
  "jina",
  "perplexity",
  "searxng",
  "tavily",
] as const;

const PROVIDERS_REQUIRING_API_KEY = new Set([
  "brave",
  "exa",
  "grok",
  "jina",
  "perplexity",
  "tavily",
]);

const PROVIDERS_WITHOUT_API_KEY = new Set([
  "duckduckgo",
  "searxng",
]);

// ---------------------------------------------------------------------------
// Import registry after mocks are set up
// ---------------------------------------------------------------------------

// Importing the provider modules triggers self-registration via side effects.
// The web-search-tool.ts re-exports this pattern; we replicate it here.
let searchProviders: Map<string, SearchProvider>;
let getSearchProvider: (name: string) => SearchProvider | undefined;

beforeEach(async () => {
  // Import fresh to ensure registry is populated
  const registry = await import("./search-provider.js");
  searchProviders = registry.searchProviders;
  getSearchProvider = registry.getSearchProvider;

  // Trigger side-effect imports to populate registry
  await import("./web-search-brave.js");
  await import("./web-search-duckduckgo.js");
  await import("./web-search-exa.js");
  await import("./web-search-grok.js");
  await import("./web-search-jina.js");
  await import("./web-search-perplexity.js");
  await import("./web-search-searxng.js");
  await import("./web-search-tavily.js");
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe("SearchProvider registry", () => {
  it("contains all 8 providers", () => {
    expect(searchProviders.size).toBeGreaterThanOrEqual(8);
    for (const name of ALL_PROVIDER_NAMES) {
      expect(searchProviders.has(name)).toBe(true);
    }
  });

  it("getSearchProvider returns provider by name", () => {
    for (const name of ALL_PROVIDER_NAMES) {
      const provider = getSearchProvider(name);
      expect(provider).toBeDefined();
      expect(provider!.name).toBe(name);
    }
  });

  it("getSearchProvider returns undefined for unknown provider", () => {
    expect(getSearchProvider("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-provider descriptor validation
// ---------------------------------------------------------------------------

describe("SearchProvider descriptor validation", () => {
  for (const name of ALL_PROVIDER_NAMES) {
    describe(`${name} provider`, () => {
      it("has a valid name string", () => {
        const provider = getSearchProvider(name);
        expect(provider).toBeDefined();
        expect(typeof provider!.name).toBe("string");
        expect(provider!.name).toBe(name);
      });

      it("has a boolean requiresApiKey", () => {
        const provider = getSearchProvider(name);
        expect(provider).toBeDefined();
        expect(typeof provider!.requiresApiKey).toBe("boolean");
      });

      it("has correct requiresApiKey value", () => {
        const provider = getSearchProvider(name);
        expect(provider).toBeDefined();
        if (PROVIDERS_REQUIRING_API_KEY.has(name)) {
          expect(provider!.requiresApiKey).toBe(true);
        } else if (PROVIDERS_WITHOUT_API_KEY.has(name)) {
          expect(provider!.requiresApiKey).toBe(false);
        }
      });

      it("has an execute function", () => {
        const provider = getSearchProvider(name);
        expect(provider).toBeDefined();
        expect(typeof provider!.execute).toBe("function");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Execute shape tests (mocked HTTP)
// ---------------------------------------------------------------------------

describe("SearchProvider execute return shape", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockImpitFetch.mockReset();
  });

  it("brave returns { results, count } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        web: {
          results: [{ title: "Test", url: "https://example.com", description: "A test result" }],
        },
      }), { status: 200 }),
    );

    const provider = getSearchProvider("brave")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "test-key",
      timeoutSeconds: 10,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("count");
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.count).toBe("number");
  });

  it("duckduckgo returns { results, count } shape via impit", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(
        '<a class="result__a" href="https://example.com">Test</a>' +
        '<a class="result__snippet">A test snippet</a>',
      ),
    });

    const provider = getSearchProvider("duckduckgo")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "no-key-needed",
      timeoutSeconds: 10,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("count");
    expect(Array.isArray(result.results)).toBe(true);
  });

  it("exa returns { results, count } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        results: [{ title: "Test", url: "https://example.com", summary: "A test" }],
      }), { status: 200 }),
    );

    const provider = getSearchProvider("exa")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "test-key",
      timeoutSeconds: 10,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("count");
  });

  it("grok returns { content, citations } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        output: [{ type: "message", role: "assistant", content: [{ type: "text", text: "AI answer" }] }],
        citations: ["https://source.com"],
      }), { status: 200 }),
    );

    const provider = getSearchProvider("grok")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "test-key",
      timeoutSeconds: 10,
      providerConfig: { model: "grok-4-1-fast", inlineCitations: false },
    });

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("citations");
    expect(typeof result.content).toBe("string");
    expect(Array.isArray(result.citations)).toBe(true);
  });

  it("jina returns { results, count } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ title: "Test", url: "https://example.com", description: "A test" }],
      }), { status: 200 }),
    );

    const provider = getSearchProvider("jina")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "test-key",
      timeoutSeconds: 10,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("count");
  });

  it("perplexity returns { content, citations } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: "AI answer" } }],
        citations: ["https://source.com"],
      }), { status: 200 }),
    );

    const provider = getSearchProvider("perplexity")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "test-key",
      timeoutSeconds: 10,
      providerConfig: {
        baseUrl: "https://api.perplexity.ai",
        model: "sonar-pro",
      },
    });

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("citations");
  });

  it("searxng returns { results, count } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        results: [{ title: "Test", url: "https://example.com", content: "A test" }],
      }), { status: 200 }),
    );

    const provider = getSearchProvider("searxng")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "no-key-needed",
      timeoutSeconds: 10,
      providerConfig: { baseUrl: "https://searxng.example.com" },
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("count");
  });

  it("tavily returns { results, count } shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        results: [{ title: "Test", url: "https://example.com", content: "A test" }],
      }), { status: 200 }),
    );

    const provider = getSearchProvider("tavily")!;
    const result = await provider.execute({
      query: "test",
      count: 5,
      apiKey: "test-key",
      timeoutSeconds: 10,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("count");
  });
});

// ---------------------------------------------------------------------------
// Provider export validation
// ---------------------------------------------------------------------------

describe("Provider modules export descriptors", () => {
  it("brave exports braveProvider", async () => {
    const mod = await import("./web-search-brave.js");
    expect(mod.braveProvider).toBeDefined();
    expect(mod.braveProvider.name).toBe("brave");
  });

  it("duckduckgo exports duckduckgoProvider", async () => {
    const mod = await import("./web-search-duckduckgo.js");
    expect(mod.duckduckgoProvider).toBeDefined();
    expect(mod.duckduckgoProvider.name).toBe("duckduckgo");
  });

  it("exa exports exaProvider", async () => {
    const mod = await import("./web-search-exa.js");
    expect(mod.exaProvider).toBeDefined();
    expect(mod.exaProvider.name).toBe("exa");
  });

  it("grok exports grokProvider", async () => {
    const mod = await import("./web-search-grok.js");
    expect(mod.grokProvider).toBeDefined();
    expect(mod.grokProvider.name).toBe("grok");
  });

  it("jina exports jinaProvider", async () => {
    const mod = await import("./web-search-jina.js");
    expect(mod.jinaProvider).toBeDefined();
    expect(mod.jinaProvider.name).toBe("jina");
  });

  it("perplexity exports perplexityProvider", async () => {
    const mod = await import("./web-search-perplexity.js");
    expect(mod.perplexityProvider).toBeDefined();
    expect(mod.perplexityProvider.name).toBe("perplexity");
  });

  it("searxng exports searxngProvider", async () => {
    const mod = await import("./web-search-searxng.js");
    expect(mod.searxngProvider).toBeDefined();
    expect(mod.searxngProvider.name).toBe("searxng");
  });

  it("tavily exports tavilyProvider", async () => {
    const mod = await import("./web-search-tavily.js");
    expect(mod.tavilyProvider).toBeDefined();
    expect(mod.tavilyProvider.name).toBe("tavily");
  });
});
