/**
 * Tests for link understanding pipeline runner.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinkUnderstandingConfig } from "@comis/core";

// Mock the link-fetcher module
vi.mock("./link-fetcher.js", () => ({
  fetchLinkContent: vi.fn(),
}));

// Mock the link-formatter module
vi.mock("./link-formatter.js", () => ({
  formatLinkContext: vi.fn(),
  injectLinkContext: vi.fn(),
}));

import { createLinkRunner } from "./link-runner.js";
import { fetchLinkContent } from "./link-fetcher.js";
import { formatLinkContext, injectLinkContext } from "./link-formatter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<LinkUnderstandingConfig> = {}): LinkUnderstandingConfig {
  return {
    enabled: true,
    maxLinks: 3,
    fetchTimeoutMs: 10_000,
    maxContentChars: 5000,
    userAgentString: "Comis/1.0 (Test)",
    ...overrides,
  };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

// ---------------------------------------------------------------------------
// createLinkRunner
// ---------------------------------------------------------------------------

describe("createLinkRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short-circuits when disabled", async () => {
    const runner = createLinkRunner({
      config: makeConfig({ enabled: false }),
      logger: mockLogger,
    });

    const result = await runner.processMessage("Check https://example.com");

    expect(result.enrichedText).toBe("Check https://example.com");
    expect(result.linksProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
    // fetchLinkContent should never be called
    expect(fetchLinkContent).not.toHaveBeenCalled();
  });

  it("processes single URL end-to-end", async () => {
    const mockFetch = vi.mocked(fetchLinkContent);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      value: { title: "Example", content: "Example content", url: "https://example.com" },
    } as any);

    const mockFormat = vi.mocked(formatLinkContext);
    mockFormat.mockReturnValue("[Link: Example](https://example.com)\nExample content");

    const mockInject = vi.mocked(injectLinkContext);
    mockInject.mockReturnValue("Hello https://example.com\n\n--- Linked Content ---\n\n[Link: Example]...");

    const runner = createLinkRunner({
      config: makeConfig(),
      logger: mockLogger,
    });

    const result = await runner.processMessage("Hello https://example.com");

    expect(result.linksProcessed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFormat).toHaveBeenCalledOnce();
    expect(mockInject).toHaveBeenCalledOnce();
  });

  it("handles fetch failures gracefully", async () => {
    const mockFetch = vi.mocked(fetchLinkContent);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      error: new Error("HTTP 500"),
    } as any);

    const mockFormat = vi.mocked(formatLinkContext);
    mockFormat.mockReturnValue("");

    const mockInject = vi.mocked(injectLinkContext);
    mockInject.mockImplementation((text) => text);

    const runner = createLinkRunner({
      config: makeConfig(),
      logger: mockLogger,
    });

    const result = await runner.processMessage("Check https://example.com");

    expect(result.linksProcessed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("HTTP 500");
    // Original text should be preserved
    expect(mockInject).toHaveBeenCalled();
  });

  it("limits concurrent fetches to maxLinks", async () => {
    const mockFetch = vi.mocked(fetchLinkContent);
    mockFetch.mockResolvedValue({
      ok: true,
      value: { title: "Page", content: "Content", url: "https://example.com" },
    } as any);

    const mockFormat = vi.mocked(formatLinkContext);
    mockFormat.mockReturnValue("formatted");

    const mockInject = vi.mocked(injectLinkContext);
    mockInject.mockReturnValue("injected");

    const runner = createLinkRunner({
      config: makeConfig({ maxLinks: 2 }),
      logger: mockLogger,
    });

    const text = "https://one.com https://two.com https://three.com https://four.com https://five.com";
    await runner.processMessage(text);

    // Should only fetch maxLinks (2) URLs despite 5 being present
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns original text when no URLs found", async () => {
    const mockInject = vi.mocked(injectLinkContext);

    const runner = createLinkRunner({
      config: makeConfig(),
      logger: mockLogger,
    });

    const result = await runner.processMessage("Hello world, no links here");

    expect(result.enrichedText).toBe("Hello world, no links here");
    expect(result.linksProcessed).toBe(0);
    expect(result.errors).toHaveLength(0);
    // fetchLinkContent should not be called
    expect(fetchLinkContent).not.toHaveBeenCalled();
  });

  it("handles promise rejections (network errors) gracefully", async () => {
    const mockFetch = vi.mocked(fetchLinkContent);
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

    const mockFormat = vi.mocked(formatLinkContext);
    mockFormat.mockReturnValue("");

    const mockInject = vi.mocked(injectLinkContext);
    mockInject.mockImplementation((text) => text);

    const runner = createLinkRunner({
      config: makeConfig(),
      logger: mockLogger,
    });

    const result = await runner.processMessage("Check https://example.com");

    expect(result.linksProcessed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Network timeout");
  });
});
