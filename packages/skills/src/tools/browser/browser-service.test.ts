// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for BrowserService, focused on the navigate() method's
 * defense-in-depth URL protocol validation.
 *
 * Playwright and Chrome dependencies are fully mocked since these tests
 * validate input validation logic, not browser interaction.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockValidateUrl = vi.hoisted(() => vi.fn());
const mockValidateLocalServerUrl = vi.hoisted(() => vi.fn());
const mockCreateNewPage = vi.hoisted(() => vi.fn());
const mockLaunchChrome = vi.hoisted(() => vi.fn());
const mockStopChrome = vi.hoisted(() => vi.fn());
const mockCreateSession = vi.hoisted(() => vi.fn());
const mockCloseSession = vi.hoisted(() => vi.fn());

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    validateUrl: mockValidateUrl,
    validateLocalServerUrl: mockValidateLocalServerUrl,
  };
});

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
  launchChrome: mockLaunchChrome,
  stopChrome: mockStopChrome,
}));

const mockGoto = vi.fn();
const mockPageUrl = vi.fn(() => "https://example.com");
const mockPageTitle = vi.fn(() => Promise.resolve("Example"));
const mockGetTargetId = vi.fn(() => Promise.resolve("target-1"));
const mockContextRoute = vi.fn();
const mockContextRouteWebSocket = vi.fn();
const mockContextAddInitScript = vi.fn();
const mockPageEvaluate = vi.fn();
const mockCdpOn = vi.fn();
const mockCdpSend = vi.fn();
const mockNewCdpSession = vi.fn(async () => ({
  on: mockCdpOn,
  send: mockCdpSend,
}));
const mockContext = {
  route: mockContextRoute,
  routeWebSocket: mockContextRouteWebSocket,
  addInitScript: mockContextAddInitScript,
  newCDPSession: mockNewCdpSession,
};

const mockPage = {
  goto: mockGoto,
  url: mockPageUrl,
  title: mockPageTitle,
  evaluate: mockPageEvaluate,
  context: vi.fn(() => mockContext),
};

vi.mock("./cdp.js", () => ({
  getCdpTargets: vi.fn(),
  getCdpVersion: vi.fn(),
  filterPageTargets: vi.fn(() => []),
}));

vi.mock("./playwright-session.js", () => ({
  createSession: mockCreateSession,
  closeSession: mockCloseSession,
  getPage: vi.fn(() => Promise.resolve(mockPage)),
  createNewPage: mockCreateNewPage,
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

describe("BrowserService.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContextRoute.mockResolvedValue(undefined);
    mockContextRouteWebSocket.mockResolvedValue(undefined);
    mockContextAddInitScript.mockResolvedValue(undefined);
    mockPageEvaluate.mockResolvedValue(undefined);
    mockCdpSend.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue(undefined);
    mockCloseSession.mockResolvedValue(undefined);
    mockStopChrome.mockResolvedValue(undefined);
  });

  it("cleans up a launched browser and permits retry when session startup fails", async () => {
    const chrome = { pid: 1234 };
    mockLaunchChrome.mockResolvedValue(chrome);
    mockCreateSession.mockRejectedValueOnce(new Error("CDP session failed"));
    const service = createBrowserService();

    await expect(service.start()).rejects.toThrow("CDP session failed");

    expect(mockCloseSession).toHaveBeenCalledOnce();
    expect(mockStopChrome).toHaveBeenCalledWith(chrome);
    await expect(service.start()).resolves.toBeUndefined();
    expect(mockLaunchChrome).toHaveBeenCalledTimes(2);
  });

  it("cleans up a launched browser when request-guard installation fails", async () => {
    const chrome = { pid: 1234 };
    mockLaunchChrome.mockResolvedValue(chrome);
    mockContextRoute.mockRejectedValueOnce(new Error("request guard failed"));
    const service = createBrowserService();

    await expect(service.start()).rejects.toThrow("request guard failed");

    expect(mockCloseSession).toHaveBeenCalledOnce();
    expect(mockStopChrome).toHaveBeenCalledWith(chrome);
  });
});

