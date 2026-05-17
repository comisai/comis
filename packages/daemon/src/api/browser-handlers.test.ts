// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createBrowserHandlers } from "./browser-handlers.js";
import type { BrowserHandlerDeps } from "./browser-handlers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockService() {
  // Browser response schemas require specific shapes; build full mocks
  return {
    status: vi.fn().mockResolvedValue({ running: true, cdpPort: 9222, activeTabs: 0, connected: false }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue({ url: "https://example.com", title: "Example", targetId: "t-1" }),
    snapshot: vi.fn().mockResolvedValue({ content: "<html/>" }),
    screenshot: vi.fn().mockResolvedValue({ buffer: Buffer.from("png"), mimeType: "image/png" }),
    pdf: vi.fn().mockResolvedValue({ buffer: Buffer.from("pdf"), mimeType: "application/pdf" }),
    act: vi.fn().mockResolvedValue({ success: true }),
    tabs: vi.fn().mockResolvedValue([{ targetId: "t-1", title: "Tab", url: "https://t.com", type: "page" }]),
    openTab: vi.fn().mockResolvedValue({ targetId: "tab-1", title: "New", url: "about:blank", type: "page" }),
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

// ---------------------------------------------------------------------------
// browser.status / start / stop / tabs (read-only or no-arg handlers)
// ---------------------------------------------------------------------------

describe("browser lifecycle handlers", () => {
  it("returns browser running status from service.status() when status is invoked", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.status"]!({ _agentId: "agent-1" });
    expect(result).toMatchObject({ running: true });
    expect(mockService.status).toHaveBeenCalledOnce();
  });

  it("returns started:true and invokes service.start() exactly once when start is invoked", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.start"]!({ _agentId: "agent-1" });
    expect(result).toEqual({ started: true });
    expect(mockService.start).toHaveBeenCalledOnce();
  });

  it("returns stopped:true and invokes service.stop() exactly once when stop is invoked", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.stop"]!({ _agentId: "agent-1" });
    expect(result).toEqual({ stopped: true });
    expect(mockService.stop).toHaveBeenCalledOnce();
  });

  it("returns tabs array wrapped under tabs key from service.tabs() output", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.tabs"]!({ _agentId: "agent-1" });
    expect(result).toHaveProperty("tabs");
    expect(Array.isArray(result.tabs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// browser.navigate / snapshot / screenshot / pdf / console (param-passing)
// ---------------------------------------------------------------------------

describe("browser data handlers", () => {
  it("passes targetUrl through to service.navigate() with url and targetId parameters", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    await handlers["browser.navigate"]!({
      targetUrl: "https://example.com/page",
      targetId: "tab-x",
      _agentId: "agent-1",
    });
    expect(mockService.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/page", targetId: "tab-x" }),
    );
  });

  it("rejects browser.navigate when targetUrl is missing per zod min-length validation", async () => {
    const handlers = createBrowserHandlers(makeDeps());
    await expect(
      handlers["browser.navigate"]!({ _agentId: "agent-1" }),
    ).rejects.toThrow();
  });

  it("rejects browser.navigate when targetUrl is an empty string per zod min-length validation", async () => {
    const handlers = createBrowserHandlers(makeDeps());
    await expect(
      handlers["browser.navigate"]!({ targetUrl: "", _agentId: "agent-1" }),
    ).rejects.toThrow();
  });

  it("passes snapshot parameters through to service.snapshot() with renamed maxDepth field", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    await handlers["browser.snapshot"]!({
      targetId: "t-1",
      interactive: true,
      depth: 3,
      compact: false,
      selector: "main",
      maxChars: 2000,
      _agentId: "agent-1",
    });
    expect(mockService.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "t-1", interactive: true, maxDepth: 3, selector: "main", maxChars: 2000 }),
    );
  });

  it("converts screenshot buffer to base64 in screenshot handler response payload", async () => {
    const mockService = makeMockService();
    mockService.screenshot.mockResolvedValue({ buffer: Buffer.from("hello"), mimeType: "image/png" });
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.screenshot"]!({ _agentId: "agent-1" });
    expect(result.base64).toBe(Buffer.from("hello").toString("base64"));
    expect(result.mimeType).toBe("image/png");
  });

  it("converts pdf buffer to base64 in pdf handler response payload", async () => {
    const mockService = makeMockService();
    mockService.pdf.mockResolvedValue({ buffer: Buffer.from("pdfdata"), mimeType: "application/pdf" });
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.pdf"]!({ _agentId: "agent-1" });
    expect(result.base64).toBe(Buffer.from("pdfdata").toString("base64"));
    expect(result.mimeType).toBe("application/pdf");
  });

  it("returns console messages wrapped under messages key from service.console()", async () => {
    const mockService = makeMockService();
    mockService.console.mockResolvedValue([{ level: "error", text: "boom" }]);
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.console"]!({ level: "error", _agentId: "agent-1" });
    expect(result).toHaveProperty("messages");
    expect(result.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// browser.open / focus / close (tab management)
// ---------------------------------------------------------------------------

describe("browser tab handlers", () => {
  it("defaults open targetUrl to about:blank when omitted from parameters", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    await handlers["browser.open"]!({ _agentId: "agent-1" });
    expect(mockService.openTab).toHaveBeenCalledWith({ url: "about:blank" });
  });

  it("passes explicit targetUrl through to service.openTab when provided", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    await handlers["browser.open"]!({ targetUrl: "https://newtab", _agentId: "agent-1" });
    expect(mockService.openTab).toHaveBeenCalledWith({ url: "https://newtab" });
  });

  it("rejects browser.focus when targetId is absent from params per bespoke pre-zod guard", async () => {
    const handlers = createBrowserHandlers(makeDeps());
    await expect(
      handlers["browser.focus"]!({ _agentId: "agent-1" }),
    ).rejects.toThrow(/targetId is required/i);
  });

  it("returns focused:true and targetId when browser.focus succeeds with valid targetId", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.focus"]!({ targetId: "tab-z", _agentId: "agent-1" });
    expect(result).toEqual({ focused: true, targetId: "tab-z" });
    expect(mockService.focusTab).toHaveBeenCalledWith({ targetId: "tab-z" });
  });

  it("returns closed:true and invokes service.closeTab with targetId on browser.close", async () => {
    const mockService = makeMockService();
    const handlers = createBrowserHandlers(
      makeDeps({ getAgentBrowserService: vi.fn().mockReturnValue(mockService) }),
    );
    const result = await handlers["browser.close"]!({ targetId: "tab-y", _agentId: "agent-1" });
    expect(result).toEqual({ closed: true });
    expect(mockService.closeTab).toHaveBeenCalledWith({ targetId: "tab-y" });
  });
});
