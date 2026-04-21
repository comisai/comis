// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for web-fetch tool: readability extraction, caching, content wrapping, error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool, __clearFetchCache } from "./web-fetch-tool.js";

// Mock @comis/core: validateUrl + wrapWebContent
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    validateUrl: vi.fn().mockResolvedValue({
      ok: true,
      value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("http://example.com") },
    }),
  };
});

// Mock impit module — intercept Impit constructor to control fetch behavior
const mockImpitFetch = vi.fn();
vi.mock("impit", () => ({
  Impit: class {
    fetch = mockImpitFetch;
  },
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

function parseResult(result: { content: { type: string; text: string }[] }): Record<string, unknown> {
  const raw = textOf(result);
  // Strip SECURITY NOTICE prefix (single notice prepended to tool result)
  const jsonStart = raw.indexOf("{");
  return JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
}

const SAMPLE_HTML = `
<!DOCTYPE html>
<html><head><title>Test Page</title></head>
<body>
<h1>Hello World</h1>
<p>This is a test paragraph with some content.</p>
<p>Another paragraph here.</p>
</body></html>
`;

const SAMPLE_JSON = JSON.stringify({ name: "test", value: 42 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function allowSsrf(): Promise<void> {
  const { validateUrl } = await import("@comis/core");
  vi.mocked(validateUrl).mockResolvedValue({
    ok: true,
    value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("http://example.com") },
  });
}

beforeEach(async () => {
  __clearFetchCache();
  mockImpitFetch.mockReset();
  vi.restoreAllMocks();
  await allowSsrf();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web-fetch-tool", () => {
  it("has correct tool metadata", () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe("web_fetch");
    expect(tool.label).toBe("Web Fetch");
    expect(tool.description).toContain("readable content");
    expect(tool.parameters).toBeDefined();
  });

  it("returns SSRF error when validateUrl rejects", async () => {
    const { validateUrl } = await import("@comis/core");
    vi.mocked(validateUrl).mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-1", {
      url: "http://localhost:1/admin",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("SSRF blocked");
    expect(parsed.error).toContain("loopback");
  });

  it("extracts readable content from HTML (readability)", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => SAMPLE_HTML,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-2", {
      url: "http://example.com/page",
    });

    const parsed = parseResult(result);
    expect(parsed.status).toBe(200);
    expect(parsed.extractMode).toBe("markdown");
    // Extractor should be readability or htmlToMarkdown fallback
    expect(["readability", "htmlToMarkdown"]).toContain(parsed.extractor);
    // Content should be wrapped with security markers (dynamic random delimiters)
    expect(parsed.text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    // Content should contain actual page content
    expect(parsed.text).toContain("Hello World");
  });

  it("handles JSON response with pretty-print", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => SAMPLE_JSON,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-3", {
      url: "http://example.com/api/data",
    });

    const parsed = parseResult(result);
    expect(parsed.extractor).toBe("json");
    expect(parsed.text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    // JSON should be pretty-printed (contains newlines)
    expect(parsed.text).toContain('"name"');
    expect(parsed.text).toContain('"test"');
  });

  it("uses cache on second call with same URL", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "plain text content",
    });

    const tool = createWebFetchTool();

    // First call - hits fetch
    await tool.execute("call-4a", { url: "http://example.com/cached" });
    expect(mockImpitFetch).toHaveBeenCalledTimes(1);

    // Second call - should use cache
    const result2 = await tool.execute("call-4b", { url: "http://example.com/cached" });
    expect(mockImpitFetch).toHaveBeenCalledTimes(1); // still 1

    const parsed = parseResult(result2);
    expect(parsed.cached).toBe(true);
  });

  it("wraps output with UNTRUSTED content markers", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "Some fetched content",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-5", {
      url: "http://example.com/content",
    });

    const parsed = parseResult(result);
    expect(typeof parsed.text).toBe("string");
    expect(parsed.text as string).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(parsed.text as string).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
    expect(parsed.text as string).toContain("Some fetched content");
  });

  it("handles fetch timeout gracefully", async () => {
    mockImpitFetch.mockRejectedValue(new Error("The operation was aborted"));

    const tool = createWebFetchTool({ timeoutSeconds: 1 });
    const result = await tool.execute("call-6", {
      url: "http://slow.example.com/timeout",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("Fetch failed");
    expect(parsed.error).toContain("aborted");
  });

  it("handles HTTP 404 error response", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers({}),
      text: async () => "Page not found",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-7", {
      url: "http://example.com/missing",
    });

    const parsed = parseResult(result);
    expect(parsed.status).toBe(404);
    expect(parsed.error).toContain("HTTP 404");
    expect(parsed.contentLength).toBeNull();
    expect(parsed.errorBody).toBe("Page not found");
    expect(parsed.errorBodyTruncated).toBe(false);
  });

  it("handles HTTP 500 error response", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({}),
      text: async () => "Server error",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-8", {
      url: "http://example.com/error",
    });

    const parsed = parseResult(result);
    expect(parsed.status).toBe(500);
    expect(parsed.error).toContain("HTTP 500");
    expect(parsed.contentLength).toBeNull();
    expect(parsed.errorBody).toBe("Server error");
    expect(parsed.errorBodyTruncated).toBe(false);
  });

  it("supports extractMode=text", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => SAMPLE_HTML,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-9", {
      url: "http://example.com/page",
      extractMode: "text",
    });

    const parsed = parseResult(result);
    expect(parsed.extractMode).toBe("text");
    // Text mode should still contain the content
    expect(parsed.text).toContain("Hello World");
  });

  it("respects maxChars parameter for truncation", async () => {
    const longContent = "x".repeat(100_000);
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => longContent,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-10", {
      url: "http://example.com/large",
      maxChars: 500,
    });

    const parsed = parseResult(result);
    expect(parsed.truncated).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Error body truncation to 500 chars
  // ---------------------------------------------------------------------------

  it("truncates large error response body to 500 chars", async () => {
    const largeBody = "<html>" + "x".repeat(10_000) + "</html>";
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Headers({ "content-length": String(largeBody.length) }),
      text: async () => largeBody,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch01", {
      url: "http://example.com/large-error",
    });

    const parsed = parseResult(result);
    expect(parsed.status).toBe(503);
    expect((parsed.errorBody as string).length).toBeLessThanOrEqual(500);
    expect(parsed.errorBodyTruncated).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Content-length field in error responses
  // ---------------------------------------------------------------------------

  it("includes content-length in error response", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({ "content-length": "50000" }),
      text: async () => "Server error",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch02a", {
      url: "http://example.com/with-content-length",
    });

    const parsed = parseResult(result);
    expect(parsed.contentLength).toBe(50000);
  });

  it("returns null content-length when header missing", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers({}),
      text: async () => "Not found",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch02b", {
      url: "http://example.com/no-content-length",
    });

    const parsed = parseResult(result);
    expect(parsed.contentLength).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Error page pattern detection
  // ---------------------------------------------------------------------------

  it("detects Cloudflare error page and returns description", async () => {
    const cloudflareBody = `
      <html>
      <head><title>Attention Required! | Cloudflare</title></head>
      <body>
        <div class="cf-browser-verification">Checking your browser before accessing</div>
        <span class="cf-error-details">Ray ID: abc123</span>
      </body>
      </html>
    `;
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers({ "content-length": String(cloudflareBody.length) }),
      text: async () => cloudflareBody,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch03a", {
      url: "http://example.com/cloudflare-blocked",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("Cloudflare");
    expect(parsed.status).toBe(403);
    expect(parsed.errorBody).toBeDefined();
  });

  it("detects CAPTCHA challenge page", async () => {
    const captchaBody = `
      <html>
      <head><title>Security Check</title></head>
      <body>
        <div class="g-recaptcha" data-sitekey="abc"></div>
        <p>Please verify you are human</p>
      </body>
      </html>
    `;
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers({}),
      text: async () => captchaBody,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch03b", {
      url: "http://example.com/captcha-challenge",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("CAPTCHA");
  });

  it("detects rate limit page", async () => {
    const rateLimitBody = "Rate limit exceeded. Please retry after 60 seconds.";
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "content-length": String(rateLimitBody.length) }),
      text: async () => rateLimitBody,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch03c", {
      url: "http://example.com/rate-limited",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("Rate limited");
    expect(parsed.status).toBe(429);
  });

  it("detects access denied page", async () => {
    const accessDeniedBody = `
      <html><head><title>403 Forbidden</title></head>
      <body><h1>Access Denied</h1><p>You don't have permission to access this resource.</p></body>
      </html>
    `;
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers({}),
      text: async () => accessDeniedBody,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch03d", {
      url: "http://example.com/access-denied",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("Access denied");
  });

  it("detects bot detection page", async () => {
    const botBody = `
      <html><head><title>Pardon Our Interruption</title></head>
      <body><p>Pardon Our Interruption - automated access detected.</p></body>
      </html>
    `;
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers({}),
      text: async () => botBody,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch03e", {
      url: "http://example.com/bot-detected",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("bot detection");
  });

  it("falls back to truncated body when no pattern matches", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers({}),
      text: async () => "Internal Server Error - unexpected failure in backend service",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-fetch01-fallback", {
      url: "http://example.com/generic-error",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("HTTP 500");
    expect(parsed.error).toContain("Internal Server Error");
    expect(parsed.errorBody).toContain("unexpected failure");
  });

  // ---------------------------------------------------------------------------
  // Redirect blocking via impit followRedirects: false
  // ---------------------------------------------------------------------------

  it("blocks redirects by returning error for 3xx responses", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 302,
      statusText: "Found",
      headers: new Headers({ location: "http://internal.example.com/secret" }),
      text: async () => "",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-ssrf02a", {
      url: "http://example.com/redirect",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("Redirects are blocked for security");
  });

  it("blocks 301 permanent redirects", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: false,
      status: 301,
      statusText: "Moved Permanently",
      headers: new Headers({ location: "http://evil.internal/admin" }),
      text: async () => "",
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-ssrf02b", {
      url: "http://evil.com/redirect-to-internal",
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain("Redirects are blocked for security");
  });

  it("returns structured JSON result with expected fields", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => SAMPLE_HTML,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-11", {
      url: "http://example.com/structured",
    });

    const parsed = parseResult(result);
    expect(parsed).toHaveProperty("url");
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("contentType");
    expect(parsed).toHaveProperty("extractMode");
    expect(parsed).toHaveProperty("extractor");
    expect(parsed).toHaveProperty("truncated");
    expect(parsed).toHaveProperty("length");
    expect(parsed).toHaveProperty("text");
    expect(parsed).toHaveProperty("tookMs");
    expect(parsed).toHaveProperty("fetchedAt");
  });

  // ---------------------------------------------------------------------------
  // Byte-level truncation with truncation metadata
  // ---------------------------------------------------------------------------

  it("includes bytesRead and bodyTruncated=false for small responses", async () => {
    const content = "Small content";
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => content,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-src08a", {
      url: "http://example.com/small",
    });

    const parsed = parseResult(result);
    expect(parsed.bodyTruncated).toBe(false);
    expect(parsed.bytesRead).toBeGreaterThan(0);
  });

  it("includes totalBytes from Content-Length header", async () => {
    const content = "Content with known length";
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "text/plain",
        "content-length": "25",
      }),
      text: async () => content,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-src02a", {
      url: "http://example.com/known-length",
    });

    const parsed = parseResult(result);
    expect(parsed.totalBytes).toBe(25);
  });

  it("returns totalBytes=null when Content-Length header is missing", async () => {
    const content = "Content without content-length";
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => content,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-src02b", {
      url: "http://example.com/no-content-length",
    });

    const parsed = parseResult(result);
    expect(parsed.totalBytes).toBeNull();
  });

  it("truncates large response via byte limit and includes marker", async () => {
    const largeContent = "x".repeat(100_000);
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "text/plain",
        "content-length": String(largeContent.length),
      }),
      text: async () => largeContent,
    });

    // Use a very small byte limit to force truncation
    const tool = createWebFetchTool({ maxResponseBytes: 50_000 });
    const result = await tool.execute("call-src01a", {
      url: "http://example.com/large-body",
    });

    const parsed = parseResult(result);
    expect(parsed.bodyTruncated).toBe(true);
    expect((parsed.bytesRead as number)).toBeLessThanOrEqual(50_000);
    // The inline marker should appear in the text
    expect(parsed.text).toContain("Response truncated at");
    expect(parsed.text).toContain("For full content, use targeted CSS selectors");
  });

  it("respects custom maxResponseBytes from config", async () => {
    const content = "Normal content";
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => content,
    });

    // Custom maxResponseBytes that is larger than content
    const tool = createWebFetchTool({ maxResponseBytes: 1_000_000 });
    const result = await tool.execute("call-src08b", {
      url: "http://example.com/custom-bytes",
    });

    const parsed = parseResult(result);
    expect(parsed.bodyTruncated).toBe(false);
    expect(parsed.text).toContain("Normal content");
  });

  // ---------------------------------------------------------------------------
  // Impit client usage verification
  // ---------------------------------------------------------------------------

  it("uses impit client with correct options for fetch (impit)", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "content",
    });

    const tool = createWebFetchTool({ timeoutSeconds: 15 });
    await tool.execute("call-impit", { url: "http://example.com/test" });

    expect(mockImpitFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockImpitFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("http://example.com/test");
    expect(opts.method).toBe("GET");
    expect(opts.timeout).toBe(15_000);
  });

  // ---------------------------------------------------------------------------
  // arxiv URL rewrite and PDF content-type extraction
  // ---------------------------------------------------------------------------

  it("rewrites arxiv.org/pdf/ URLs to /abs/ before fetching", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => "<html><head><title>arXiv Paper</title></head><body><h1>Paper Title</h1><p>Abstract text</p></body></html>",
    });

    const tool = createWebFetchTool();
    await tool.execute("call-arxiv", { url: "https://arxiv.org/pdf/2412.20138" });

    // Verify impit was called with the rewritten /abs/ URL, not /pdf/
    const [fetchedUrl] = mockImpitFetch.mock.calls[0] as [string, unknown];
    expect(fetchedUrl).toBe("https://arxiv.org/abs/2412.20138");
  });

  it("rewrites arxiv.org/pdf/ URLs with version suffix", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<html><body>Paper</body></html>",
    });

    const tool = createWebFetchTool();
    await tool.execute("call-arxiv-v", { url: "https://arxiv.org/pdf/2412.20138v2" });

    const [fetchedUrl] = mockImpitFetch.mock.calls[0] as [string, unknown];
    // The regex captures \d+\.\d+ so the version suffix is preserved in the base match
    expect(fetchedUrl).toContain("arxiv.org/abs/2412.20138");
  });

  it("does not rewrite non-arxiv PDF URLs", async () => {
    // Mock as PDF content-type with bytes() method
    const fakeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF magic bytes
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/pdf" }),
      bytes: async () => fakeBytes,
      text: async () => { throw new Error("text() should not be called for PDF"); },
    });

    const tool = createWebFetchTool();
    // This will trigger PDF extraction which will fail (no real PDF), but the URL should be unchanged
    await tool.execute("call-norewrite", { url: "https://example.com/paper.pdf" });

    const [fetchedUrl] = mockImpitFetch.mock.calls[0] as [string, unknown];
    expect(fetchedUrl).toBe("https://example.com/paper.pdf");
  });

  it("uses pdf extractor for application/pdf content-type", async () => {
    const fakeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-
    let textCalled = false;
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/pdf" }),
      bytes: async () => fakeBytes,
      text: async () => { textCalled = true; return "binary garbage"; },
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-pdf", { url: "https://example.com/doc.pdf" });
    const parsed = parseResult(result);

    // text() should NOT have been called (binary safety)
    expect(textCalled).toBe(false);
    // Result should indicate PDF extraction was attempted
    // Since our fake bytes are not a real PDF, extraction will fail with an error
    expect(parsed.error).toContain("PDF extraction failed");
  });

  it("text/html and application/json are unaffected by PDF branch", async () => {
    mockImpitFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => SAMPLE_HTML,
    });

    const tool = createWebFetchTool();
    const result = await tool.execute("call-html-still-works", { url: "http://example.com/page" });
    const parsed = parseResult(result);

    expect(["readability", "htmlToMarkdown"]).toContain(parsed.extractor);
    expect(parsed.text).toContain("Hello World");
  });
});
