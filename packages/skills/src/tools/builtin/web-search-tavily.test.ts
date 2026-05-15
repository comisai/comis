// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Tavily AI Search provider module (web-search-tavily.ts).
 *
 * Covers: runTavilySearch() with mocked fetch — happy path, error payload,
 * non-OK status, days parameter optional inclusion, missing-field branches.
 * Plan 40-11 branch-gap closure.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTavilySearch } from "./web-search-tavily.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runTavilySearch", () => {
  it("returns structured results when Tavily responds with results array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "Tavily Result One",
            url: "https://example.com/one",
            content: "Content one",
          },
          {
            title: "Tavily Result Two",
            url: "https://example.com/two",
            content: "Content two",
          },
        ],
      }),
    });
    const result = await runTavilySearch({
      query: "test",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(2);
    expect(result.results[0]!.title).toContain("Tavily Result One");
  });

  it("respects max_results when count limits the results returned", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i}`,
          url: `https://example.com/${i}`,
          content: `Content ${i}`,
        })),
      }),
    });
    const result = await runTavilySearch({
      query: "many",
      count: 3,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(3);
  });

  it("includes days field in the POST body when caller provides it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    globalThis.fetch = fetchSpy;
    await runTavilySearch({
      query: "recent",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
      days: 7,
    });
    const callArgs = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse((callArgs as { body: string }).body) as Record<string, unknown>;
    expect(body.days).toBe(7);
  });

  it("omits days field from the POST body when caller does not provide it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    globalThis.fetch = fetchSpy;
    await runTavilySearch({
      query: "anytime",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    const callArgs = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse((callArgs as { body: string }).body) as Record<string, unknown>;
    expect(body.days).toBeUndefined();
  });

  it("throws when Tavily API responds with non-OK status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "Subscription expired",
      headers: { get: () => "text/plain" },
    });
    await expect(
      runTavilySearch({
        query: "denied",
        count: 5,
        apiKey: "fake-key",
        timeoutSeconds: 10,
      }),
    ).rejects.toThrow(/Tavily API error \(403\)/);
  });

  it("throws when Tavily returns JSON error field in the body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "Invalid query syntax" }),
    });
    await expect(
      runTavilySearch({
        query: "bad",
        count: 5,
        apiKey: "fake-key",
        timeoutSeconds: 10,
      }),
    ).rejects.toThrow(/Tavily API error: Invalid query syntax/);
  });

  it("returns empty result list when results field is missing entirely", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const result = await runTavilySearch({
      query: "void",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(0);
  });

  it("returns empty result list when results is not an array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: "not-an-array" }),
    });
    const result = await runTavilySearch({
      query: "shape",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(0);
  });

  it("handles entries with missing title and content fields gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ url: "https://example.com/sparse" }] }),
    });
    const result = await runTavilySearch({
      query: "sparse",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(1);
    expect(result.results[0]!.title).toBe("");
    expect(result.results[0]!.description).toBe("");
    expect(result.results[0]!.url).toBe("https://example.com/sparse");
  });
});
