// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Brave Search provider module (web-search-brave.ts).
 *
 * Covers: normalizeFreshness() validation, runBraveSearch() with mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeFreshness, runBraveSearch } from "./web-search-brave.js";

// Mock @comis/core: keep real wrapWebContent
vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return { ...actual };
});

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// normalizeFreshness
// ---------------------------------------------------------------------------

describe("normalizeFreshness", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeFreshness(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeFreshness("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeFreshness("   ")).toBeUndefined();
  });

  it("accepts valid shortcuts (pd, pw, pm, py)", () => {
    expect(normalizeFreshness("pd")).toBe("pd");
    expect(normalizeFreshness("pw")).toBe("pw");
    expect(normalizeFreshness("pm")).toBe("pm");
    expect(normalizeFreshness("py")).toBe("py");
  });

  it("handles shortcuts case-insensitively", () => {
    expect(normalizeFreshness("PD")).toBe("pd");
    expect(normalizeFreshness("Pw")).toBe("pw");
    expect(normalizeFreshness("PM")).toBe("pm");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-12-31")).toBe("2024-01-01to2024-12-31");
  });

  it("rejects reversed date ranges", () => {
    expect(normalizeFreshness("2024-12-31to2024-01-01")).toBeUndefined();
  });

  it("rejects invalid date values in range", () => {
    // Month 13 is invalid
    expect(normalizeFreshness("2024-13-01to2024-12-31")).toBeUndefined();
    // Day 32 is invalid
    expect(normalizeFreshness("2024-01-32to2024-12-31")).toBeUndefined();
  });

  it("rejects non-matching format", () => {
    expect(normalizeFreshness("last week")).toBeUndefined();
    expect(normalizeFreshness("2024")).toBeUndefined();
    expect(normalizeFreshness("2024-01")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runBraveSearch
// ---------------------------------------------------------------------------

describe("runBraveSearch", () => {
  it("returns structured results with content wrapping", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            {
              title: "Example",
              url: "https://example.com",
              description: "A description.",
              age: "1 day ago",
            },
          ],
        },
      }),
    });

    const result = await runBraveSearch({
      query: "test",
      count: 5,
      apiKey: "key",
      timeoutSeconds: 10,
    });

    expect(result.count).toBe(1);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain("Example");
    expect(results[0].title).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(results[0].url).toBe("https://example.com");
    expect(results[0].siteName).toBe("example.com");
    expect(results[0].published).toBe("1 day ago");
  });

  it("returns empty array for no results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });

    const result = await runBraveSearch({
      query: "nothing",
      count: 5,
      apiKey: "key",
      timeoutSeconds: 10,
    });

    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "Rate limited",
    });

    await expect(
      runBraveSearch({ query: "fail", count: 5, apiKey: "key", timeoutSeconds: 10 }),
    ).rejects.toThrow("Brave Search API error (429)");
  });

  it("passes freshness, country, and search_lang params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ web: { results: [] } }),
    });
    globalThis.fetch = mockFetch;

    await runBraveSearch({
      query: "test",
      count: 3,
      apiKey: "key",
      timeoutSeconds: 10,
      country: "DE",
      search_lang: "de",
      freshness: "pw",
    });

    const [fetchUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(fetchUrl).toContain("country=DE");
    expect(fetchUrl).toContain("search_lang=de");
    expect(fetchUrl).toContain("freshness=pw");
  });
});
