/**
 * Tests for the DuckDuckGo HTML search provider module (web-search-duckduckgo.ts).
 *
 * Covers: HTML parsing, entity decoding, tag stripping, redirect URL extraction,
 * count limiting, empty results, and HTTP error handling.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runDuckDuckGoSearch, parseDdgHtml } from "./web-search-duckduckgo.js";

// Mock @comis/core: keep real wrapWebContent
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual };
});

// Mock impit module — intercept Impit constructor to control fetch behavior
const mockImpitFetch = vi.fn();
vi.mock("impit", () => ({
  Impit: class {
    fetch = mockImpitFetch;
  },
}));

afterEach(() => {
  mockImpitFetch.mockReset();
});

// ---------------------------------------------------------------------------
// Realistic DDG HTML fixture helpers
// ---------------------------------------------------------------------------

function makeDdgResult(opts: {
  title: string;
  href: string;
  snippet: string;
}): string {
  return `
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${opts.href}">${opts.title}</a>
    </h2>
    <a class="result__snippet" href="${opts.href}">${opts.snippet}</a>
  </div>
</div>`;
}

function wrapDdgPage(resultsHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><title>DuckDuckGo</title></head>
<body>
<div id="links" class="results">
${resultsHtml}
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// parseDdgHtml (unit tests for parser)
// ---------------------------------------------------------------------------

describe("parseDdgHtml", () => {
  it("parses valid HTML results with redirect URLs", () => {
    const html = wrapDdgPage(
      makeDdgResult({
        title: "Example News",
        href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews&amp;rut=abc",
        snippet: "Latest news from example.",
      }) +
        makeDdgResult({
          title: "Another Result",
          href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.org%2Fpage&amp;rut=def",
          snippet: "Another description here.",
        }) +
        makeDdgResult({
          title: "Third Result",
          href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.net%2F&amp;rut=ghi",
          snippet: "Third snippet.",
        }),
    );

    const results = parseDdgHtml(html);
    expect(results).toHaveLength(3);
    expect(results[0].title).toBe("Example News");
    expect(results[0].url).toBe("https://example.com/news");
    expect(results[0].description).toBe("Latest news from example.");
    expect(results[1].url).toBe("https://other.org/page");
    expect(results[2].url).toBe("https://third.net/");
  });

  it("handles empty results page", () => {
    const html = wrapDdgPage("");
    const results = parseDdgHtml(html);
    expect(results).toEqual([]);
  });

  it("decodes HTML entities in titles and descriptions", () => {
    const html = wrapDdgPage(
      makeDdgResult({
        title: "Tom &amp; Jerry &lt;2024&gt;",
        href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com",
        snippet: "A &quot;classic&quot; show &#39;indeed&#39;",
      }),
    );

    const results = parseDdgHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Tom & Jerry <2024>');
    expect(results[0].description).toBe('A "classic" show \'indeed\'');
  });

  it("strips HTML tags from extracted text", () => {
    const html = wrapDdgPage(
      makeDdgResult({
        title: "<b>Bold Title</b>",
        href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com",
        snippet: "Some <b>bold</b> and <i>italic</i> text here.",
      }),
    );

    const results = parseDdgHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Bold Title");
    expect(results[0].description).toBe("Some bold and italic text here.");
  });

  it("handles redirect URL extraction from uddg parameter", () => {
    const html = wrapDdgPage(
      makeDdgResult({
        title: "News Article",
        href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%3Fid%3D42&amp;rut=abc123",
        snippet: "Breaking news.",
      }),
    );

    const results = parseDdgHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/news?id=42");
  });

  it("skips results where URL extraction fails", () => {
    const html = `
<div class="result">
  <a class="result__a" href="javascript:void(0)">Bad Link</a>
  <a class="result__snippet">Should be skipped</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgood.com">Good Link</a>
  <a class="result__snippet">Should be included</a>
</div>`;

    const results = parseDdgHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://good.com");
  });

  it("includes results with title but no snippet", () => {
    // When there are more links than snippets, description should be empty string
    const html = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Title Only</a>
</div>`;

    const results = parseDdgHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Title Only");
    expect(results[0].url).toBe("https://example.com");
    expect(results[0].description).toBe("");
  });
});

// ---------------------------------------------------------------------------
// runDuckDuckGoSearch (integration with impit mock)
// ---------------------------------------------------------------------------

describe("runDuckDuckGoSearch", () => {
  it("returns wrapped results from valid HTML response", async () => {
    const mockHtml = wrapDdgPage(
      makeDdgResult({
        title: "Test Result",
        href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Ftest.com",
        snippet: "A test snippet.",
      }),
    );

    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => mockHtml,
    });

    const result = await runDuckDuckGoSearch({
      query: "test",
      count: 5,
      timeoutSeconds: 10,
    });

    expect(result.count).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toContain("Test Result");
    // wrapWebContent adds UNTRUSTED markers
    expect(result.results[0].title).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(result.results[0].url).toBe("https://test.com");
  });

  it("handles empty results page", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => wrapDdgPage(""),
    });

    const result = await runDuckDuckGoSearch({
      query: "nothing",
      count: 5,
      timeoutSeconds: 10,
    });

    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("respects count limit", async () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeDdgResult({
        title: `Result ${i + 1}`,
        href: `//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample${i}.com`,
        snippet: `Snippet ${i + 1}`,
      }),
    ).join("\n");

    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => wrapDdgPage(results),
    });

    const result = await runDuckDuckGoSearch({
      query: "many results",
      count: 3,
      timeoutSeconds: 10,
    });

    expect(result.count).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  it("throws on HTTP error", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "Access denied",
    });

    await expect(
      runDuckDuckGoSearch({ query: "fail", count: 5, timeoutSeconds: 10 }),
    ).rejects.toThrow("DuckDuckGo search error (403)");
  });

  it("sends POST request to DDG endpoint with form body", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => wrapDdgPage(""),
    });

    await runDuckDuckGoSearch({
      query: "test query",
      count: 5,
      timeoutSeconds: 10,
    });

    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockImpitFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("https://html.duckduckgo.com/html/");
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.body).toContain("q=test+query");
    expect(opts.timeout).toBe(10_000);
  });
});
