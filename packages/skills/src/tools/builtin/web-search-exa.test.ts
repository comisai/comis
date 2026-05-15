// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Exa Neural Search provider module (web-search-exa.ts).
 *
 * Covers: runExaSearch() with mocked fetch — happy path, error status,
 * startPublishedDate/endPublishedDate optional inclusion, missing-results
 * fallback, summary-vs-text description fallback. Plan 40-11 branch-gap
 * closure.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExaSearch } from "./web-search-exa.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runExaSearch", () => {
  it("returns structured results when Exa responds with results array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "Exa Result",
            url: "https://example.com/exa",
            summary: "Summary text",
          },
        ],
      }),
    });
    const result = await runExaSearch({
      query: "test",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(1);
    expect(result.results[0]!.title).toContain("Exa Result");
    expect(result.results[0]!.description).toContain("Summary text");
  });

  it("falls back to text field when summary is missing on an entry", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "Text Only",
            url: "https://example.com/text",
            text: "Full text content here",
          },
        ],
      }),
    });
    const result = await runExaSearch({
      query: "test",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.results[0]!.description).toContain("Full text content here");
  });

  it("respects numResults when count slices the response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Title ${i}`,
          url: `https://example.com/${i}`,
        })),
      }),
    });
    const result = await runExaSearch({
      query: "many",
      count: 3,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(3);
  });

  it("includes startPublishedDate in request body when caller provides it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    globalThis.fetch = fetchSpy;
    await runExaSearch({
      query: "dated",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
      startPublishedDate: "2024-01-01",
    });
    const callArgs = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse((callArgs as { body: string }).body) as Record<string, unknown>;
    expect(body.startPublishedDate).toBe("2024-01-01");
    expect(body.endPublishedDate).toBeUndefined();
  });

  it("includes endPublishedDate in request body when caller provides it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    globalThis.fetch = fetchSpy;
    await runExaSearch({
      query: "dated",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
      endPublishedDate: "2024-12-31",
    });
    const callArgs = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse((callArgs as { body: string }).body) as Record<string, unknown>;
    expect(body.endPublishedDate).toBe("2024-12-31");
  });

  it("omits date fields from request body when caller does not provide them", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    globalThis.fetch = fetchSpy;
    await runExaSearch({
      query: "anytime",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    const callArgs = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse((callArgs as { body: string }).body) as Record<string, unknown>;
    expect(body.startPublishedDate).toBeUndefined();
    expect(body.endPublishedDate).toBeUndefined();
  });

  it("throws when Exa API responds with non-OK status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server unavailable",
      headers: { get: () => "text/plain" },
    });
    await expect(
      runExaSearch({
        query: "blocked",
        count: 5,
        apiKey: "fake-key",
        timeoutSeconds: 10,
      }),
    ).rejects.toThrow(/Exa API error \(500\)/);
  });

  it("returns empty result list when results field is missing entirely", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const result = await runExaSearch({
      query: "void",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(0);
  });

  it("handles entries with all optional fields missing gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{}] }),
    });
    const result = await runExaSearch({
      query: "sparse",
      count: 5,
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(1);
    expect(result.results[0]!.title).toBe("");
    expect(result.results[0]!.url).toBe("");
    expect(result.results[0]!.description).toBe("");
  });
});
