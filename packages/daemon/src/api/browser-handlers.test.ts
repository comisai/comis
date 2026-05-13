// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createBrowserHandlers } from "./browser-handlers.js";
import type { BrowserHandlerDeps } from "./browser-handlers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockService() {
  return {
    status: vi.fn().mockResolvedValue({ running: true }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue({ url: "https://example.com" }),
    snapshot: vi.fn().mockResolvedValue({ content: "<html/>" }),
    screenshot: vi.fn().mockResolvedValue({ buffer: Buffer.from("png"), mimeType: "image/png" }),
    pdf: vi.fn().mockResolvedValue({ buffer: Buffer.from("pdf"), mimeType: "application/pdf" }),
    act: vi.fn().mockResolvedValue({ success: true }),
    tabs: vi.fn().mockResolvedValue([]),
    openTab: vi.fn().mockResolvedValue({ targetId: "tab-1" }),
    focusTab: vi.fn().mockResolvedValue(undefined),
    closeTab: vi.fn().mockResolvedValue(undefined),
    console: vi.fn().mockResolvedValue([]),
  };
}

function makeDeps(overrides?: Partial<BrowserHandlerDeps>): BrowserHandlerDeps {
  const mockService = makeMockService();
  return {
    defaultAgentId: "default",
    getAgentBrowserService: vi.fn().mockReturnValue(mockService),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// browser.act handler
// ---------------------------------------------------------------------------

describe("browser.act handler", () => {
  it("passes request parameter through to service.act()", async () => {
    const mockService = makeMockService();
    const deps = makeDeps({
      getAgentBrowserService: vi.fn().mockReturnValue(mockService),
    });
    const handlers = createBrowserHandlers(deps);

    const request = { action: "click", ref: "btn-1" };
    await handlers["browser.act"]({ request, _agentId: "agent-1" });

    expect(mockService.act).toHaveBeenCalledOnce();
    expect(mockService.act).toHaveBeenCalledWith(request);
  });

  it("throws when request parameter is missing", async () => {
    const deps = makeDeps();
    const handlers = createBrowserHandlers(deps);

    await expect(handlers["browser.act"]({ _agentId: "agent-1" }))
      .rejects.toThrow("request parameter is required");
  });

  it("resolves agentId from params or falls back to default", async () => {
    const mockService = makeMockService();
    const getService = vi.fn().mockReturnValue(mockService);
    const deps = makeDeps({ getAgentBrowserService: getService });
    const handlers = createBrowserHandlers(deps);

    // With explicit agentId
    await handlers["browser.act"]({ request: { action: "click", ref: "a" }, _agentId: "custom" });
    expect(getService).toHaveBeenCalledWith("custom");

    // Without agentId -- falls back to default
    getService.mockClear();
    await handlers["browser.act"]({ request: { action: "click", ref: "b" } });
    expect(getService).toHaveBeenCalledWith("default");
  });
});
