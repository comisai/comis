// SPDX-License-Identifier: Apache-2.0
/**
 * Playwright browser session management.
 *
 * Manages a persistent Playwright Browser connection to Chrome via
 * connectOverCDP(). Provides page resolution by targetId and
 * console/error tracking per page.
 *
 * Ported from Comis browser/pw-session.ts, simplified to single-
 * profile operation without extension relay or multi-profile caching.
 *
 * @module
 */

import type {
  Browser,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "playwright-core";
import { chromium } from "playwright-core";
import {
  MAX_CONSOLE_MESSAGES,
  MAX_PAGE_ERRORS,
} from "./constants.js";
import { suppressError } from "@comis/shared";

// ── Types ────────────────────────────────────────────────────────────

/** Console message captured from a browser page. */
export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

/** Error captured from a browser page. */
export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

/** Network request captured from a browser page. */
export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

/** State tracked per page. */
export type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  /** Role refs from the last snapshot (e.g., e1, e2). */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
};

type TargetInfoResponse = {
  targetInfo?: {
    targetId?: string;
  };
};

// ── Internal State ───────────────────────────────────────────────────

const pageStates = new WeakMap<Page, PageState>();
const observedPages = new WeakSet<Page>();
const MAX_NETWORK_REQUESTS = 500;

let connectedBrowser: { browser: Browser; cdpUrl: string } | null = null;
let connecting: Promise<{ browser: Browser; cdpUrl: string }> | null = null;

// ── Page Observation ─────────────────────────────────────────────────

/**
 * Ensure a PageState exists for a page, installing console/error/
 * network observers if not already present.
 */
export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);

    page.on("console", (msg: ConsoleMessage) => {
      state.console.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      });
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
    });

    page.on("pageerror", (err: Error) => {
      state.errors.push({
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
    });

    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
    });

    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) return;
      for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const rec = state.requests[i];
        if (rec && rec.id === id) {
          rec.status = resp.status();
          rec.ok = resp.ok();
          break;
        }
      }
    });

    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) return;
      for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const rec = state.requests[i];
        if (rec && rec.id === id) {
          rec.failureText = req.failure()?.errorText;
          rec.ok = false;
          break;
        }
      }
    });

    page.on("close", () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

/**
 * Get the PageState for a page, if it exists.
 */
export function getPageState(page: Page): PageState | undefined {
  return pageStates.get(page);
}

// ── Role Refs ────────────────────────────────────────────────────────

/**
 * Store role refs from the last snapshot on a page's state.
 */
export function storeRoleRefs(
  page: Page,
  refs: Record<string, { role: string; name?: string; nth?: number }>,
  mode: "role" | "aria",
  frameSelector?: string,
): void {
  const state = ensurePageState(page);
  state.roleRefs = refs;
  state.roleRefsMode = mode;
  state.roleRefsFrameSelector = frameSelector;
}

// ── Connection Management ────────────────────────────────────────────

function normalizeCdpUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

/**
 * Connect to Chrome via CDP. Reuses existing connection if still alive.
 */
async function connectBrowser(
  cdpUrl: string,
): Promise<{ browser: Browser; cdpUrl: string }> {
  const normalized = normalizeCdpUrl(cdpUrl);

  if (connectedBrowser?.cdpUrl === normalized) {
    return connectedBrowser;
  }
  if (connecting) {
    return await connecting;
  }

  const connectWithRetry = async (): Promise<{
    browser: Browser;
    cdpUrl: string;
  }> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        const browser = await chromium.connectOverCDP(normalized, { timeout });
        const connected = { browser, cdpUrl: normalized };
        connectedBrowser = connected;

        // Observe all contexts and pages
        for (const context of browser.contexts()) {
          for (const page of context.pages()) {
            ensurePageState(page);
          }
          context.on("page", (page) => ensurePageState(page));
        }

        browser.on("disconnected", () => {
          if (connectedBrowser?.browser === browser) {
            connectedBrowser = null;
          }
        });
        return connected;
      } catch (err) {
        lastErr = err;
        const delay = 250 + attempt * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(String(lastErr ?? "CDP connect failed"));
  };

  connecting = connectWithRetry().finally(() => {
    connecting = null;
  });

  return await connecting;
}

