/**
 * Tests for link-fetcher: SSRF protection, redirect blocking, content extraction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLinkContent, type LinkFetchConfig } from "./link-fetcher.js";

// Mock @comis/core: validateUrl
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

// Mock web-fetch-utils to avoid JSDOM dependency in unit tests
vi.mock("../../builtin/web-fetch-utils.js", () => ({
  extractReadableContent: vi.fn().mockResolvedValue({
    title: "Test Page",
    text: "Extracted content from the page.",
  }),
  truncateText: vi.fn().mockImplementation((text: string, maxChars: number) => ({
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  })),
}));

const DEFAULT_CONFIG: LinkFetchConfig = {
  fetchTimeoutMs: 5000,
  maxContentChars: 10_000,
  userAgentString: "TestAgent/1.0",
};

async function allowSsrf(): Promise<void> {
  const { validateUrl } = await import("@comis/core");
  vi.mocked(validateUrl).mockResolvedValue({
    ok: true,
    value: { hostname: "example.com", ip: "93.184.216.34", url: new URL("http://example.com") },
  });
}

describe("fetchLinkContent", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await allowSsrf();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok result for a valid HTML page", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html><body><p>Hello</p></body></html>",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchLinkContent("http://example.com/page", DEFAULT_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBe("http://example.com/page");
      expect(result.value.title).toBe("Test Page");
      expect(result.value.content).toContain("Extracted content");
    }
  });

  it("passes redirect: 'error' to fetch to prevent SSRF redirect bypass", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html><body>content</body></html>",
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchLinkContent("http://example.com/test", DEFAULT_CONFIG);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.redirect).toBe("error");
  });

  it("does NOT use redirect: 'follow'", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html><body>content</body></html>",
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchLinkContent("http://example.com/test", DEFAULT_CONFIG);

    const fetchOptions = mockFetch.mock.calls[0][1];
    expect(fetchOptions.redirect).not.toBe("follow");
  });

  it("returns error when URL redirects", async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed: redirect mode is set to error"),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchLinkContent("http://evil.com/redirect", DEFAULT_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("redirect");
    }
  });

  it("returns SSRF error when validateUrl rejects", async () => {
    const { validateUrl } = await import("@comis/core");
    vi.mocked(validateUrl).mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });

    const result = await fetchLinkContent("http://localhost/admin", DEFAULT_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("loopback");
    }
  });

  it("returns error for non-OK HTTP status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchLinkContent("http://example.com/missing", DEFAULT_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("404");
    }
  });
});