describe("BrowserService.navigate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoto.mockResolvedValue(undefined);
    mockContextRoute.mockResolvedValue(undefined);
    mockContextRouteWebSocket.mockResolvedValue(undefined);
    mockCdpSend.mockResolvedValue(undefined);
    mockCreateNewPage.mockResolvedValue({ page: mockPage, targetId: "target-1" });
    mockValidateUrl.mockImplementation(async (raw: string) => ({
      ok: true,
      value: {
        hostname: new URL(raw).hostname,
        ip: "93.184.216.34",
        url: new URL(raw),
      },
    }));
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

  it("rejects data URL navigation schemes", async () => {
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

  it("rejects navigation when the URL is empty", async () => {
    const service = createBrowserService();
    await expect(service.navigate({ url: "" })).rejects.toThrow("url is required");
    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("rejects a private destination at the service boundary before page navigation", async () => {
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });
    const service = createBrowserService();

    await expect(
      service.navigate({ url: "http://localhost/admin" }),
    ).rejects.toThrow(/SSRF blocked/);

    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("rejects a loopback destination by default without consulting the local-server guard", async () => {
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });
    const service = createBrowserService();

    await expect(
      service.navigate({ url: "http://127.0.0.1:8080/hello" }),
    ).rejects.toThrow(/SSRF blocked/);

    expect(mockValidateLocalServerUrl).not.toHaveBeenCalled();
    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("allows a loopback destination when allowLoopbackNavigation is enabled", async () => {
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });
    mockValidateLocalServerUrl.mockResolvedValueOnce({
      ok: true,
      value: {
        hostname: "127.0.0.1",
        ip: "127.0.0.1",
        url: new URL("http://127.0.0.1:8080/hello"),
      },
    });
    const service = createBrowserService({ allowLoopbackNavigation: true });

    await service.navigate({ url: "http://127.0.0.1:8080/hello" });

    expect(mockValidateLocalServerUrl).toHaveBeenCalledWith("http://127.0.0.1:8080/hello");
    expect(mockGoto).toHaveBeenCalledOnce();
  });

  it("keeps non-loopback private destinations blocked even with allowLoopbackNavigation enabled", async () => {
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 10.0.0.5 is in private range"),
    });
    mockValidateLocalServerUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 10.0.0.5 is not loopback"),
    });
    const service = createBrowserService({ allowLoopbackNavigation: true });

    await expect(
      service.navigate({ url: "http://10.0.0.5/router" }),
    ).rejects.toThrow(/SSRF blocked: Blocked: resolved IP 10.0.0.5 is in private range/);

    expect(mockGoto).not.toHaveBeenCalled();
  });

  it("installs the context request guard before starting page navigation", async () => {
    const order: string[] = [];
    mockContextRoute.mockImplementationOnce(async () => {
      order.push("guard");
    });
    mockGoto.mockImplementationOnce(async () => {
      order.push("navigate");
    });
    const service = createBrowserService();

    await service.navigate({ url: "https://example.com" });

    expect(mockContextRoute).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(mockContextAddInitScript).toHaveBeenCalledWith({
      content: expect.stringContaining("RTCPeerConnection"),
    });
    expect(mockPageEvaluate).toHaveBeenCalledWith(
      expect.stringContaining("WebTransport"),
    );
    expect(mockCdpSend).toHaveBeenCalledWith("Network.setBypassServiceWorker", {
      bypass: true,
    });
    expect(order).toEqual(["guard", "navigate"]);
  });

  it("validates and continues a public HTTP subresource request", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "https://example.com" });
    const handler = mockContextRoute.mock.calls[0]?.[1] as
      | ((route: ReturnType<typeof makeRoute>["route"]) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");
    mockValidateUrl.mockClear();
    const { route, continueRequest, abortRequest } = makeRoute(
      "https://cdn.example.com/app.js",
    );

    await handler!(route);

    expect(mockValidateUrl).toHaveBeenCalledWith("https://cdn.example.com/app.js");
    expect(continueRequest).toHaveBeenCalledWith({ url: "https://cdn.example.com/app.js" });
    expect(abortRequest).not.toHaveBeenCalled();
  });

  it("aborts a private HTTP request observed by the context guard", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "https://example.com" });
    const handler = mockContextRoute.mock.calls[0]?.[1] as
      | ((route: ReturnType<typeof makeRoute>["route"]) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 169.254.169.254 is a cloud metadata service address"),
    });
    const { route, continueRequest, abortRequest } = makeRoute(
      "http://169.254.169.254/latest/meta-data",
      true,
    );

    await handler!(route);

    expect(abortRequest).toHaveBeenCalledWith("blockedbyclient");
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it("fails a private redirect hop intercepted by the page CDP guard", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "https://example.com" });
    const handler = mockCdpOn.mock.calls.find(
      ([eventName]) => eventName === "Fetch.requestPaused",
    )?.[1] as ((event: unknown) => void) | undefined;
    expect(handler).toBeTypeOf("function");
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: destination is private"),
    });

    handler!({
      requestId: "redirect-hop-1",
      request: { url: "http://169.254.169.254/latest/meta-data" },
    });

    await vi.waitFor(() => {
      expect(mockCdpSend).toHaveBeenCalledWith("Fetch.failRequest", {
        requestId: "redirect-hop-1",
        errorReason: "BlockedByClient",
      });
    });
    expect(mockCdpSend).not.toHaveBeenCalledWith(
      "Fetch.continueRequest",
      expect.objectContaining({ requestId: "redirect-hop-1" }),
    );
  });

  it("aborts local-file requests triggered by page interactions", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "https://example.com" });
    const handler = mockContextRoute.mock.calls[0]?.[1] as
      | ((route: ReturnType<typeof makeRoute>["route"]) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");
    mockValidateUrl.mockClear();
    const { route, continueRequest, abortRequest } = makeRoute("file:///etc/passwd");

    await handler!(route);

    expect(abortRequest).toHaveBeenCalledWith("blockedbyclient");
    expect(continueRequest).not.toHaveBeenCalled();
    expect(mockValidateUrl).not.toHaveBeenCalled();
  });

  it("closes a private WebSocket destination before connecting", async () => {
    const service = createBrowserService();
    await service.navigate({ url: "https://example.com" });
    const handler = mockContextRouteWebSocket.mock.calls[0]?.[1] as
      | ((socket: ReturnType<typeof makeWebSocketRoute>) => Promise<void>)
      | undefined;
    expect(handler).toBeTypeOf("function");
    mockValidateUrl.mockResolvedValueOnce({
      ok: false,
      error: new Error("Blocked: resolved IP 127.0.0.1 is in loopback range"),
    });
    const socket = makeWebSocketRoute("ws://localhost:8080/control");

    await handler!(socket);

    expect(mockValidateUrl).toHaveBeenCalledWith("http://localhost:8080/control");
    expect(socket.close).toHaveBeenCalledWith({
      code: 1008,
      reason: "Blocked by browser network policy",
    });
    expect(socket.connectToServer).not.toHaveBeenCalled();
  });
});

