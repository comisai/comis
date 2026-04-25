// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for web_fetch and web_search tools.
 *
 * These tests call the tool factories directly (no daemon boot) and make
 * real HTTP requests to verify content retrieval and search functionality
 * work end-to-end.
 *
 * Phase 34, Plan 02: Browser & Web Tools integration validation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createWebFetchTool,
  __clearFetchCache,
  createWebSearchTool,
  __clearSearchCache,
} from "@comis/skills";

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
  // Strip SECURITY NOTICE prefix that may be prepended to tool results.
  const raw = textOf(result);
  const jsonStart = raw.indexOf("{");
  return JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
}

// ---------------------------------------------------------------------------
// WEB-01: web_fetch
// ---------------------------------------------------------------------------

describe("WEB-01: web_fetch", () => {
  beforeEach(() => {
    __clearFetchCache();
  });

  it(
    "fetches HTML with readability extraction",
    async () => {
      // Use httpbin.org/html which returns a simple HTML page (Moby-Dick excerpt).
      // example.com may not resolve on all DNS servers (NXDOMAIN on some corporate/CI DNS).
      const tool = createWebFetchTool();
      const result = (await tool.execute("test-fetch-html", {
        url: "https://httpbin.org/html",
      })) as ToolResult;

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThanOrEqual(1);

      const parsed = parseResult(result);
      expect(parsed.url).toContain("httpbin.org");
      expect(parsed.status).toBe(200);
      expect(parsed.contentType).toContain("text/html");
      expect(typeof parsed.text).toBe("string");
      // httpbin /html contains "Herman Melville - Moby-Dick"
      expect(parsed.text as string).toContain("Herman Melville");
      expect(parsed.text as string).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
      expect(["readability", "htmlToMarkdown", "raw"]).toContain(parsed.extractor);
    },
    30_000,
  );

  it(
    "fetches JSON from httpbin",
    async () => {
      const tool = createWebFetchTool();
      const result = (await tool.execute("test-fetch-json", {
        url: "https://httpbin.org/json",
      })) as ToolResult;

      const parsed = parseResult(result);
      expect(parsed.status).toBe(200);
      expect(parsed.contentType).toContain("application/json");
      expect(parsed.extractor).toBe("json");
      expect(typeof parsed.text).toBe("string");
      // httpbin /json returns a "slideshow" object
      expect(parsed.text as string).toContain("slideshow");
    },
    30_000,
  );

  it(
    "handles non-existent domain with error response",
    async () => {
      const tool = createWebFetchTool();
      const result = (await tool.execute("test-fetch-bad-domain", {
        url: "https://this-domain-definitely-does-not-exist-comis-test.com",
      })) as ToolResult;

      const text = textOf(result);
      expect(text).toBeTruthy();

      const parsed = parseResult(result);
      expect(parsed.error).toBeDefined();
      expect(typeof parsed.error).toBe("string");
      // Should contain a fetch failure message (not a thrown exception)
      expect(parsed.error as string).toMatch(/fetch failed|getaddrinfo|ENOTFOUND|SSRF/i);
    },
    30_000,
  );

  it(
    "respects maxChars truncation",
    async () => {
      // httpbin /html has enough content that 100 chars will trigger truncation.
      // Use minChars=100 (minClamp) since implementation clamps at 100 minimum.
      const tool = createWebFetchTool();
      const result = (await tool.execute("test-fetch-truncation", {
        url: "https://httpbin.org/html",
        maxChars: 100,
      })) as ToolResult;

      const parsed = parseResult(result);
      expect(parsed.truncated).toBe(true);
      expect(typeof parsed.text).toBe("string");
      // The text is wrapped with dynamic UNTRUSTED_{hex} markers.
      // The underlying content before wrapping was capped near 100 chars.
      expect(parsed.text as string).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// WEB-02: web_search
// ---------------------------------------------------------------------------

describe("WEB-02: web_search", () => {
  beforeEach(() => {
    __clearSearchCache();
  });

  it(
    "returns all_providers_failed when Brave is explicitly selected without API key",
    async () => {
      // Default provider is DuckDuckGo (key-free); explicitly request Brave to
      // exercise the missing-api-key failure path.
      const tool = createWebSearchTool({ provider: "brave" });
      const result = (await tool.execute("test-search-brave-nokey", {
        query: "test",
      })) as ToolResult;

      const parsed = parseResult(result);
      expect(parsed.error).toBe("all_providers_failed");
      expect(parsed.failures).toEqual(
        expect.arrayContaining([expect.stringContaining("brave")]),
      );
    },
    30_000,
  );

  it(
    "returns missing API key error for Perplexity",
    async () => {
      const tool = createWebSearchTool({ provider: "perplexity" });
      const result = (await tool.execute("test-search-perplexity-nokey", {
        query: "test",
      })) as ToolResult;

      const parsed = parseResult(result);
      expect(parsed.error).toBe("all_providers_failed");
      expect(parsed.failures).toEqual(
        expect.arrayContaining([expect.stringContaining("perplexity")]),
      );
    },
    30_000,
  );

  it(
    "returns missing API key error for Grok",
    async () => {
      const tool = createWebSearchTool({ provider: "grok" });
      const result = (await tool.execute("test-search-grok-nokey", {
        query: "test",
      })) as ToolResult;

      const parsed = parseResult(result);
      expect(parsed.error).toBe("all_providers_failed");
      expect(parsed.failures).toEqual(
        expect.arrayContaining([expect.stringContaining("grok")]),
      );
    },
    30_000,
  );

});