// ── Page Resolution ──────────────────────────────────────────────────

/**
 * Get all pages from all browser contexts.
 */
async function getAllPages(browser: Browser): Promise<Page[]> {
  return browser.contexts().flatMap((c) => c.pages());
}

/**
 * Get the CDP targetId for a page via CDPSession.
 */
async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send(
      "Target.getTargetInfo",
    )) as TargetInfoResponse;
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    return targetId || null;
  } finally {
    suppressError(session.detach(), "playwright CDP session detach");
  }
}

/**
 * Find a page by its CDP targetId.
 */
async function findPageByTargetId(
  browser: Browser,
  targetId: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid === targetId) return page;
  }
  return null;
}

// ── Public Session API ───────────────────────────────────────────────

/**
 * Create a Playwright session connected to Chrome's CDP endpoint.
 *
 * @param cdpUrl - CDP base URL (e.g., "http://127.0.0.1:9222")
 * @returns The connected Browser instance
 */
export async function createSession(
  cdpUrl: string,
): Promise<Browser> {
  const { browser } = await connectBrowser(cdpUrl);
  return browser;
}

/**
 * Get a Page by targetId. If no targetId is provided, returns the
 * first available page or creates one.
 */
export async function getPage(
  cdpUrl: string,
  targetId?: string,
): Promise<Page> {
  const { browser } = await connectBrowser(cdpUrl);
  const pages = await getAllPages(browser);

  if (!pages.length) {
    // No pages available -- create a new one
    const context =
      browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    ensurePageState(page);
    return page;
  }

  const first = pages[0]!;

  if (!targetId) return first;

  const found = await findPageByTargetId(browser, targetId);
  if (!found) {
    // If only one page, use it as fallback
    if (pages.length === 1) return first;
    throw new Error(`Tab not found: ${targetId}`);
  }
  return found;
}

/**
 * Get the default (first) page, creating one if needed.
 */
export async function getDefaultPage(
  cdpUrl: string,
): Promise<Page> {
  return getPage(cdpUrl);
}

/**
 * Get the targetId for a page.
 */
export async function getTargetId(page: Page): Promise<string | null> {
  return pageTargetId(page);
}

/**
 * Create a new page/tab and navigate to the given URL.
 */
export async function createNewPage(
  cdpUrl: string,
  url: string,
): Promise<{ page: Page; targetId: string | null }> {
  const { browser } = await connectBrowser(cdpUrl);
  const context =
    browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  ensurePageState(page);

  const targetUrl = url.trim() || "about:blank";
  if (targetUrl !== "about:blank") {
    try {
      await page.goto(targetUrl, { timeout: 30_000 });
    } catch {
      // Navigation might fail, but page is still created
    }
  }

  const tid = await pageTargetId(page).catch(() => null);
  return { page, targetId: tid };
}

/**
 * Close the Playwright browser connection.
 *
 * Does NOT terminate the Chrome process -- Chrome lifecycle is managed
 * separately by chrome-detection.ts.
 */
export async function closeSession(): Promise<void> {
  const cur = connectedBrowser;
  connectedBrowser = null;
  if (!cur) return;
  try {
    await cur.browser.close();
  } catch {
    // Browser close may fail if already disconnected
  }
}

/**
 * Check if the session is currently connected.
 */
export function isConnected(): boolean {
  return connectedBrowser !== null;
}

/**
 * Resolve a ref like "e12" to a Playwright Locator.
 *
 * Uses the role refs stored on the page's state to resolve by
 * role/name, or falls back to aria-ref attribute.
 */
export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}