describe("BrowserService.openTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoto.mockResolvedValue(undefined);
    mockContextRoute.mockResolvedValue(undefined);
    mockContextRouteWebSocket.mockResolvedValue(undefined);
    mockCdpSend.mockResolvedValue(undefined);
    mockCreateNewPage.mockResolvedValue({ page: mockPage, targetId: "target-1" });
    mockValidateUrl.mockImplementation(async (raw: string) => ({
      ok: true,
      value: {
        hostname: new URL(raw).hostname,
        ip: "93.184.216.34",
        url: new URL(raw),
      },
    }));
  });

  it("creates a blank guarded tab before navigating to the requested URL", async () => {
    const order: string[] = [];
    mockCreateNewPage.mockImplementationOnce(async () => {
      order.push("create");
      return { page: mockPage, targetId: "target-1" };
    });
    mockContextRoute.mockImplementationOnce(async () => {
      order.push("guard");
    });
    mockGoto.mockImplementationOnce(async () => {
      order.push("navigate");
    });
    const service = createBrowserService();

    await service.openTab({ url: "https://example.com/new" });

    expect(mockCreateNewPage).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      "about:blank",
    );
    expect(order).toEqual(["create", "guard", "navigate"]);
  });
});

function makeRoute(url: string, redirected = false) {
  const continueRequest = vi.fn().mockResolvedValue(undefined);
  const abortRequest = vi.fn().mockResolvedValue(undefined);
  const route = {
    request: () => ({
      url: () => url,
      redirectedFrom: () => (redirected ? {} : null),
      frame: () => ({ page: () => mockPage }),
    }),
    continue: continueRequest,
    abort: abortRequest,
  };
  return { route, continueRequest, abortRequest };
}

function makeWebSocketRoute(url: string) {
  return {
    url: () => url,
    close: vi.fn().mockResolvedValue(undefined),
    connectToServer: vi.fn(),
  };
}
