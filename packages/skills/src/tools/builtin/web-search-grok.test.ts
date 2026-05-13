// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the Grok (xAI) Search provider module (web-search-grok.ts).
 *
 * Covers: extractGrokContent() parsing, runGrokSearch() with mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractGrokContent, runGrokSearch } from "./web-search-grok.js";
import type { GrokSearchResponse } from "./web-search-grok.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// extractGrokContent
// ---------------------------------------------------------------------------

describe("extractGrokContent", () => {
  it("extracts text from output[0].content[0].text (Responses format)", () => {
    const data: GrokSearchResponse = {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from Grok" }],
        },
      ],
    };
    expect(extractGrokContent(data)).toBe("Hello from Grok");
  });

  it("falls back to output_text field", () => {
    const data: GrokSearchResponse = {
      output_text: "Fallback content",
    };
    expect(extractGrokContent(data)).toBe("Fallback content");
  });

  it("returns undefined for empty data", () => {
    expect(extractGrokContent({})).toBeUndefined();
  });

  it("returns undefined when output array has no content", () => {
    const data: GrokSearchResponse = {
      output: [{ type: "message", role: "assistant", content: [] }],
    };
    expect(extractGrokContent(data)).toBeUndefined();
  });

  it("prefers Responses format over output_text", () => {
    const data: GrokSearchResponse = {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Primary" }],
        },
      ],
      output_text: "Fallback",
    };
    expect(extractGrokContent(data)).toBe("Primary");
  });
});

// ---------------------------------------------------------------------------
// runGrokSearch
// ---------------------------------------------------------------------------

describe("runGrokSearch", () => {
  it("returns content and citations on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Grok answer about AI." }],
          },
        ],
        citations: ["https://xai.com", "https://ai.org"],
      }),
    });

    const result = await runGrokSearch({
      query: "what is AI",
      apiKey: "xai-test",
      model: "grok-4-1-fast",
      timeoutSeconds: 10,
      inlineCitations: false,
    });

    expect(result.content).toBe("Grok answer about AI.");
    expect(result.citations).toEqual(["https://xai.com", "https://ai.org"]);
  });

  it("returns inline citations when enabled", async () => {
    const inlineCits = [
      { start_index: 0, end_index: 10, url: "https://xai.com" },
    ];
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Grok text" }],
          },
        ],
        citations: ["https://xai.com"],
        inline_citations: inlineCits,
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await runGrokSearch({
      query: "test",
      apiKey: "xai-test",
      model: "grok-4-1-fast",
      timeoutSeconds: 10,
      inlineCitations: true,
    });

    expect(result.inlineCitations).toEqual(inlineCits);

    // Verify include field was sent
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.include).toEqual(["inline_citations"]);
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server error",
    });

    await expect(
      runGrokSearch({
        query: "fail",
        apiKey: "xai-test",
        model: "grok-4-1-fast",
        timeoutSeconds: 10,
        inlineCitations: false,
      }),
    ).rejects.toThrow("xAI API error (500)");
  });

  it("returns 'No response' when output is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output: [], citations: [] }),
    });

    const result = await runGrokSearch({
      query: "empty",
      apiKey: "xai-test",
      model: "grok-4-1-fast",
      timeoutSeconds: 10,
      inlineCitations: false,
    });

    expect(result.content).toBe("No response");
    expect(result.citations).toEqual([]);
  });
});
