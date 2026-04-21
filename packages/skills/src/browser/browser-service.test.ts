// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for BrowserService, focused on the navigate() method's
 * defense-in-depth URL protocol validation.
 *
 * Playwright and Chrome dependencies are fully mocked since these tests
 * validate input validation logic, not browser interaction.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock all Playwright/Chrome dependencies before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("./config.js", () => ({
  resolveBrowserConfig: vi.fn((partial: any) => ({
    cdpPort: 9222,
    timeoutMs: 20_000,
    snapshotMaxChars: 50_000,
    screenshotQuality: 80,
    ...partial,
  })),
}));

vi.mock("./chrome-detection.js", () => ({
  launchChrome: vi.fn(),
  stopChrome: vi.fn(),
}));

const mockGoto = vi.fn();
const mockPageUrl = vi.fn(() => "https://example.com");
const mockPageTitle = vi.fn(() => Promise.resolve("Example"));
const mockGetTargetId = vi.fn(() => Promise.resolve("target-1"));

const mockPage = {
  goto: mockGoto,
  url: mockPageUrl,
  title: mockPageTitle,
};

vi.mock("./cdp.js", () => ({
  getCdpTargets: vi.fn(),
  getCdpVersion: vi.fn(),
  filterPageTargets: vi.fn(() => []),
}));

vi.mock("./playwright-session.js", () => ({
  createSession: vi.fn(),
  closeSession: vi.fn(),
  getPage: vi.fn(() => Promise.resolve(mockPage)),
  createNewPage: vi.fn(),
  getTargetId: vi.fn(() => Promise.resolve("target-1")),
  isConnected: vi.fn(() => true),
  ensurePageState: vi.fn(() => ({ console: [] })),
}));

vi.mock("./playwright-actions.js", () => ({
  executeAction: vi.fn(),
}));

vi.mock("./playwright-snapshots.js", () => ({
  takeSnapshot: vi.fn(),
}));

vi.mock("./screenshots.js", () => ({
  takeScreenshot: vi.fn(),
  generatePdf: vi.fn(),
}));

import { createBrowserService } from "./browser-service.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrowserService.navigate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoto.mockResolvedValue(undefined);
  });

  it("accepts https:// URLs", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "https://example.com" });
    expect(mockGoto).toHaveBeenCalledOnce();
  });

  it("accepts http:// URLs", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "http://example.com" });
    expect(mockGoto).toHaveBeenCalledOnce();
  });

  it("accepts about: URLs (used for about:blank)", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "about:blank" });
    expect(mockGoto).toHaveBeenCalledOnce();
  });

  it("rejects file:// URLs", async () => {
    const service = createBrowserService();
    await expect(service.navigate({ url: "file:///etc/passwd" })).rejects.toThrow(
      /Blocked protocol.*file:/,
    );
    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("rejects javascript: URLs", async () => {
    const service = createBrowserService();
    await expect(service.navigate({ url: "javascript:alert(1)" })).rejects.toThrow(
      /Blocked protocol.*javascript:/,
    );
    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("rejects data: URLs", async () => {
    const service = createBrowserService();
    await expect(service.navigate({ url: "data:text/html,<h1>evil</h1>" })).rejects.toThrow(
      /Blocked protocol.*data:/,
    );
    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("rejects invalid URLs", async () => {
    const service = createBrowserService();
    await expect(service.navigate({ url: "not-a-valid-url" })).rejects.toThrow("Invalid URL");
    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("rejects empty URL", async () => {
    const service = createBrowserService();
    await expect(service.navigate({ url: "" })).rejects.toThrow("url is required");
    expect(mockGoto).not.toHaveBeenCalled();
  });
});
