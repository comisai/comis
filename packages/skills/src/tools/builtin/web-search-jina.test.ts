// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Jina Reader Search provider module (web-search-jina.ts).
 *
 * Covers: runJinaSearch() with mocked fetch — JSON happy path, plain-text
 * fallback, API error payload detection, non-OK status, and missing-field
 * branches in the result mapper. Plan 40-11 branch-gap closure.
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJinaSearch } from "./web-search-jina.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runJinaSearch", () => {
  it("returns structured results when Jina responds with valid JSON data array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: [
            {
              title: "Example One",
              url: "https://example.com/one",
              description: "Description one",
            },
            {
              title: "Example Two",
              url: "https://example.com/two",
              content: "Content two as fallback",
            },
          ],
        }),
    });
    const result = await runJinaSearch({
      query: "test query",
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(2);
    expect(result.results[0]!.title).toContain("Example One");
    expect(result.results[1]!.description).toContain("Content two as fallback");
  });

  it("falls back to single plain-text result when response is not valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "This is plain text content not in JSON format",
    });
    const result = await runJinaSearch({
      query: "plain query",
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(1);
    expect(result.results[0]!.title).toBeTruthy();
    expect(result.results[0]!.description).toContain("plain text content");
  });

  it("returns empty-description plain-text fallback when response body is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });
    const result = await runJinaSearch({
      query: "empty",
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(1);
    expect(result.results[0]!.description).toBe("");
  });

  it("throws when Jina API responds with non-OK status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
      headers: { get: () => "text/plain" },
    });
    await expect(
      runJinaSearch({
        query: "blocked",
        apiKey: "bad-key",
        timeoutSeconds: 10,
      }),
    ).rejects.toThrow(/Jina API error \(401\)/);
  });

  it("throws when Jina returns JSON error payload with code >= 400", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ code: 422, message: "Query too long" }),
    });
    await expect(
      runJinaSearch({
        query: "x".repeat(10000),
        apiKey: "fake-key",
        timeoutSeconds: 10,
      }),
    ).rejects.toThrow(/Jina API error \(422\): Query too long/);
  });

  it("returns empty result list when JSON data field is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });
    const result = await runJinaSearch({
      query: "void",
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("returns empty result list when JSON data is not an array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: "not-an-array" }),
    });
    const result = await runJinaSearch({
      query: "shape",
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(0);
  });

  it("handles entries with missing title and description fields gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: [{ url: "https://example.com/only-url" }],
        }),
    });
    const result = await runJinaSearch({
      query: "sparse",
      apiKey: "fake-key",
      timeoutSeconds: 10,
    });
    expect(result.count).toBe(1);
    expect(result.results[0]!.title).toBe("");
    expect(result.results[0]!.description).toBe("");
    expect(result.results[0]!.url).toBe("https://example.com/only-url");
  });
});
