// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Browser,
  BrowserContext,
  Page,
  CDPSession,
} from "playwright-core";

// Mock playwright-core before importing the session module
vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

import { chromium } from "playwright-core";
import {
  createSession,
  getPage,
  getDefaultPage,
  getTargetId,
  createNewPage,
  closeSession,
  isConnected,
  ensurePageState,
} from "./playwright-session.js";

// ── Mock factories ──────────────────────────────────────────────────

function createMockCDPSession(targetId = "target-abc-123"): CDPSession {
  return {
    send: vi.fn().mockResolvedValue({
      targetInfo: { targetId },
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  } as unknown as CDPSession;
}

function createMockPage(
  url = "https://example.com",
  title = "Example",
  contextRef?: BrowserContext,
): Page {
  const cdpSession = createMockCDPSession();
  const page: Record<string, unknown> = {
    url: vi.fn().mockReturnValue(url),
    title: vi.fn().mockResolvedValue(title),
    goto: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    context: vi.fn(),
  };

  // context() needs to return a context with newCDPSession
  const ctx = contextRef ?? ({
    newCDPSession: vi.fn().mockResolvedValue(cdpSession),
  } as unknown as BrowserContext);
  (page.context as ReturnType<typeof vi.fn>).mockReturnValue(ctx);

  return page as unknown as Page;
}

function createMockContext(
  pages: Page[] = [],
  overrides?: Partial<BrowserContext>,
): BrowserContext {
  const cdpSession = createMockCDPSession();
  const newPageFn = vi.fn().mockImplementation(async () => {
    const p = createMockPage();
    // Wire the page's context to this context
    const ctx = { newCDPSession: vi.fn().mockResolvedValue(cdpSession) } as unknown as BrowserContext;
    (p.context as ReturnType<typeof vi.fn>).mockReturnValue(ctx);
    return p;
  });

  return {
    pages: vi.fn().mockReturnValue(pages),
    on: vi.fn(),
    newPage: newPageFn,
    newCDPSession: vi.fn().mockResolvedValue(cdpSession),
    ...overrides,
  } as unknown as BrowserContext;
}

function createMockBrowser(
  contexts: BrowserContext[] = [],
  overrides?: Partial<Browser>,
): Browser {
  return {
    contexts: vi.fn().mockReturnValue(contexts),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn().mockImplementation(async () => createMockContext()),
    ...overrides,
  } as unknown as Browser;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("playwright-session lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Use fake timers but with real nextTick/setImmediate for async resolution
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Always clean up session state between tests
    await closeSession();
  });

  // ── createSession ─────────────────────────────────────────────────

  describe("createSession", () => {
    it("should call chromium.connectOverCDP with normalized cdpUrl", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await createSession("http://127.0.0.1:9222/");

      expect(chromium.connectOverCDP).toHaveBeenCalledWith(
        "http://127.0.0.1:9222",
        expect.objectContaining({ timeout: 5000 }),
      );
      expect(result).toBe(browser);
    });

    it("should return the Browser instance", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await createSession("http://127.0.0.1:9222");

      expect(result).toBe(browser);
      expect(isConnected()).toBe(true);
    });

    it("should reuse existing connection for same URL", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result1 = await createSession("http://127.0.0.1:9222");
      const result2 = await createSession("http://127.0.0.1:9222");

      expect(result1).toBe(result2);
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    });

    it("should strip trailing slash when comparing URLs", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createSession("http://127.0.0.1:9222/");
      await createSession("http://127.0.0.1:9222");

      // Only one connection (trailing slash normalized)
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    });
  });

  // ── connectBrowser retry logic ────────────────────────────────────

  describe("connectBrowser retry logic", () => {
    it("should succeed on first attempt", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createSession("http://127.0.0.1:9222");

      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure and succeed on second attempt", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(browser);

      const result = await createSession("http://127.0.0.1:9222");

      expect(result).toBe(browser);
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(2);
    });

    it("should throw last error after 3 failed attempts", async () => {
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("Attempt 1 failed"))
        .mockRejectedValueOnce(new Error("Attempt 2 failed"))
        .mockRejectedValueOnce(new Error("Attempt 3 failed"));

      await expect(createSession("http://127.0.0.1:9222")).rejects.toThrow(
        "Attempt 3 failed",
      );
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(3);
    });

    it("should use increasing timeout per attempt: 5000, 7000, 9000", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValueOnce(browser);

      await createSession("http://127.0.0.1:9222");

      const calls = (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![1]).toEqual(expect.objectContaining({ timeout: 5000 }));
      expect(calls[1]![1]).toEqual(expect.objectContaining({ timeout: 7000 }));
      expect(calls[2]![1]).toEqual(expect.objectContaining({ timeout: 9000 }));
    });

    it("should coalesce concurrent connection attempts", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      // Start two connections simultaneously
      const [result1, result2] = await Promise.all([
        createSession("http://127.0.0.1:9222"),
        createSession("http://127.0.0.1:9222"),
      ]);

      expect(result1).toBe(result2);
      // Only one connectOverCDP call (coalesced)
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    });
  });

  // ── getPage (no targetId) ─────────────────────────────────────────

  describe("getPage (no targetId)", () => {
    it("should return first page when pages exist", async () => {
      const page1 = createMockPage("https://example.com", "Page 1");
      const page2 = createMockPage("https://other.com", "Page 2");
      const ctx = createMockContext([page1, page2]);
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await getPage("http://127.0.0.1:9222");

      expect(result).toBe(page1);
    });

    it("should create new page when no pages exist", async () => {
      const newPage = createMockPage();
      const ctx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(createMockCDPSession()),
      });
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await getPage("http://127.0.0.1:9222");

      expect(ctx.newPage).toHaveBeenCalled();
      expect(result).toBe(newPage);
    });

    it("should create new context when no contexts exist and no pages", async () => {
      const newPage = createMockPage();
      const newCtx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(createMockCDPSession()),
      });
      const browser = createMockBrowser([], {
        contexts: vi.fn().mockReturnValue([]),
        newContext: vi.fn().mockResolvedValue(newCtx),
      });
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await getPage("http://127.0.0.1:9222");

      expect(browser.newContext).toHaveBeenCalled();
      expect(result).toBe(newPage);
    });
  });

  // ── getPage (with targetId) ───────────────────────────────────────

  describe("getPage (with targetId)", () => {
    it("should find page by targetId via CDPSession", async () => {
      const cdpSession = createMockCDPSession("target-123");
      const targetPage = createMockPage("https://target.com", "Target");
      (targetPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const otherCdp = createMockCDPSession("target-other");
      const otherPage = createMockPage("https://other.com", "Other");
      (otherPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(otherCdp),
      });
      const ctx = createMockContext([otherPage, targetPage]);
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await getPage("http://127.0.0.1:9222", "target-123");

      expect(result).toBe(targetPage);
    });

    it("should return first page as fallback when targetId not found and only 1 page", async () => {
      const cdpSession = createMockCDPSession("other-id");
      const onlyPage = createMockPage("https://only.com", "Only");
      (onlyPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const ctx = createMockContext([onlyPage]);
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await getPage("http://127.0.0.1:9222", "nonexistent");

      // Fallback to first page since only 1 exists
      expect(result).toBe(onlyPage);
    });

    it("should throw 'Tab not found' when targetId not found and multiple pages", async () => {
      const cdp1 = createMockCDPSession("id-1");
      const cdp2 = createMockCDPSession("id-2");
      const page1 = createMockPage("https://a.com");
      const page2 = createMockPage("https://b.com");
      (page1.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdp1),
      });
      (page2.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdp2),
      });
      const ctx = createMockContext([page1, page2]);
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await expect(
        getPage("http://127.0.0.1:9222", "nonexistent"),
      ).rejects.toThrow("Tab not found");
    });
  });

  // ── getDefaultPage ────────────────────────────────────────────────

  describe("getDefaultPage", () => {
    it("should delegate to getPage without targetId", async () => {
      const page1 = createMockPage();
      const ctx = createMockContext([page1]);
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await getDefaultPage("http://127.0.0.1:9222");

      expect(result).toBe(page1);
    });
  });

  // ── getTargetId ───────────────────────────────────────────────────

  describe("getTargetId", () => {
    it("should return targetId string from CDPSession", async () => {
      const cdpSession = createMockCDPSession("target-xyz-789");
      const page = createMockPage();
      (page.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });

      const tid = await getTargetId(page);

      expect(tid).toBe("target-xyz-789");
      expect(cdpSession.detach).toHaveBeenCalled();
    });

    it("should throw when newCDPSession fails (no catch wrapper)", async () => {
      const page = createMockPage();
      (page.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockRejectedValue(new Error("CDP error")),
      });

      await expect(getTargetId(page)).rejects.toThrow("CDP error");
    });

    it("should return null when targetInfo is empty", async () => {
      const cdpSession = {
        send: vi.fn().mockResolvedValue({ targetInfo: {} }),
        detach: vi.fn().mockResolvedValue(undefined),
      } as unknown as CDPSession;
      const page = createMockPage();
      (page.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });

      const tid = await getTargetId(page);

      expect(tid).toBeNull();
    });
  });

  // ── createNewPage ─────────────────────────────────────────────────

  describe("createNewPage", () => {
    it("should create new page in first context", async () => {
      const newPage = createMockPage();
      const cdpSession = createMockCDPSession("new-target");
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const ctx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await createNewPage("http://127.0.0.1:9222", "https://google.com");

      expect(ctx.newPage).toHaveBeenCalled();
      expect(result.page).toBe(newPage);
    });

    it("should call page.goto with provided URL (trimmed)", async () => {
      const newPage = createMockPage();
      const cdpSession = createMockCDPSession("new-target");
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const ctx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createNewPage("http://127.0.0.1:9222", "  https://google.com  ");

      expect(newPage.goto).toHaveBeenCalledWith("https://google.com", {
        timeout: 30_000,
      });
    });

    it("should return page and targetId", async () => {
      const newPage = createMockPage();
      const cdpSession = createMockCDPSession("target-new-456");
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const ctx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await createNewPage("http://127.0.0.1:9222", "https://example.com");

      expect(result.page).toBe(newPage);
      expect(result.targetId).toBe("target-new-456");
    });

    it("should skip goto for empty URL (about:blank)", async () => {
      const newPage = createMockPage();
      const cdpSession = createMockCDPSession("blank-target");
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const ctx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createNewPage("http://127.0.0.1:9222", "");

      expect(newPage.goto).not.toHaveBeenCalled();
    });

    it("should not throw when goto fails", async () => {
      const newPage = createMockPage();
      (newPage.goto as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Navigation failed"),
      );
      const cdpSession = createMockCDPSession("fail-target");
      (newPage.context as ReturnType<typeof vi.fn>).mockReturnValue({
        newCDPSession: vi.fn().mockResolvedValue(cdpSession),
      });
      const ctx = createMockContext([], {
        newPage: vi.fn().mockResolvedValue(newPage),
      });
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      const result = await createNewPage("http://127.0.0.1:9222", "https://invalid.url");

      // Should not throw, page is still returned
      expect(result.page).toBe(newPage);
    });
  });

  // ── closeSession ──────────────────────────────────────────────────

  describe("closeSession", () => {
    it("should call browser.close()", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);
      await createSession("http://127.0.0.1:9222");

      await closeSession();

      expect(browser.close).toHaveBeenCalled();
    });

    it("should clear connected state after close", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);
      await createSession("http://127.0.0.1:9222");

      expect(isConnected()).toBe(true);
      await closeSession();
      expect(isConnected()).toBe(false);
    });

    it("should be no-op when not connected", async () => {
      // Should not throw
      await closeSession();
      expect(isConnected()).toBe(false);
    });

    it("should silently catch browser.close() failure", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx], {
        close: vi.fn().mockRejectedValue(new Error("Already closed")),
      });
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);
      await createSession("http://127.0.0.1:9222");

      // Should not throw
      await closeSession();
      expect(isConnected()).toBe(false);
    });
  });

  // ── Connection lifecycle ──────────────────────────────────────────

  describe("connection lifecycle", () => {
    it("should reconnect after closeSession", async () => {
      const ctx1 = createMockContext();
      const browser1 = createMockBrowser([ctx1]);
      const ctx2 = createMockContext();
      const browser2 = createMockBrowser([ctx2]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(browser1)
        .mockResolvedValueOnce(browser2);

      const result1 = await createSession("http://127.0.0.1:9222");
      expect(result1).toBe(browser1);
      expect(isConnected()).toBe(true);

      await closeSession();
      expect(isConnected()).toBe(false);

      const result2 = await createSession("http://127.0.0.1:9222");
      expect(result2).toBe(browser2);
      expect(chromium.connectOverCDP).toHaveBeenCalledTimes(2);
    });

    it("should clear connected state on browser 'disconnected' event", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createSession("http://127.0.0.1:9222");
      expect(isConnected()).toBe(true);

      // Find the "disconnected" handler and trigger it
      const onCalls = (browser.on as ReturnType<typeof vi.fn>).mock.calls;
      const disconnectedCall = onCalls.find(
        (c: unknown[]) => c[0] === "disconnected",
      );
      expect(disconnectedCall).toBeDefined();

      // Trigger the disconnected callback
      const disconnectedHandler = disconnectedCall![1] as () => void;
      disconnectedHandler();

      expect(isConnected()).toBe(false);
    });

    it("should observe existing pages on connect", async () => {
      const existingPage = createMockPage();
      const ctx = createMockContext([existingPage]);
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createSession("http://127.0.0.1:9222");

      // ensurePageState should have been called on the existing page
      // (page.on should have been called to install handlers)
      expect(existingPage.on).toHaveBeenCalled();
    });

    it("should install page handler on context for new pages", async () => {
      const ctx = createMockContext();
      const browser = createMockBrowser([ctx]);
      (chromium.connectOverCDP as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

      await createSession("http://127.0.0.1:9222");

      // context.on("page", ...) should have been installed
      expect(ctx.on).toHaveBeenCalledWith("page", expect.any(Function));
    });
  });
});
